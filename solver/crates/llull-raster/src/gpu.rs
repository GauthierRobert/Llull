//! wgpu offscreen z-buffer (cargo feature `gpu`): the front-facing triangles are drawn into an id / value / depth target set with a
//! strict depth test (first drawn wins ties, as the CPU), the ghost silhouettes into a coverage target, then the CPU `resolve` stage turns
//! the buffers into RGBA. GPU rasterisation rules (top-left fill) and float32 interpolation differ from the TypeScript pixel-centre rule,
//! so the image is a picture (`deterministic: false`), never a reference. No adapter -> Err with the reason (the caller falls back).

use crate::cpu::{resolve, ZBuffer};
use crate::Prepared;
use wgpu::util::DeviceExt;

const SHADER: &str = r"
struct VertexIn {
  @location(0) pos: vec2<f32>,
  @location(1) depth: f32,
  @location(2) z: f32,
  @location(3) v: f32,
  @location(4) id: i32,
};
struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) @interpolate(linear) z: f32,
  @location(1) @interpolate(linear) v: f32,
  @location(2) @interpolate(flat) id: i32,
};
@vertex fn vs(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.clip = vec4<f32>(input.pos, input.depth, 1.0);
  out.z = input.z;
  out.v = input.v;
  out.id = input.id;
  return out;
}
struct FragOut {
  @location(0) id: i32,
  @location(1) v: f32,
  @location(2) z: f32,
};
@fragment fn fs(input: VertexOut) -> FragOut {
  var out: FragOut;
  out.id = input.id;
  out.v = input.v;
  out.z = input.z;
  return out;
}
@fragment fn ghost(input: VertexOut) -> @location(0) u32 {
  return 1u;
}
";

/// Vertex: x, y (NDC), depth (0 near .. 1 far), z, v, id as raw f32 bits (5 floats + 1 int).
const VERTEX_FLOATS: usize = 6;

fn vertices(p: &Prepared, w: f64, h: f64, ghost: bool) -> Vec<f32> {
    let (mut near, mut far) = (f64::NEG_INFINITY, f64::INFINITY);
    for corner in p.triangles.chunks_exact(4) {
        near = near.max(corner[2]);
        far = far.min(corner[2]);
    }
    let span = if near > far { near - far } else { 1.0 };
    let mut out = Vec::new();
    let mut push = |x: f64, y: f64, z: f64, v: f64, id: i32, depth: f64| {
        out.extend_from_slice(&[
            (x / w * 2.0 - 1.0) as f32,
            (1.0 - y / h * 2.0) as f32,
            depth as f32,
            z as f32,
            v as f32,
            f32::from_bits(id as u32),
        ]);
    };
    if ghost {
        for g in p.ghost_triangles.chunks_exact(6) {
            for k in 0..3 {
                push(g[k * 2], g[k * 2 + 1], 0.0, 0.0, -1, 0.5);
            }
        }
    } else {
        for (id, t) in p.triangles.chunks_exact(12).enumerate() {
            for k in 0..3 {
                let z = t[k * 4 + 2];
                push(t[k * 4], t[k * 4 + 1], z, t[k * 4 + 3], id as i32, ((near - z) / span).clamp(0.0, 1.0) * 0.999);
            }
        }
    }
    out
}

fn target(device: &wgpu::Device, w: u32, h: u32, format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

fn pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    entry: &str,
    formats: &[wgpu::TextureFormat],
    depth: bool,
) -> wgpu::RenderPipeline {
    let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32, 2 => Float32, 3 => Float32, 4 => Sint32];
    let targets: Vec<Option<wgpu::ColorTargetState>> =
        formats.iter().map(|&format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })).collect();
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[wgpu::VertexBufferLayout {
                array_stride: (VERTEX_FLOATS * 4) as u64,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &attributes,
            }],
        },
        primitive: wgpu::PrimitiveState { cull_mode: None, ..wgpu::PrimitiveState::default() },
        depth_stencil: depth.then(|| wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: true,
            depth_compare: wgpu::CompareFunction::Less,
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &targets,
        }),
        multiview: None,
        cache: None,
    })
}

fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let row = (w * 4).div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: u64::from(row) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([encoder.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::Wait).map_err(|error| format!("GPU poll failed: {error}"))?;
    let data = slice.get_mapped_range();
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h as usize {
        let start = y * row as usize;
        out.extend_from_slice(&data[start..start + (w * 4) as usize]);
    }
    Ok(out)
}

fn words(bytes: &[u8]) -> impl Iterator<Item = [u8; 4]> + '_ {
    bytes.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]])
}

/// RGBA, depth and the adapter name, or why the GPU could not be used.
pub fn raster_pixels(p: &Prepared) -> Result<(Vec<u8>, Vec<f32>, String), String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .map_err(|error| format!("no GPU adapter ({error})"))?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
        .map_err(|error| format!("no GPU device ({error})"))?;
    let (w, h) = ((p.width * p.samples) as u32, (p.height * p.samples) as u32);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
    let formats = [wgpu::TextureFormat::R32Sint, wgpu::TextureFormat::R32Float, wgpu::TextureFormat::R32Float];
    let main = pipeline(&device, &module, "fs", &formats, true);
    let ghost_pipeline = pipeline(&device, &module, "ghost", &[wgpu::TextureFormat::R32Uint], false);
    let targets: Vec<wgpu::Texture> = formats.iter().map(|&format| target(&device, w, h, format)).collect();
    let ghost_target = target(&device, w, h, wgpu::TextureFormat::R32Uint);
    let depth_target = target(&device, w, h, wgpu::TextureFormat::Depth32Float);
    let views: Vec<wgpu::TextureView> = targets.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();
    let ghost_view = ghost_target.create_view(&wgpu::TextureViewDescriptor::default());
    let depth_view = depth_target.create_view(&wgpu::TextureViewDescriptor::default());
    let (fw, fh) = (f64::from(w), f64::from(h));
    let triangles = vertices(p, fw, fh, false);
    let ghosts = vertices(p, fw, fh, true);
    let buffer = |data: &[f32]| {
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &bytes, usage: wgpu::BufferUsages::VERTEX })
    };
    let (triangle_buffer, ghost_buffer) = (buffer(&triangles), buffer(&ghosts));
    let clears = [-1.0, 0.0, f64::NEG_INFINITY];
    let scissor = (p.clip.left as u32, p.clip.top as u32, (p.clip.right - p.clip.left) as u32, (p.clip.bottom - p.clip.top) as u32);
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = views
            .iter()
            .zip(clears)
            .map(|(view, clear)| {
                Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r: clear, g: 0.0, b: 0.0, a: 0.0 }),
                        store: wgpu::StoreOp::Store,
                    },
                })
            })
            .collect();
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if scissor.2 > 0 && scissor.3 > 0 && !triangles.is_empty() {
            pass.set_scissor_rect(scissor.0, scissor.1, scissor.2, scissor.3);
            pass.set_pipeline(&main);
            pass.set_vertex_buffer(0, triangle_buffer.slice(..));
            pass.draw(0..(triangles.len() / VERTEX_FLOATS) as u32, 0..1);
        }
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &ghost_view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if scissor.2 > 0 && scissor.3 > 0 && !ghosts.is_empty() {
            pass.set_scissor_rect(scissor.0, scissor.1, scissor.2, scissor.3);
            pass.set_pipeline(&ghost_pipeline);
            pass.set_vertex_buffer(0, ghost_buffer.slice(..));
            pass.draw(0..(ghosts.len() / VERTEX_FLOATS) as u32, 0..1);
        }
    }
    queue.submit([encoder.finish()]);
    let ids = read_back(&device, &queue, &targets[0], w, h)?;
    let values = read_back(&device, &queue, &targets[1], w, h)?;
    let depths = read_back(&device, &queue, &targets[2], w, h)?;
    let covered = read_back(&device, &queue, &ghost_target, w, h)?;
    let triangle: Vec<i64> = words(&ids).map(|b| i64::from(i32::from_le_bytes(b))).collect();
    let buffers = ZBuffer {
        depth: words(&depths).zip(&triangle).map(|(b, &id)| if id < 0 { f32::NEG_INFINITY } else { f32::from_le_bytes(b) }).collect(),
        value: words(&values).map(f32::from_le_bytes).collect(),
        ghost: if p.ghost { words(&covered).map(|b| u8::from(u32::from_le_bytes(b) == 1)).collect() } else { Vec::new() },
        triangle,
    };
    let rgba = resolve(p, &buffers);
    Ok((rgba, buffers.depth, format!("{} ({:?})", info.name, info.backend)))
}
