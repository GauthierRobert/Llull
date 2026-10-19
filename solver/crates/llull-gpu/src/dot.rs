//! GPU dot product in a fixed order: workgroup `g` owns the contiguous slice `[g·CHUNK, (g+1)·CHUNK)`; thread `t` adds its
//! strided elements `t, t+256, …` left to right; the 256 thread sums are combined by a fixed binary tree in workgroup memory;
//! the host adds the workgroup partials left to right in f64. No atomics, so the bits are reproducible on one device and
//! driver (RS1 §2 rule 3). The CPU twin is [`crate::reduce::dot`] (same chunking, f64 throughout).

use crate::buffers::{dispatch_dims, u32_bytes, uniform, zeroed_f32};
use crate::device::Gpu;
use crate::reduce::CHUNK;

const THREADS: usize = 256;

const SHADER: &str = r"
struct Params { n: u32, groups: u32, groups_x: u32, pad: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> partial: array<f32>;
var<workgroup> scratch: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let group = wid.y * params.groups_x + wid.x;
  let base = group * 4096u;
  var acc = 0.0;
  for (var j = 0u; j < 16u; j = j + 1u) {
    let i = base + j * 256u + lid;
    if (group < params.groups && i < params.n) {
      acc = acc + a[i] * b[i];
    }
  }
  scratch[lid] = acc;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      scratch[lid] = scratch[lid] + scratch[lid + s];
    }
    workgroupBarrier();
  }
  if (lid == 0u && group < params.groups) {
    partial[group] = scratch[0];
  }
}
";

/// A fixed-order dot for vectors of one length `n` (partials and staging buffers allocated once).
pub struct FixedOrderDot {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    params: wgpu::Buffer,
    partials: wgpu::Buffer,
    staging: wgpu::Buffer,
    groups: u32,
}

fn entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty, count: None }
}

/// A storage binding (`read_only` or read-write) for explicit bind group layouts.
pub fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    entry(
        binding,
        wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only }, has_dynamic_offset: false, min_binding_size: None },
    )
}

/// A uniform binding for explicit bind group layouts.
pub fn uniform_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    entry(binding, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None })
}

/// A compute pipeline for `entry_point` of `source` with an explicit bind group layout.
pub fn compute_pipeline(gpu: &Gpu, source: &str, entry_point: &str, layout: &wgpu::BindGroupLayout) -> wgpu::ComputePipeline {
    let module = gpu
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(entry_point), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline_layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(entry_point),
        bind_group_layouts: &[layout],
        push_constant_ranges: &[],
    });
    gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(entry_point),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry_point),
        compilation_options: wgpu::PipelineCompilationOptions::default(),
        cache: None,
    })
}

impl FixedOrderDot {
    /// Prepares the dot of two `n`-long f32 storage buffers.
    pub fn new(gpu: &Gpu, n: usize) -> FixedOrderDot {
        let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("llull-gpu dot"),
            entries: &[uniform_entry(0), storage_entry(1, true), storage_entry(2, true), storage_entry(3, false)],
        });
        let pipeline = compute_pipeline(gpu, SHADER, "main", &layout);
        let groups = n.div_ceil(CHUNK).max(1) as u32;
        let (groups_x, _) = dispatch_dims(groups);
        let params = uniform(gpu, "llull-gpu dot params", &u32_bytes(&[n as u32, groups, groups_x, 0]));
        let partials = zeroed_f32(gpu, "llull-gpu dot partials", groups as usize);
        let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("llull-gpu dot staging"),
            size: u64::from(groups) * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        debug_assert_eq!(THREADS * 16, CHUNK);
        FixedOrderDot { pipeline, layout, params, partials, staging, groups }
    }

    /// Records the partial sums of `a · b` and their copy to the staging buffer; call [`FixedOrderDot::resolve`] after submit.
    pub fn encode(&self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, a: &wgpu::Buffer, b: &wgpu::Buffer) {
        let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("llull-gpu dot"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: a.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: b.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.partials.as_entire_binding() },
            ],
        });
        {
            let mut pass =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("llull-gpu dot"), timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            let (x, y) = dispatch_dims(self.groups);
            pass.dispatch_workgroups(x, y, 1);
        }
        encoder.copy_buffer_to_buffer(&self.partials, 0, &self.staging, 0, u64::from(self.groups) * 4);
    }

    /// Waits for the submitted work and adds the workgroup partials left to right in f64.
    pub fn resolve(&self, gpu: &Gpu) -> Result<f64, String> {
        let slice = self.staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        gpu.device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
        let data = slice.get_mapped_range();
        let total = data.chunks_exact(4).fold(0.0, |acc, c| acc + f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
        drop(data);
        self.staging.unmap();
        Ok(total)
    }

    /// `a · b` in one submit.
    pub fn dot(&self, gpu: &Gpu, a: &wgpu::Buffer, b: &wgpu::Buffer) -> Result<f64, String> {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        self.encode(gpu, &mut encoder, a, b);
        gpu.queue.submit([encoder.finish()]);
        self.resolve(gpu)
    }
}
