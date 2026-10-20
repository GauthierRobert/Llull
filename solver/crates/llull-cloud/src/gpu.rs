//! GPU distances (RS-4, TECHNICAL_SPEC §2.A M7) on `llull-gpu` (wgpu): per point, the signed distance to the nearest of a set of design
//! entities, in f32 relative to a local origin. Analytic primitives (pipe / cylinder segments, boxes, spheres) are evaluated in the shader;
//! triangles keep their mesh part (nearest triangle per part, signed by its normal, then the minimum over parts), the same rules as
//! [`crate::distance`]. The CPU twin is `distance::Entity::distance` in f64: deviation numbers and clash results always come from it.
//!
//! ε_gpu = [`EPS_GPU_FACTOR`] · 2⁻²⁴ · L, with L the largest coordinate of the local frame: the f32 unit roundoff times the extent times
//! a bound on the operation count. The clash prune drops a point only when its GPU distance exceeds the reach by more than ε_gpu, so the
//! points it keeps re-evaluated in f64 give exactly the CPU-only result.

use crate::cloud::Vec3;
use crate::distance::{EntitySpec, Primitive};
use crate::linalg::{cross, norm, sub, unit};
use llull_gpu::buffers::{dispatch_dims, read_f32, storage_f32, u32_bytes, uniform, zeroed_f32};
use llull_gpu::device::{acquire, Gpu};
use llull_gpu::dot::{compute_pipeline, storage_entry, uniform_entry};

/// Operation-count factor of ε_gpu (≈ 30 flops per distance, ×2 margin).
pub const EPS_GPU_FACTOR: f64 = 64.0;
const RECORD: usize = 20;
const THREADS: u32 = 256;

const SHADER: &str = r"
struct Params { n: u32, first: u32, count: u32, groups_x: u32, reach: f32, p0: f32, p1: f32, p2: f32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> points: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> entities: array<f32>;
@group(0) @binding(3) var<storage, read> records: array<f32>;
@group(0) @binding(4) var<storage, read_write> out_d: array<f32>;
@group(0) @binding(5) var<storage, read_write> out_e: array<f32>;

fn v3(base: u32) -> vec3<f32> { return vec3<f32>(records[base], records[base + 1u], records[base + 2u]); }

fn on_segment(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>) -> vec3<f32> {
  let e = b - a;
  let t = clamp(dot(p - a, e) / max(dot(e, e), 1e-30), 0.0, 1.0);
  return a + e * t;
}

// Closest point of a triangle in a form that stays well conditioned in f32 for long thin facets: the plane projection when it falls
// inside (edge-side tests against the unit normal), else the nearest of the three edge segments. Same point as Ericson 5.1.5 in exact
// arithmetic (the CPU twin), without its barycentric cancellations.
fn closest_on_triangle(p: vec3<f32>, a: vec3<f32>, b: vec3<f32>, c: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let inside = dot(cross(b - a, p - a), n) >= 0.0 && dot(cross(c - b, p - b), n) >= 0.0 && dot(cross(a - c, p - c), n) >= 0.0;
  if (inside) { return p - n * dot(p - a, n); }
  let q0 = on_segment(p, a, b);
  let q1 = on_segment(p, b, c);
  let q2 = on_segment(p, c, a);
  var q = q0;
  if (length(p - q1) < length(p - q)) { q = q1; }
  if (length(p - q2) < length(p - q)) { q = q2; }
  return q;
}

fn analytic(p: vec3<f32>, r: u32) -> f32 {
  let kind = records[r];
  if (kind == 1.0) {
    let a = v3(r + 2u); let u = v3(r + 5u); let len = records[r + 8u]; let radius = records[r + 9u];
    let v = p - a; let t = dot(v, u);
    let radial = length(v - u * t) - radius;
    if (t >= 0.0 && t <= len) { return radial; }
    let beyond = select(t - len, -t, t < 0.0);
    let rr = max(radial, 0.0);
    return sqrt(rr * rr + beyond * beyond);
  }
  if (kind == 2.0) {
    let d = p - v3(r + 2u);
    let q = vec3<f32>(abs(dot(d, v3(r + 5u))), abs(dot(d, v3(r + 8u))), abs(dot(d, v3(r + 11u)))) - v3(r + 14u);
    return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
  }
  return length(p - v3(r + 2u)) - records[r + 5u];
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = (wid.y * params.groups_x + wid.x) * 256u + lid;
  if (i >= params.n) { return; }
  let p = points[i].xyz;
  let big = 3.0e38;
  var best = big;
  var best_e = -1.0;
  for (var k = 0u; k < params.count; k = k + 1u) {
    let e = (params.first + k) * 8u;
    let lo = vec3<f32>(entities[e], entities[e + 1u], entities[e + 2u]) - vec3<f32>(params.reach);
    let hi = vec3<f32>(entities[e + 3u], entities[e + 4u], entities[e + 5u]) + vec3<f32>(params.reach);
    if (any(p < lo) || any(p > hi)) { continue; }
    let first = u32(entities[e + 6u]);
    let count = u32(entities[e + 7u]);
    var ent = big;
    var part = -1.0;
    var part_abs = big;
    var part_signed = big;
    for (var j = 0u; j < count; j = j + 1u) {
      let r = (first + j) * 20u;
      if (records[r] == 4.0) {
        if (records[r + 1u] != part) {
          if (part_abs < big) { ent = min(ent, part_signed); }
          part = records[r + 1u]; part_abs = big; part_signed = big;
        }
        let n = v3(r + 11u);
        let q = closest_on_triangle(p, v3(r + 2u), v3(r + 5u), v3(r + 8u), n);
        let dist = length(p - q);
        if (dist < part_abs) {
          part_abs = dist;
          part_signed = select(dist, -dist, dot(p - q, n) < 0.0);
        }
      } else {
        ent = min(ent, analytic(p, r));
      }
    }
    if (part_abs < big) { ent = min(ent, part_signed); }
    if (abs(ent) <= params.reach && abs(ent) < abs(best)) { best = ent; best_e = f32(params.first + k); }
  }
  out_d[i] = best;
  out_e[i] = best_e;
}
";

/// Entities and points packed for the shader in a local frame.
pub struct Packed {
    pub origin: Vec3,
    pub points: Vec<f32>,
    pub entities: Vec<f32>,
    pub records: Vec<f32>,
    /// Largest |coordinate| in the local frame (the L of ε_gpu).
    pub extent: f64,
}

/// ε_gpu of a packed problem (metres).
pub fn epsilon(extent: f64) -> f64 {
    EPS_GPU_FACTOR * f64::powi(2.0, -24) * extent.max(1e-3)
}

/// Packs `points` and `specs` relative to the centre of the entities' bounds.
pub fn pack(points: &[Vec3], specs: &[EntitySpec]) -> Packed {
    let prepared: Vec<crate::distance::Entity> = specs.iter().map(crate::distance::Entity::prepare).collect();
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for e in &prepared {
        for a in 0..3 {
            lo[a] = lo[a].min(e.low[a]);
            hi[a] = hi[a].max(e.high[a]);
        }
    }
    let origin: Vec3 = std::array::from_fn(|a| if lo[a].is_finite() { (lo[a] + hi[a]) / 2.0 } else { 0.0 });
    let local = |p: &Vec3| -> Vec3 { sub(p, &origin) };
    let mut extent: f64 = 0.0;
    let mut out_points = Vec::with_capacity(points.len() * 4);
    for p in points {
        let q = local(p);
        extent = extent.max(q[0].abs()).max(q[1].abs()).max(q[2].abs());
        out_points.extend([q[0] as f32, q[1] as f32, q[2] as f32, 0.0]);
    }
    let mut entities = Vec::new();
    let mut records: Vec<f32> = Vec::new();
    for (spec, entity) in specs.iter().zip(&prepared) {
        let first = records.len() / RECORD;
        for (part, primitive) in spec.primitives.iter().enumerate() {
            let mut push = |values: &[f64]| {
                let mut record = [0f32; RECORD];
                for (slot, v) in record.iter_mut().zip(values) {
                    *slot = *v as f32;
                }
                records.extend(record);
            };
            match primitive {
                Primitive::Cylinder { start, end, radius } => {
                    let (a, axis) = (local(start), sub(end, start));
                    if let Some(u) = unit(&axis) {
                        push(&[1.0, part as f64, a[0], a[1], a[2], u[0], u[1], u[2], norm(&axis), *radius]);
                    }
                }
                Primitive::Box { centre, axes, half } => {
                    let c = local(centre);
                    push(&[
                        2.0,
                        part as f64,
                        c[0],
                        c[1],
                        c[2],
                        axes[0][0],
                        axes[0][1],
                        axes[0][2],
                        axes[1][0],
                        axes[1][1],
                        axes[1][2],
                        axes[2][0],
                        axes[2][1],
                        axes[2][2],
                        half[0],
                        half[1],
                        half[2],
                    ]);
                }
                Primitive::Sphere { centre, radius } => {
                    let c = local(centre);
                    push(&[3.0, part as f64, c[0], c[1], c[2], *radius]);
                }
                Primitive::Mesh { triangles } => {
                    for t in triangles.chunks_exact(9) {
                        let (a, b, c) = (local(&[t[0], t[1], t[2]]), local(&[t[3], t[4], t[5]]), local(&[t[6], t[7], t[8]]));
                        let n = unit(&cross(&sub(&b, &a), &sub(&c, &a))).unwrap_or([0.0, 0.0, 1.0]);
                        push(&[4.0, part as f64, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], n[0], n[1], n[2]]);
                    }
                }
            }
        }
        let low = local(&entity.low);
        let high = local(&entity.high);
        extent = extent.max(low.iter().chain(high.iter()).fold(0.0, |m, v| m.max(v.abs())));
        let count = records.len() / RECORD - first;
        entities.extend([low[0], low[1], low[2], high[0], high[1], high[2], first as f64, count as f64].map(|v| v as f32));
    }
    Packed { origin, points: out_points, entities, records, extent }
}

/// Per-point GPU result: signed distance (f32 widened) and nearest entity, None beyond `reach`.
pub struct GpuDistances {
    pub nearest: Vec<Option<(usize, f64)>>,
    pub adapter: String,
    pub epsilon: f64,
}

/// Runs the kernel over entities [first, first + count) with the cull / assignment reach `reach`.
fn run(gpu: &Gpu, packed: &Packed, first: usize, count: usize, reach: f64) -> Result<Vec<Option<(usize, f64)>>, String> {
    let n = packed.points.len() / 4;
    let layout = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("llull-cloud distances"),
        entries: &[
            uniform_entry(0),
            storage_entry(1, true),
            storage_entry(2, true),
            storage_entry(3, true),
            storage_entry(4, false),
            storage_entry(5, false),
        ],
    });
    let pipeline = compute_pipeline(gpu, SHADER, "main", &layout);
    let groups = (n as u32).div_ceil(THREADS).max(1);
    let (gx, gy) = dispatch_dims(groups);
    let mut params = u32_bytes(&[n as u32, first as u32, count as u32, gx]);
    for v in [reach as f32, 0.0, 0.0, 0.0] {
        params.extend(v.to_le_bytes());
    }
    let params = uniform(gpu, "llull-cloud params", &params);
    let points = storage_f32(gpu, "llull-cloud points", &packed.points);
    let entities = storage_f32(gpu, "llull-cloud entities", &packed.entities);
    let records = storage_f32(gpu, "llull-cloud records", &packed.records);
    let out_d = zeroed_f32(gpu, "llull-cloud distances", n);
    let out_e = zeroed_f32(gpu, "llull-cloud entities out", n);
    let bind = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("llull-cloud distances"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: points.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: entities.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: records.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: out_d.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 5, resource: out_e.as_entire_binding() },
        ],
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass =
            encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("llull-cloud distances"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups(gx, gy, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    let distances = read_f32(gpu, &out_d, n)?;
    let entities = read_f32(gpu, &out_e, n)?;
    Ok(distances.iter().zip(&entities).map(|(d, e)| (*e >= 0.0).then(|| (*e as usize, f64::from(*d)))).collect())
}

/// Nearest entity and signed distance of every point within `reach` (deviation picture), or why the GPU is not used.
pub fn nearest(points: &[Vec3], specs: &[EntitySpec], reach: f64) -> Result<GpuDistances, String> {
    let gpu = acquire("llull-cloud")?;
    let packed = pack(points, specs);
    let nearest = run(&gpu, &packed, 0, specs.len(), reach)?;
    Ok(GpuDistances { nearest, adapter: gpu.adapter.clone(), epsilon: epsilon(packed.extent) })
}

/// For each entity, the indices of the points whose GPU distance is within `reach + ε_gpu` (the conservative clash prune).
pub fn prune(points: &[Vec3], specs: &[EntitySpec], reach: f64) -> Result<(Vec<Vec<usize>>, String, f64), String> {
    let gpu = acquire("llull-cloud")?;
    let packed = pack(points, specs);
    let eps = epsilon(packed.extent);
    let mut kept = Vec::with_capacity(specs.len());
    for e in 0..specs.len() {
        let result = run(&gpu, &packed, e, 1, reach + eps)?;
        kept.push(result.iter().enumerate().filter(|(_, r)| r.is_some_and(|(_, d)| d <= reach + eps)).map(|(i, _)| i).collect());
    }
    Ok((kept, gpu.adapter.clone(), eps))
}
