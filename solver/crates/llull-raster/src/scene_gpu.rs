//! wgpu offscreen fill of a render scene (cargo feature `gpu`): every filled polygon is drawn into a face-id / z target set with a
//! strict depth test (first drawn wins ties, as the CPU). Convex single-loop faces are batched as triangle fans; any other face (cut caps,
//! concave outlines, holes) is filled even-odd with a stencil pass (fans with INVERT) and a stencil-tested cover pass that resets the
//! stencil. Strokes, outlines and the supersample resolve then run on the CPU twin over the read-back buffers. GPU rasterisation rules
//! differ from the TypeScript pixel-centre scan, so the image is a picture (`deterministic: false`), never a reference.

use crate::gpu::{read_back, target, words};
use crate::scene::Scene;
use crate::scene_cpu::{draw_strokes, resolve, SceneBuffers};
use wgpu::util::DeviceExt;

const SHADER: &str = r"
struct VertexIn {
  @location(0) pos: vec2<f32>,
  @location(1) depth: f32,
  @location(2) z: f32,
  @location(3) face: i32,
};
struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) @interpolate(linear) z: f32,
  @location(1) @interpolate(flat) face: i32,
};
@vertex fn vs(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.clip = vec4<f32>(input.pos, input.depth, 1.0);
  out.z = input.z;
  out.face = input.face;
  return out;
}
struct FragOut {
  @location(0) face: i32,
  @location(1) z: f32,
};
@fragment fn fs(input: VertexOut) -> FragOut {
  var out: FragOut;
  out.face = input.face;
  out.z = input.z;
  return out;
}
";

/// Vertex: x, y (NDC), depth (0..1), z (scene value), face id as raw f32 bits.
const VERTEX_FLOATS: usize = 5;
const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24PlusStencil8;
const COLOR_FORMATS: [wgpu::TextureFormat; 2] = [wgpu::TextureFormat::R32Sint, wgpu::TextureFormat::R32Float];

/// A run of vertices drawn with one pipeline: `Convex` with the depth test, `EvenOdd` with the stencil pair.
enum Batch {
    Convex(std::ops::Range<u32>),
    EvenOdd(std::ops::Range<u32>),
}

type Pt = [f64; 3];

/// True for one loop whose turn direction never changes (a fan then covers it exactly once).
fn convex(ring: &[Pt]) -> bool {
    let n = ring.len();
    let (mut positive, mut negative) = (false, false);
    for i in 0..n {
        let (a, b, c) = (ring[i], ring[(i + 1) % n], ring[(i + 2) % n]);
        let cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        positive |= cross > 1e-12;
        negative |= cross < -1e-12;
    }
    !(positive && negative)
}

/// Vertices (fans of every loop) and the draw batches, in fill order.
fn geometry(scene: &Scene, w: f64, h: f64) -> (Vec<f32>, Vec<Batch>) {
    let point = |i: usize| -> Pt { [scene.points[i * 3], scene.points[i * 3 + 1], scene.points[i * 3 + 2]] };
    let (mut low, mut high) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in scene.points.chunks_exact(3) {
        low = low.min(p[2]);
        high = high.max(p[2]);
    }
    let span = if high > low { high - low } else { 1.0 };
    let mut vertices: Vec<f32> = Vec::new();
    let mut batches: Vec<Batch> = Vec::new();
    for fill in scene.fills.chunks_exact(3) {
        let face = fill[0] as i32;
        let rings: Vec<Vec<Pt>> = (fill[1] as usize..(fill[1] + fill[2]) as usize)
            .map(|l| (scene.loops[l * 2] as usize..(scene.loops[l * 2] + scene.loops[l * 2 + 1]) as usize).map(point).collect())
            .collect();
        let start = (vertices.len() / VERTEX_FLOATS) as u32;
        for ring in rings.iter().filter(|ring| ring.len() >= 3) {
            for k in 1..ring.len() - 1 {
                for p in [ring[0], ring[k], ring[k + 1]] {
                    let depth = 0.001 + 0.998 * (p[2] - low) / span;
                    vertices.extend_from_slice(&[
                        (p[0] / w * 2.0 - 1.0) as f32,
                        (1.0 - p[1] / h * 2.0) as f32,
                        depth as f32,
                        p[2] as f32,
                        f32::from_bits(face as u32),
                    ]);
                }
            }
        }
        let end = (vertices.len() / VERTEX_FLOATS) as u32;
        if end == start {
            continue;
        }
        let simple = rings.len() == 1 && convex(&rings[0]);
        match (simple, batches.last_mut()) {
            (true, Some(Batch::Convex(range))) if range.end == start => range.end = end,
            (true, _) => batches.push(Batch::Convex(start..end)),
            (false, _) => batches.push(Batch::EvenOdd(start..end)),
        }
    }
    (vertices, batches)
}

fn pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    stencil: wgpu::StencilFaceState,
    depth: (bool, wgpu::CompareFunction),
    write: wgpu::ColorWrites,
) -> wgpu::RenderPipeline {
    let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32, 2 => Float32, 3 => Sint32];
    let targets: Vec<Option<wgpu::ColorTargetState>> =
        COLOR_FORMATS.iter().map(|&format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: write })).collect();
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
        depth_stencil: Some(wgpu::DepthStencilState {
            format: DEPTH_FORMAT,
            depth_write_enabled: depth.0,
            depth_compare: depth.1,
            stencil: wgpu::StencilState { front: stencil, back: stencil, read_mask: 0xff, write_mask: 0xff },
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some("fs"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &targets,
        }),
        multiview: None,
        cache: None,
    })
}

const KEEP: wgpu::StencilFaceState = wgpu::StencilFaceState::IGNORE;
const MARK: wgpu::StencilFaceState = wgpu::StencilFaceState {
    compare: wgpu::CompareFunction::Always,
    fail_op: wgpu::StencilOperation::Keep,
    depth_fail_op: wgpu::StencilOperation::Keep,
    pass_op: wgpu::StencilOperation::Invert,
};
const COVER: wgpu::StencilFaceState = wgpu::StencilFaceState {
    compare: wgpu::CompareFunction::NotEqual,
    fail_op: wgpu::StencilOperation::Keep,
    depth_fail_op: wgpu::StencilOperation::Zero,
    pass_op: wgpu::StencilOperation::Zero,
};

/// The filled-face buffers drawn on the GPU and the adapter name, or why the GPU could not be used.
fn fill_gpu(scene: &Scene) -> Result<(SceneBuffers, String), String> {
    let gpu = llull_gpu::device::acquire("llull-raster-scene")?;
    let (device, queue) = (&gpu.device, &gpu.queue);
    let (bw, bh) = scene.buffer_size();
    let (w, h) = (bw as u32, bh as u32);
    let limit = device.limits().max_texture_dimension_2d;
    if w > limit || h > limit {
        return Err(format!("{w} x {h} exceeds the adapter texture limit {limit}"));
    }
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
    let less = (true, wgpu::CompareFunction::Less);
    let convex_pipeline = pipeline(device, &module, KEEP, less, wgpu::ColorWrites::ALL);
    let mark_pipeline = pipeline(device, &module, MARK, (false, wgpu::CompareFunction::Always), wgpu::ColorWrites::empty());
    let cover_pipeline = pipeline(device, &module, COVER, less, wgpu::ColorWrites::ALL);
    let targets: Vec<wgpu::Texture> = COLOR_FORMATS.iter().map(|&format| target(device, w, h, format)).collect();
    let depth_target = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let views: Vec<wgpu::TextureView> = targets.iter().map(|t| t.create_view(&wgpu::TextureViewDescriptor::default())).collect();
    let depth_view = depth_target.create_view(&wgpu::TextureViewDescriptor::default());
    let (vertices, batches) = geometry(scene, f64::from(w), f64::from(h));
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = views
            .iter()
            .zip([-1.0, 0.0])
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
                stencil_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0), store: wgpu::StoreOp::Store }),
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if !vertices.is_empty() {
            let bytes: Vec<u8> = vertices.iter().flat_map(|v| v.to_le_bytes()).collect();
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: &bytes,
                usage: wgpu::BufferUsages::VERTEX,
            });
            pass.set_vertex_buffer(0, buffer.slice(..));
            pass.set_stencil_reference(0);
            for batch in &batches {
                match batch {
                    Batch::Convex(range) => {
                        pass.set_pipeline(&convex_pipeline);
                        pass.draw(range.clone(), 0..1);
                    }
                    Batch::EvenOdd(range) => {
                        pass.set_pipeline(&mark_pipeline);
                        pass.draw(range.clone(), 0..1);
                        pass.set_pipeline(&cover_pipeline);
                        pass.draw(range.clone(), 0..1);
                    }
                }
            }
        }
    }
    queue.submit([encoder.finish()]);
    let faces = read_back(device, queue, &targets[0], w, h)?;
    let zs = read_back(device, queue, &targets[1], w, h)?;
    let face: Vec<i32> = words(&faces).map(i32::from_le_bytes).collect();
    let depth = words(&zs).zip(&face).map(|(bytes, &f)| if f < 0 { f32::INFINITY } else { f32::from_le_bytes(bytes) }).collect();
    Ok((SceneBuffers { depth, face }, gpu.adapter.clone()))
}

/// RGBA of the scene with the fills drawn on the GPU, and the adapter, or why the GPU could not be used.
pub fn raster_pixels(scene: &Scene) -> Result<(Vec<u8>, String), String> {
    let (mut buffers, adapter) = fill_gpu(scene)?;
    draw_strokes(scene, &mut buffers);
    Ok((resolve(scene, &buffers), adapter))
}
