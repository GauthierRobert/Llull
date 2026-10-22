//! wgpu backend (feature `gpu`): `lbm.wgsl` runs the same per-cell step as [`crate::kernel::step_cell`] in f32, one dispatch
//! per lattice step on two ping-pong population buffers (SoA). Dispatches are submitted in batches sized to stay around
//! 50 ms of GPU time (TECHNICAL_SPEC §5.6: the OS watchdog never fires, the desktop stays responsive). Per-cell forces are read
//! back and reduced on the host in the fixed order of `llull-flow-core`, so a run is reproducible on one device and driver.
//! Buffers above the adapter's binding limit are refused before allocation (`CFD_MEMORY_EXCEEDED`, VC-CFD-50).

use crate::domain::Domain;
use crate::kernel::{equilibrium_set, Params};
use crate::lattice::Q;
use crate::solver::{Averages, Backend, BackendInfo};
use llull_gpu::buffers::{dispatch_dims, read_f32, storage_f32, u32_bytes, uniform, zeroed_f32, STORAGE};
use llull_gpu::device::{acquire, Gpu};
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry};
use llull_gpu::wgpu;
use llull_gpu::wgpu::util::DeviceExt;
use std::time::{Duration, Instant};

const SHADER: &str = include_str!("lbm.wgsl");
const THREADS: usize = 64;
/// GPU time one submit aims at.
const SLICE_TARGET: Duration = Duration::from_millis(50);
const MAX_BATCH: u64 = 4096;

/// Bytes per cell of the GPU state (two population copies, flags, body, ρ, u, force, averages).
pub const BYTES_PER_CELL: usize = (2 * Q + 1 + 1 + 1 + 3 + 3 + 1 + 3) * 4;

/// The lattice state on the GPU.
pub struct GpuSolver {
    gpu: Gpu,
    n: usize,
    groups: u32,
    step_pipeline: wgpu::ComputePipeline,
    accumulate_pipeline: wgpu::ComputePipeline,
    bind: [wgpu::BindGroup; 2],
    force: wgpu::Buffer,
    rho: wgpu::Buffer,
    vel: wgpu::Buffer,
    avg_rho: wgpu::Buffer,
    avg_vel: wgpu::Buffer,
    current: usize,
    steps: u64,
    samples: u32,
    batch: u64,
}

fn params_bytes(domain: &Domain, params: &Params<f32>, groups_x: u32) -> Vec<u8> {
    let grid = &domain.grid;
    let mut bytes = u32_bytes(&[
        grid.nx as u32,
        grid.ny as u32,
        grid.nz as u32,
        grid.cells() as u32,
        groups_x,
        u32::from(domain.periodic[0]),
        u32::from(domain.periodic[1]),
        u32::from(domain.periodic[2]),
    ]);
    let floats = [
        params.tau,
        params.smagorinsky,
        0.0,
        0.0,
        params.u_in[0],
        params.u_in[1],
        params.u_in[2],
        0.0,
        params.u_wall[0],
        params.u_wall[1],
        params.u_wall[2],
        0.0,
        params.body_force[0],
        params.body_force[1],
        params.body_force[2],
        0.0,
    ];
    bytes.extend(floats.iter().flat_map(|v| v.to_le_bytes()));
    bytes
}

fn triples(values: Vec<f32>) -> Vec<[f32; 3]> {
    values.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}

impl GpuSolver {
    /// Uploads `domain` at the equilibrium of `initial(cell) -> (ρ, u)`.
    /// @failure no usable adapter -> Err(reason) (the caller runs the CPU twin); a population buffer above the adapter's limits ->
    ///   Err starting with `CFD_MEMORY_EXCEEDED:` (refused before any allocation)
    pub fn new(domain: &Domain, params: Params<f32>, initial: impl Fn(usize) -> (f32, [f32; 3])) -> Result<GpuSolver, String> {
        let gpu = acquire("llull-flow-lbm")?;
        let n = domain.grid.cells();
        let limits = gpu.device.limits();
        let largest = (n * Q * 4) as u64;
        let cap = u64::from(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size);
        if largest > cap {
            return Err(format!(
                "CFD_MEMORY_EXCEEDED: {n} cells need a {largest}-byte population buffer, the adapter {} binds at most {cap} bytes (about {} cells)",
                gpu.adapter,
                cap / (Q as u64 * 4)
            ));
        }
        let mut f = vec![0.0f32; n * Q];
        for cell in 0..n {
            let (rho, u) = initial(cell);
            for (q, value) in equilibrium_set(rho, u).iter().enumerate() {
                f[q * n + cell] = *value;
            }
        }
        let groups = n.div_ceil(THREADS).max(1) as u32;
        let (groups_x, _) = dispatch_dims(groups);
        let params_buffer = uniform(&gpu, "llull-flow-lbm params", &params_bytes(domain, &params, groups_x));
        let f_buffers = [storage_f32(&gpu, "llull-flow-lbm f0", &f), storage_f32(&gpu, "llull-flow-lbm f1", &f)];
        let flags: Vec<u32> = domain.flags.iter().map(|flag| u32::from(*flag)).collect();
        let body: Vec<u32> = domain.body.iter().map(|owner| u32::from(*owner)).collect();
        let flags = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("llull-flow-lbm flags"),
            contents: &u32_bytes(&flags),
            usage: STORAGE,
        });
        let body = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("llull-flow-lbm body"),
            contents: &u32_bytes(&body),
            usage: STORAGE,
        });
        let rho = zeroed_f32(&gpu, "llull-flow-lbm rho", n);
        let vel = zeroed_f32(&gpu, "llull-flow-lbm vel", 3 * n);
        let force = zeroed_f32(&gpu, "llull-flow-lbm force", 3 * n);
        let avg_rho = zeroed_f32(&gpu, "llull-flow-lbm avg rho", n);
        let avg_vel = zeroed_f32(&gpu, "llull-flow-lbm avg vel", 3 * n);
        let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("llull-flow-lbm"),
            entries: &[
                uniform_entry(0),
                storage_entry(1, true),
                storage_entry(2, false),
                storage_entry(3, true),
                storage_entry(4, true),
                storage_entry(5, false),
                storage_entry(6, false),
                storage_entry(7, false),
                storage_entry(8, false),
                storage_entry(9, false),
            ],
        });
        let step_pipeline = compute_pipeline(&gpu, SHADER, "step", &layout);
        let accumulate_pipeline = compute_pipeline(&gpu, SHADER, "accumulate", &layout);
        let bind_group = |input: &wgpu::Buffer, output: &wgpu::Buffer| {
            gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("llull-flow-lbm"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: params_buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: input.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: output.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: flags.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: body.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 5, resource: rho.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: vel.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 7, resource: force.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 8, resource: avg_rho.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 9, resource: avg_vel.as_entire_binding() },
                ],
            })
        };
        let bind = [bind_group(&f_buffers[0], &f_buffers[1]), bind_group(&f_buffers[1], &f_buffers[0])];
        Ok(GpuSolver {
            gpu,
            n,
            groups,
            step_pipeline,
            accumulate_pipeline,
            bind,
            force,
            rho,
            vel,
            avg_rho,
            avg_vel,
            current: 0,
            steps: 0,
            samples: 0,
            batch: 1,
        })
    }

    pub fn adapter(&self) -> &str {
        &self.gpu.adapter
    }

    fn dispatch(&self, pass: &mut wgpu::ComputePass<'_>, pipeline: &wgpu::ComputePipeline, bind: usize) {
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &self.bind[bind], &[]);
        let (x, y) = dispatch_dims(self.groups);
        pass.dispatch_workgroups(x, y, 1);
    }

    fn submit_steps(&mut self, count: u64) -> Result<(), String> {
        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass =
                encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("llull-flow-lbm steps"), timestamp_writes: None });
            for _ in 0..count {
                self.dispatch(&mut pass, &self.step_pipeline, self.current);
                self.current ^= 1;
            }
        }
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
        self.steps += count;
        Ok(())
    }

    /// Instantaneous velocity per cell (m/s in lattice units).
    pub fn vel(&self) -> Result<Vec<[f32; 3]>, String> {
        read_f32(&self.gpu, &self.vel, 3 * self.n).map(triples)
    }

    pub fn rho(&self) -> Result<Vec<f32>, String> {
        read_f32(&self.gpu, &self.rho, self.n)
    }
}

impl Backend for GpuSolver {
    fn advance(&mut self, steps: u64) -> Result<(), String> {
        let mut remaining = steps;
        while remaining > 0 {
            let count = self.batch.min(remaining);
            let started = Instant::now();
            self.submit_steps(count)?;
            let elapsed = started.elapsed();
            if elapsed < SLICE_TARGET / 2 {
                self.batch = (self.batch * 2).min(MAX_BATCH);
            } else if elapsed > SLICE_TARGET {
                self.batch = (self.batch / 2).max(1);
            }
            remaining -= count;
        }
        Ok(())
    }

    fn steps_done(&self) -> u64 {
        self.steps
    }

    fn force(&mut self) -> Result<Vec<[f32; 3]>, String> {
        let rho = self.rho()?;
        if let Some(cell) = rho.iter().position(|value| !(value.is_finite() && *value >= 0.0)) {
            return Err(format!("non-finite or negative density at cell {cell} after {} steps (GPU)", self.steps));
        }
        read_f32(&self.gpu, &self.force, 3 * self.n).map(triples)
    }

    fn accumulate(&mut self) -> Result<(), String> {
        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder
                .begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("llull-flow-lbm accumulate"), timestamp_writes: None });
            self.dispatch(&mut pass, &self.accumulate_pipeline, self.current);
        }
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
        self.samples += 1;
        Ok(())
    }

    fn averages(&mut self) -> Result<Averages, String> {
        if self.samples == 0 {
            return Ok((self.rho()?, self.vel()?, 0));
        }
        let n = self.samples as f32;
        let rho = read_f32(&self.gpu, &self.avg_rho, self.n)?.into_iter().map(|v| v / n).collect();
        let vel = triples(read_f32(&self.gpu, &self.avg_vel, 3 * self.n)?).into_iter().map(|v| [v[0] / n, v[1] / n, v[2] / n]).collect();
        Ok((rho, vel, self.samples))
    }

    fn info(&self) -> BackendInfo {
        BackendInfo { device: "gpu", adapter: Some(self.gpu.adapter.clone()), deterministic: false, precision: "f32" }
    }
}
