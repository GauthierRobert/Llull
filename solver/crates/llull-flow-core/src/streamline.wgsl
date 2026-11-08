// Streamline integration on the GPU (12 CFD M3a, feature `gpu`): one invocation per (seed, direction), the same RK4 on the
// unit velocity direction as `streamline.rs`, in f32 on positions relative to the grid origin. The velocity rule mirrors
// `FlowField::velocity_strict`: fold into the solved half, stop in the face layer / outside (1) or in a solid cell (2), then
// trilinear over the valid cells. Stop codes: 1 left_domain, 2 wall, 3 stagnation, 4 max_length, 5 max_steps.

struct Params {
  size: vec4<u32>,         // nx, ny, nz, mirror count
  mirror_axis: vec4<u32>,  // axes of the mirrors, w = tasks in this batch
  mirror_high: vec4<u32>,  // high flags of the mirrors, w = max steps
  mirror_plane: vec4<f32>, // planes (relative to the origin), w = cell size h
  limits: vec4<f32>,       // step, max length, min speed, unused
  dispatch: vec4<u32>,     // workgroups along x
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> ux: array<f32>;
@group(0) @binding(2) var<storage, read> uy: array<f32>;
@group(0) @binding(3) var<storage, read> uz: array<f32>;
@group(0) @binding(4) var<storage, read> valid: array<u32>;
@group(0) @binding(5) var<storage, read> seeds: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> points: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> info: array<u32>;

struct Probe {
  dir: vec3<f32>,
  speed: f32,
  status: u32,
}

fn is_valid(cell: u32) -> bool {
  return ((valid[cell >> 5u] >> (cell & 31u)) & 1u) == 1u;
}

fn cell_index(i: vec3<u32>) -> u32 {
  return i.x + params.size.x * (i.y + params.size.y * i.z);
}

// Velocity at `position`, or status 1 (left the fluid box) / 2 (solid).
fn velocity(position: vec3<f32>) -> Probe {
  var p = position;
  var flip = vec3<f32>(1.0, 1.0, 1.0);
  for (var m = 0u; m < params.size.w; m = m + 1u) {
    let axis = params.mirror_axis[m];
    let plane = params.mirror_plane[m];
    let beyond = select(p[axis] < plane, p[axis] > plane, params.mirror_high[m] == 1u);
    if (beyond) {
      p[axis] = 2.0 * plane - p[axis];
      flip[axis] = -flip[axis];
    }
  }
  let h = params.mirror_plane.w;
  let n = params.size.xyz;
  let c = p / h;
  if (any(c < vec3<f32>(0.0)) || any(c >= vec3<f32>(n))) {
    return Probe(vec3<f32>(0.0), 0.0, 1u);
  }
  let ci = vec3<u32>(c);
  if (any(ci == vec3<u32>(0u)) || any(ci + vec3<u32>(1u) == n)) {
    return Probe(vec3<f32>(0.0), 0.0, 1u);
  }
  if (!is_valid(cell_index(ci))) {
    return Probe(vec3<f32>(0.0), 0.0, 2u);
  }
  let t = c - vec3<f32>(0.5);
  let base = vec3<u32>(clamp(floor(t), vec3<f32>(0.0), max(vec3<f32>(n) - vec3<f32>(2.0), vec3<f32>(0.0))));
  let f = clamp(t - vec3<f32>(base), vec3<f32>(0.0), vec3<f32>(1.0));
  var weight_sum = 0.0;
  var sum = vec3<f32>(0.0);
  for (var dk = 0u; dk < 2u; dk = dk + 1u) {
    for (var dj = 0u; dj < 2u; dj = dj + 1u) {
      for (var di = 0u; di < 2u; di = di + 1u) {
        let corner = min(base + vec3<u32>(di, dj, dk), n - vec3<u32>(1u));
        let cell = cell_index(corner);
        if (is_valid(cell)) {
          let w = select(1.0 - f.x, f.x, di == 1u) * select(1.0 - f.y, f.y, dj == 1u) * select(1.0 - f.z, f.z, dk == 1u);
          weight_sum = weight_sum + w;
          sum = sum + w * vec3<f32>(ux[cell], uy[cell], uz[cell]);
        }
      }
    }
  }
  if (weight_sum <= 1e-12) {
    return Probe(vec3<f32>(0.0), 0.0, 2u);
  }
  let v = sum / weight_sum * flip;
  return Probe(v, length(v), 0u);
}

// Unit direction times `sign`, or the stop status (3 = stagnation).
fn direction(position: vec3<f32>, sign: f32) -> Probe {
  let probe = velocity(position);
  if (probe.status != 0u) {
    return probe;
  }
  if (!(probe.speed >= params.limits.z) || probe.speed == 0.0) {
    return Probe(vec3<f32>(0.0), probe.speed, 3u);
  }
  return Probe(probe.dir * (sign / probe.speed), probe.speed, 0u);
}

@compute @workgroup_size(64)
fn trace(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let task = (wid.y * params.dispatch.x + wid.x) * 64u + lid.x;
  if (task >= params.mirror_axis.w) {
    return;
  }
  let seed = seeds[task];
  let sign = seed.w;
  let h = params.limits.x;
  let max_steps = params.mirror_high.w;
  var p = seed.xyz;
  var length_m = 0.0;
  var count = 0u;
  var stop = 5u;
  for (var step = 0u; step < max_steps; step = step + 1u) {
    if (length_m >= params.limits.y) {
      stop = 4u;
      break;
    }
    let k1 = direction(p, sign);
    if (k1.status != 0u) { stop = k1.status; break; }
    let k2 = direction(p + 0.5 * h * k1.dir, sign);
    if (k2.status != 0u) { stop = k2.status; break; }
    let k3 = direction(p + 0.5 * h * k2.dir, sign);
    if (k3.status != 0u) { stop = k3.status; break; }
    let k4 = direction(p + h * k3.dir, sign);
    if (k4.status != 0u) { stop = k4.status; break; }
    let next = p + (h / 6.0) * (k1.dir + 2.0 * k2.dir + 2.0 * k3.dir + k4.dir);
    let at = direction(next, sign);
    if (at.status != 0u) { stop = at.status; break; }
    length_m = length_m + distance(next, p);
    p = next;
    points[task * max_steps + count] = vec4<f32>(p, at.speed);
    count = count + 1u;
  }
  info[2u * task] = count;
  info[2u * task + 1u] = stop;
}
