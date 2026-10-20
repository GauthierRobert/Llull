// llull-explicit GPU kernels for penalty contact (RS-8): contact.rs `forces` line for line, in f64 (exp in f32, as the J-C terms). One thread
// per slave (pass-major, the CPU order) evaluates its candidate segments, keeps its friction state and writes its force and the shape
// weights on the selected segment; a per-node gather then adds them over a host-built entry list in the CPU accumulation order. The candidate
// lists come from the host BVH (contact.rs `candidates`) with a margin, rebuilt when a node moved more than half of it (max_motion below).

// 4 node indices per segment (u32 max as the 4th of a triangle); per segment: stiffness, depth, half thickness
@group(1) @binding(14) var<storage, read> seg_nodes: array<u32>;
@group(1) @binding(15) var<storage, read> seg_data: array<f64>;
// per slave: node, pass, first candidate, candidate count; per slave: stiffness, half thickness; per pass: scale, mu_s, mu_d, decay
@group(1) @binding(16) var<storage, read> slaves: array<u32>;
@group(1) @binding(17) var<storage, read> slave_data: array<f64>;
@group(1) @binding(18) var<storage, read> pass_data: array<f64>;
@group(1) @binding(19) var<storage, read> candidates: array<u32>;
// per slave: previous segment (-1 none), xi, eta, tangential force (3)
@group(1) @binding(20) var<storage, read_write> slave_state: array<f64>;
// per slave: total force (3), selected segment (-1 none), shape weights (4)
@group(1) @binding(21) var<storage, read_write> slave_out: array<f64>;
// node -> entries (slave, segment, local index; local index 4 = the node is the slave)
@group(1) @binding(22) var<storage, read> cgather_start: array<u32>;
@group(1) @binding(23) var<storage, read> cgather: array<u32>;
// positions at the last candidate search
@group(1) @binding(24) var<storage, read> x_search: array<f64>;

const MAXPAR: f64 = 1.025lf;
const ROUND_OFF: f64 = 1.0e-9lf;
const NONE: u32 = 4294967295u;

fn seg_count(s: u32) -> u32 { return select(4u, 3u, seg_nodes[4u * s + 3u] == NONE); }
fn seg_point(s: u32, k: u32) -> vec3<f64> { return node_point(false, seg_nodes[4u * s + k]); }

fn seg_shape(count: u32, xi: f64, eta: f64) -> array<f64, 4> {
  if (count == 3u) { return array<f64, 4>(1.0lf - xi - eta, xi, eta, 0.0lf); }
  var w: array<f64, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) { w[k] = 0.25lf * (1.0lf + NAT_A[k] * xi) * (1.0lf + NAT_B[k] * eta); }
  return w;
}

fn seg_evaluate(s: u32, xi: f64, eta: f64) -> vec3<f64> {
  let count = seg_count(s);
  let w = seg_shape(count, xi, eta);
  var r = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
  for (var k = 0u; k < count; k = k + 1u) {
    let p = seg_point(s, k);
    r = vec3<f64>(r.x + w[k] * p.x, r.y + w[k] * p.y, r.z + w[k] * p.z);
  }
  return r;
}

struct Projected { ok: bool, xi: f64, eta: f64, r: vec3<f64>, n: vec3<f64> };

fn seg_project(s: u32, t: vec3<f64>) -> Projected {
  var out: Projected;
  out.ok = false;
  let count = seg_count(s);
  var p: array<vec3<f64>, 4>;
  for (var k = 0u; k < count; k = k + 1u) { p[k] = seg_point(s, k); }
  if (count == 3u) {
    let e1 = sub3(p[1], p[0]);
    let e2 = sub3(p[2], p[0]);
    let n = cross3(e1, e2);
    let length = sqrt(dot3(n, n));
    if (length == 0.0lf) { return out; }
    let d = sub3(t, p[0]);
    let a11 = dot3(e1, e1); let a12 = dot3(e1, e2); let a22 = dot3(e2, e2);
    let b1 = dot3(e1, d); let b2 = dot3(e2, d);
    let det = a11 * a22 - a12 * a12;
    out.xi = (b1 * a22 - b2 * a12) / det;
    out.eta = (a11 * b2 - a12 * b1) / det;
    out.r = seg_evaluate(s, out.xi, out.eta);
    out.n = vec3<f64>(n.x / length, n.y / length, n.z / length);
    out.ok = true;
    return out;
  }
  var xi = 0.0lf;
  var eta = 0.0lf;
  for (var iteration = 0u; iteration < 13u; iteration = iteration + 1u) {
    let r = seg_evaluate(s, xi, eta);
    var r_xi = vec3<f64>(0.0lf, 0.0lf, 0.0lf); var r_eta = vec3<f64>(0.0lf, 0.0lf, 0.0lf); var r_xe = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
    for (var k = 0u; k < 4u; k = k + 1u) {
      let a = NAT_A[k]; let b = NAT_B[k];
      r_xi = vec3<f64>(r_xi.x + 0.25lf * a * (1.0lf + b * eta) * p[k].x, r_xi.y + 0.25lf * a * (1.0lf + b * eta) * p[k].y, r_xi.z + 0.25lf * a * (1.0lf + b * eta) * p[k].z);
      r_eta = vec3<f64>(r_eta.x + 0.25lf * b * (1.0lf + a * xi) * p[k].x, r_eta.y + 0.25lf * b * (1.0lf + a * xi) * p[k].y, r_eta.z + 0.25lf * b * (1.0lf + a * xi) * p[k].z);
      r_xe = vec3<f64>(r_xe.x + 0.25lf * a * b * p[k].x, r_xe.y + 0.25lf * a * b * p[k].y, r_xe.z + 0.25lf * a * b * p[k].z);
    }
    let gap = sub3(r, t);
    var coupling = 0.0lf;
    if (iteration >= 3u) { coupling = dot3(gap, r_xe); }
    let h11 = dot3(r_xi, r_xi); let h12 = dot3(r_xi, r_eta) + coupling; let h22 = dot3(r_eta, r_eta);
    let g1 = dot3(r_xi, gap); let g2 = dot3(r_eta, gap);
    let det = h11 * h22 - h12 * h12;
    if (det == 0.0lf || !(abs(det) < 1.0e300lf)) { return out; }
    let d_xi = -(h22 * g1 - h12 * g2) / det;
    let d_eta = -(h11 * g2 - h12 * g1) / det;
    xi = xi + d_xi;
    eta = eta + d_eta;
    if (iteration >= 3u && abs(d_xi) + abs(d_eta) < 1.0e-12lf) { break; }
  }
  var r_xi = vec3<f64>(0.0lf, 0.0lf, 0.0lf); var r_eta = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
  for (var k = 0u; k < 4u; k = k + 1u) {
    let a = NAT_A[k]; let b = NAT_B[k];
    r_xi = vec3<f64>(r_xi.x + 0.25lf * a * (1.0lf + b * eta) * p[k].x, r_xi.y + 0.25lf * a * (1.0lf + b * eta) * p[k].y, r_xi.z + 0.25lf * a * (1.0lf + b * eta) * p[k].z);
    r_eta = vec3<f64>(r_eta.x + 0.25lf * b * (1.0lf + a * xi) * p[k].x, r_eta.y + 0.25lf * b * (1.0lf + a * xi) * p[k].y, r_eta.z + 0.25lf * b * (1.0lf + a * xi) * p[k].z);
  }
  let n = cross3(r_xi, r_eta);
  let length = sqrt(dot3(n, n));
  if (length == 0.0lf || !(abs(xi) < 1.0e300lf) || !(abs(eta) < 1.0e300lf)) { return out; }
  out.xi = xi;
  out.eta = eta;
  out.r = seg_evaluate(s, xi, eta);
  out.n = vec3<f64>(n.x / length, n.y / length, n.z / length);
  out.ok = true;
  return out;
}

fn seg_inside(count: u32, xi: f64, eta: f64) -> bool {
  if (count == 3u) {
    let slack = MAXPAR - 1.0lf;
    return xi >= -slack && eta >= -slack && xi + eta <= 1.0lf + slack;
  }
  return abs(xi) <= MAXPAR && abs(eta) <= MAXPAR;
}

fn tangent_of(v: vec3<f64>, n: vec3<f64>) -> vec3<f64> {
  let along = dot3(v, n);
  return vec3<f64>(v.x - along * n.x, v.y - along * n.y, v.z - along * n.z);
}

// ---------------------------------------------------------------- one slave: selection, penalty, friction (contact.rs forces)
@compute @workgroup_size(64)
fn contact_slave(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let g = linear_id(wid, lid);
  if (g >= shell_counts.slaves) { return; }
  let node = slaves[4u * g];
  let pass_index = slaves[4u * g + 1u];
  let first = slaves[4u * g + 2u];
  let count = slaves[4u * g + 3u];
  let t = node_point(false, node);
  let previous = slave_state[6u * g];
  let slave_half = slave_data[2u * g + 1u];
  var found = false;
  var best_s = 0u; var best_xi = 0.0lf; var best_eta = 0.0lf; var best_n = vec3<f64>(0.0lf, 0.0lf, 0.0lf); var best_l = 0.0lf;
  for (var c = first; c < first + count; c = c + 1u) {
    let s = candidates[c];
    let pr = seg_project(s, t);
    if (!pr.ok) { continue; }
    if (!seg_inside(seg_count(s), pr.xi, pr.eta)) { continue; }
    let gap = dot3(pr.n, sub3(t, pr.r));
    let half = seg_data[3u * s + 2u];
    var l = 0.0lf; var n = pr.n; var depth = 0.0lf;
    if (half > 0.0lf) {
      let reach = half + slave_half;
      l = abs(gap) - reach;
      if (gap < 0.0lf) { n = vec3<f64>(-n.x, -n.y, -n.z); }
      depth = reach;
    } else {
      l = gap - slave_half;
      depth = seg_data[3u * s + 1u] + slave_half;
    }
    if (!(l < -ROUND_OFF * depth && l > -depth)) { continue; }
    let kept = previous >= 0.0lf && u32(previous) == s;
    let current_kept = found && previous >= 0.0lf && u32(previous) == best_s;
    if (kept || (!current_kept && (!found || abs(l) < abs(best_l)))) {
      found = true; best_s = s; best_xi = pr.xi; best_eta = pr.eta; best_n = n; best_l = l;
    }
  }
  if (!found) {
    for (var k = 0u; k < 6u; k = k + 1u) { slave_state[6u * g + k] = 0.0lf; }
    slave_state[6u * g] = -1.0lf;
    for (var k = 0u; k < 8u; k = k + 1u) { slave_out[8u * g + k] = 0.0lf; }
    slave_out[8u * g + 3u] = -1.0lf;
    return;
  }
  let scale = pass_data[4u * pass_index];
  let mu_s = pass_data[4u * pass_index + 1u];
  let mu_d = pass_data[4u * pass_index + 2u];
  let decay = pass_data[4u * pass_index + 3u];
  let k_pen = min(scale * seg_data[3u * best_s], slave_data[2u * g]);
  let normal_force = -best_l * k_pen;
  var total = vec3<f64>(best_n.x * normal_force, best_n.y * normal_force, best_n.z * normal_force);
  if (mu_s > 0.0lf || mu_d > 0.0lf) {
    let current = seg_evaluate(best_s, best_xi, best_eta);
    var slip = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
    if (previous >= 0.0lf) { slip = sub3(current, seg_evaluate(u32(previous), slave_state[6u * g + 1u], slave_state[6u * g + 2u])); }
    slip = tangent_of(slip, best_n);
    let old = tangent_of(vec3<f64>(slave_state[6u * g + 3u], slave_state[6u * g + 4u], slave_state[6u * g + 5u]), best_n);
    let trial = vec3<f64>(old.x - k_pen * slip.x, old.y - k_pen * slip.y, old.z - k_pen * slip.z);
    let dt = scalars[0];
    var speed = 0.0lf;
    if (dt > 0.0lf) { speed = sqrt(dot3(slip, slip)) / dt; }
    let mu = mu_d + (mu_s - mu_d) * exp_f(-decay * speed);
    let limit = mu * abs(normal_force);
    let size = sqrt(dot3(trial, trial));
    var tangential = trial;
    if (size > limit && size > 0.0lf) { tangential = vec3<f64>(limit * trial.x / size, limit * trial.y / size, limit * trial.z / size); }
    slave_state[6u * g + 3u] = tangential.x; slave_state[6u * g + 4u] = tangential.y; slave_state[6u * g + 5u] = tangential.z;
    total = vec3<f64>(total.x + tangential.x, total.y + tangential.y, total.z + tangential.z);
  }
  slave_state[6u * g] = f64(best_s);
  slave_state[6u * g + 1u] = best_xi;
  slave_state[6u * g + 2u] = best_eta;
  let w = seg_shape(seg_count(best_s), best_xi, best_eta);
  slave_out[8u * g] = total.x; slave_out[8u * g + 1u] = total.y; slave_out[8u * g + 2u] = total.z;
  slave_out[8u * g + 3u] = f64(best_s);
  for (var k = 0u; k < 4u; k = k + 1u) { slave_out[8u * g + 4u + k] = w[k]; }
}

// ---------------------------------------------------------------- contact forces by node, in the CPU accumulation order
@compute @workgroup_size(64)
fn contact_gather(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  var acc = array<f64, 3>(0.0lf, 0.0lf, 0.0lf);
  for (var j = cgather_start[i]; j < cgather_start[i + 1u]; j = j + 1u) {
    let g = cgather[3u * j];
    let s = cgather[3u * j + 1u];
    let local_index = cgather[3u * j + 2u];
    let selected = slave_out[8u * g + 3u];
    if (selected < 0.0lf) { continue; }
    if (local_index == 4u) {
      for (var c = 0u; c < 3u; c = c + 1u) { acc[c] = acc[c] + slave_out[8u * g + c]; }
    } else if (u32(selected) == s) {
      let w = slave_out[8u * g + 4u + local_index];
      for (var c = 0u; c < 3u; c = c + 1u) { acc[c] = acc[c] - w * slave_out[8u * g + c]; }
    }
  }
  for (var c = 0u; c < 3u; c = c + 1u) { contact_force[3u * i + c] = acc[c]; }
}
