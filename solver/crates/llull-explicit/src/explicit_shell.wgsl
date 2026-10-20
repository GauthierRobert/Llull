// llull-explicit GPU kernels for the Belytschko–Tsay / Belytschko–Wong–Chiang shells (RS-8): shell.rs, bwc.rs, projection.rs and the
// shells.rs driver line for line, in f64. Appended to explicit.wgsl (shares its bindings, materials and update_point). No atomics: per-node
// gathers run over a fixed, shell-ordered incidence.

struct ShellCounts { shells: u32, points: u32, warping: u32, solids: u32, slaves: u32, passes: u32, entries: u32, pad: u32 };

@group(1) @binding(0) var<uniform> shell_counts: ShellCounts;
// 4 node indices per shell
@group(1) @binding(1) var<storage, read> shell_nodes: array<u32>;
// per shell: thickness, material
@group(1) @binding(2) var<storage, read> shell_info: array<f64>;
// per shell: points x [stress (6), plastic strain, damage, failed, temperature], then hourglass (5)
@group(1) @binding(3) var<storage, read_write> shell_state: array<f64>;
// angular velocity at n+1/2 (3 per node) and its value before this cycle's kick
@group(1) @binding(4) var<storage, read_write> omega: array<f64>;
@group(1) @binding(5) var<storage, read_write> omega_prev: array<f64>;
// rotary inertia per node (0 without a shell)
@group(1) @binding(6) var<storage, read> inertia: array<f64>;
// 1 per rotational dof: held at 0
@group(1) @binding(7) var<storage, read> fixed_rotation: array<u32>;
// 12 per shell: nodal moments (internal side)
@group(1) @binding(8) var<storage, read_write> shell_moment: array<f64>;
// 3 per node: gathered moments
@group(1) @binding(9) var<storage, read_write> moments: array<f64>;
// 3 per shell: diagonal cross product of the mid-step quad; 3 per node: unit nodal normal
@group(1) @binding(10) var<storage, read_write> shell_normal: array<f64>;
@group(1) @binding(11) var<storage, read_write> normals: array<f64>;
// node -> shell slots (4 s + k), in shell order
@group(1) @binding(12) var<storage, read> shell_start: array<u32>;
@group(1) @binding(13) var<storage, read> shell_incidence: array<u32>;

const SHELL_HOURGLASS: f64 = 0.1lf;
const SHEAR_FACTOR: f64 = 0.8333333333333334lf;

fn sub3(a: vec3<f64>, b: vec3<f64>) -> vec3<f64> { return vec3<f64>(a.x - b.x, a.y - b.y, a.z - b.z); }
fn dot3(a: vec3<f64>, b: vec3<f64>) -> f64 { return a.x * b.x + a.y * b.y + a.z * b.z; }
fn unit3(a: vec3<f64>) -> vec3<f64> {
  let length = sqrt(dot3(a, a));
  return vec3<f64>(a.x / length, a.y / length, a.z / length);
}
fn node_point(buffer_is_new: bool, n: u32) -> vec3<f64> {
  if (buffer_is_new) { return vec3<f64>(x_new[3u * n], x_new[3u * n + 1u], x_new[3u * n + 2u]); }
  return vec3<f64>(x[3u * n], x[3u * n + 1u], x[3u * n + 2u]);
}

struct Frame { e1: vec3<f64>, e2: vec3<f64>, e3: vec3<f64> };

fn shell_frame(c: array<vec3<f64>, 4>) -> Frame {
  let e3 = unit3(cross3(sub3(c[2], c[0]), sub3(c[3], c[1])));
  let r21 = sub3(c[1], c[0]);
  let along = dot3(r21, e3);
  let e1 = unit3(vec3<f64>(r21.x - along * e3.x, r21.y - along * e3.y, r21.z - along * e3.z));
  return Frame(e1, cross3(e3, e1), e3);
}
fn to_local(f: Frame, v: vec3<f64>) -> vec3<f64> { return vec3<f64>(dot3(f.e1, v), dot3(f.e2, v), dot3(f.e3, v)); }
fn to_global(f: Frame, v: vec3<f64>) -> vec3<f64> {
  return vec3<f64>(f.e1.x * v.x + f.e2.x * v.y + f.e3.x * v.z, f.e1.y * v.x + f.e2.y * v.y + f.e3.y * v.z, f.e1.z * v.x + f.e2.z * v.y + f.e3.z * v.z);
}

struct Grad { b1: array<f64, 4>, b2: array<f64, 4>, area: f64 };

const NAT_A = array<f64, 4>(-1.0lf, 1.0lf, 1.0lf, -1.0lf);
const NAT_B = array<f64, 4>(-1.0lf, -1.0lf, 1.0lf, 1.0lf);
const HG = array<f64, 4>(1.0lf, -1.0lf, 1.0lf, -1.0lf);

// shell.rs gradients
fn shell_gradients(px: array<f64, 4>, py: array<f64, 4>) -> Grad {
  var x_xi = 0.0lf; var x_eta = 0.0lf; var y_xi = 0.0lf; var y_eta = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) {
    x_xi = x_xi + 0.25lf * NAT_A[k] * px[k];
    y_xi = y_xi + 0.25lf * NAT_A[k] * py[k];
    x_eta = x_eta + 0.25lf * NAT_B[k] * px[k];
    y_eta = y_eta + 0.25lf * NAT_B[k] * py[k];
  }
  let det = x_xi * y_eta - x_eta * y_xi;
  var g: Grad;
  for (var k = 0u; k < 4u; k = k + 1u) {
    g.b1[k] = (y_eta * 0.25lf * NAT_A[k] - y_xi * 0.25lf * NAT_B[k]) / det;
    g.b2[k] = (-x_eta * 0.25lf * NAT_A[k] + x_xi * 0.25lf * NAT_B[k]) / det;
  }
  g.area = 4.0lf * det;
  return g;
}

// bwc.rs fiber_gradients
fn shell_fiber_gradients(px: array<f64, 4>, py: array<f64, 4>, qx: array<f64, 4>, qy: array<f64, 4>) -> Grad {
  var x_xi = 0.0lf; var x_eta = 0.0lf; var y_xi = 0.0lf; var y_eta = 0.0lf;
  var dx_xi = 0.0lf; var dx_eta = 0.0lf; var dy_xi = 0.0lf; var dy_eta = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) {
    x_xi = x_xi + 0.25lf * NAT_A[k] * px[k];
    y_xi = y_xi + 0.25lf * NAT_A[k] * py[k];
    x_eta = x_eta + 0.25lf * NAT_B[k] * px[k];
    y_eta = y_eta + 0.25lf * NAT_B[k] * py[k];
    dx_xi = dx_xi + 0.25lf * NAT_A[k] * qx[k];
    dy_xi = dy_xi + 0.25lf * NAT_A[k] * qy[k];
    dx_eta = dx_eta + 0.25lf * NAT_B[k] * qx[k];
    dy_eta = dy_eta + 0.25lf * NAT_B[k] * qy[k];
  }
  let det = x_xi * y_eta - x_eta * y_xi;
  let d_det = dx_xi * y_eta + x_xi * dy_eta - dx_eta * y_xi - x_eta * dy_xi;
  var g: Grad;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let b1 = (y_eta * 0.25lf * NAT_A[k] - y_xi * 0.25lf * NAT_B[k]) / det;
    let b2 = (-x_eta * 0.25lf * NAT_A[k] + x_xi * 0.25lf * NAT_B[k]) / det;
    g.b1[k] = (dy_eta * 0.25lf * NAT_A[k] - dy_xi * 0.25lf * NAT_B[k]) / det - b1 * d_det / det;
    g.b2[k] = (-dx_eta * 0.25lf * NAT_A[k] + dx_xi * 0.25lf * NAT_B[k]) / det - b2 * d_det / det;
  }
  g.area = 0.0lf;
  return g;
}

// bwc.rs edge_shear: two rows over u = [w_k, θx_k, θy_k]
fn shell_edge_shear(px: array<f64, 4>, py: array<f64, 4>) -> array<array<f64, 12>, 2> {
  var tx: array<f64, 4>; var ty: array<f64, 4>; var rows: array<array<f64, 12>, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let j = (k + 1u) % 4u;
    let dx = px[j] - px[k];
    let dy = py[j] - py[k];
    let length = sqrt(dx * dx + dy * dy);
    tx[k] = dx / length;
    ty[k] = dy / length;
    var row: array<f64, 12>;
    for (var i = 0u; i < 12u; i = i + 1u) { row[i] = 0.0lf; }
    row[3u * k] = row[3u * k] - 1.0lf / length;
    row[3u * j] = row[3u * j] + 1.0lf / length;
    row[3u * k + 2u] = row[3u * k + 2u] + 0.5lf * tx[k];
    row[3u * k + 1u] = row[3u * k + 1u] - 0.5lf * ty[k];
    row[3u * j + 2u] = row[3u * j + 2u] + 0.5lf * tx[k];
    row[3u * j + 1u] = row[3u * j + 1u] - 0.5lf * ty[k];
    rows[k] = row;
  }
  var centre: array<array<f64, 12>, 2>;
  for (var i = 0u; i < 12u; i = i + 1u) { centre[0][i] = 0.0lf; centre[1][i] = 0.0lf; }
  for (var k = 0u; k < 4u; k = k + 1u) {
    let o = (k + 3u) % 4u;
    let det = tx[k] * ty[o] - ty[k] * tx[o];
    for (var i = 0u; i < 12u; i = i + 1u) {
      let gx = (ty[o] * rows[k][i] - ty[k] * rows[o][i]) / det;
      let gy = (-tx[o] * rows[k][i] + tx[k] * rows[o][i]) / det;
      centre[0][i] = centre[0][i] + 0.25lf * gx;
      centre[1][i] = centre[1][i] + 0.25lf * gy;
    }
  }
  return centre;
}

// projection.rs: P = I − R (RᵀR)⁻¹ Rᵀ on the 24 nodal components (per node: 3 translations, 3 rotations).
struct Projector { modes: array<array<f64, 24>, 7>, inverse: array<array<f64, 7>, 7> };

fn shell_projector(xl: array<vec3<f64>, 4>, nl: array<vec3<f64>, 4>) -> Projector {
  var pr: Projector;
  for (var m = 0u; m < 7u; m = m + 1u) { for (var i = 0u; i < 24u; i = i + 1u) { pr.modes[m][i] = 0.0lf; } }
  for (var a = 0u; a < 3u; a = a + 1u) {
    var axis = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
    if (a == 0u) { axis.x = 1.0lf; } else if (a == 1u) { axis.y = 1.0lf; } else { axis.z = 1.0lf; }
    for (var k = 0u; k < 4u; k = k + 1u) {
      let t = cross3(axis, xl[k]);
      pr.modes[a][6u * k] = t.x; pr.modes[a][6u * k + 1u] = t.y; pr.modes[a][6u * k + 2u] = t.z;
      pr.modes[a][6u * k + 3u] = axis.x; pr.modes[a][6u * k + 4u] = axis.y; pr.modes[a][6u * k + 5u] = axis.z;
    }
  }
  for (var k = 0u; k < 4u; k = k + 1u) {
    pr.modes[3u + k][6u * k + 3u] = nl[k].x; pr.modes[3u + k][6u * k + 4u] = nl[k].y; pr.modes[3u + k][6u * k + 5u] = nl[k].z;
  }
  var a: array<array<f64, 7>, 7>;
  var inv: array<array<f64, 7>, 7>;
  for (var i = 0u; i < 7u; i = i + 1u) {
    for (var j = 0u; j < 7u; j = j + 1u) {
      var s = 0.0lf;
      for (var k = 0u; k < 24u; k = k + 1u) { s = s + pr.modes[i][k] * pr.modes[j][k]; }
      a[i][j] = s;
      inv[i][j] = select(0.0lf, 1.0lf, i == j);
    }
  }
  for (var col = 0u; col < 7u; col = col + 1u) {
    var pivot = col;
    for (var r = col + 1u; r < 7u; r = r + 1u) { if (abs(a[r][col]) > abs(a[pivot][col])) { pivot = r; } }
    let ta = a[col]; a[col] = a[pivot]; a[pivot] = ta;
    let ti = inv[col]; inv[col] = inv[pivot]; inv[pivot] = ti;
    let d = a[col][col];
    for (var j = 0u; j < 7u; j = j + 1u) { a[col][j] = a[col][j] / d; inv[col][j] = inv[col][j] / d; }
    for (var r = 0u; r < 7u; r = r + 1u) {
      if (r != col) {
        let factor = a[r][col];
        for (var j = 0u; j < 7u; j = j + 1u) { a[r][j] = a[r][j] - factor * a[col][j]; inv[r][j] = inv[r][j] - factor * inv[col][j]; }
      }
    }
  }
  pr.inverse = inv;
  return pr;
}

fn shell_project(pr: Projector, u: array<f64, 24>) -> array<f64, 24> {
  var rtu: array<f64, 7>;
  for (var i = 0u; i < 7u; i = i + 1u) {
    var s = 0.0lf;
    for (var k = 0u; k < 24u; k = k + 1u) { s = s + pr.modes[i][k] * u[k]; }
    rtu[i] = s;
  }
  var c: array<f64, 7>;
  for (var i = 0u; i < 7u; i = i + 1u) {
    var s = 0.0lf;
    for (var j = 0u; j < 7u; j = j + 1u) { s = s + pr.inverse[i][j] * rtu[j]; }
    c[i] = s;
  }
  var out: array<f64, 24>;
  for (var k = 0u; k < 24u; k = k + 1u) {
    var s = 0.0lf;
    for (var i = 0u; i < 7u; i = i + 1u) { s = s + pr.modes[i][k] * c[i]; }
    out[k] = u[k] - s;
  }
  return out;
}

// shell.rs thickness_points (point index -> (ẑ, weight))
fn thickness_point(points: u32, index: u32, thickness: f64) -> vec2<f64> {
  let half = 0.5lf * thickness;
  var xi = 0.0lf;
  var w = 2.0lf;
  if (points == 2u) {
    xi = select(-0.5773502691896258lf, 0.5773502691896258lf, index == 1u); w = 1.0lf;
  } else if (points == 3u) {
    let xs = array<f64, 3>(-0.7745966692414834lf, 0.0lf, 0.7745966692414834lf);
    let ws = array<f64, 3>(0.5555555555555556lf, 0.8888888888888888lf, 0.5555555555555556lf);
    xi = xs[index]; w = ws[index];
  } else if (points == 4u) {
    let xs = array<f64, 4>(-0.8611363115940526lf, -0.3399810435848563lf, 0.3399810435848563lf, 0.8611363115940526lf);
    let ws = array<f64, 4>(0.3478548451374539lf, 0.6521451548625461lf, 0.6521451548625461lf, 0.3478548451374539lf);
    xi = xs[index]; w = ws[index];
  } else if (points >= 5u) {
    let xs = array<f64, 5>(-0.906179845938664lf, -0.5384693101056831lf, 0.0lf, 0.5384693101056831lf, 0.906179845938664lf);
    let ws = array<f64, 5>(0.2369268850561891lf, 0.4786286704993665lf, 0.5688888888888889lf, 0.4786286704993665lf, 0.2369268850561891lf);
    xi = xs[index]; w = ws[index];
  }
  return vec2<f64>(xi * half, w * half);
}

// shell.rs plane_stress
fn plane_stress_with(mat: u32, old: Point, d: array<f64, 6>, dzz: f64, dt: f64) -> Point {
  var rate = d;
  rate[2] = dzz;
  return update_point(mat, old, rate, vec3<f64>(0.0lf, 0.0lf, 0.0lf), dt);
}

fn plane_stress(mat: u32, old: Point, d: array<f64, 6>, dt: f64) -> Point {
  let base = 26u * mat;
  let lambda = materials[base + 3u];
  let mu = materials[base + 4u];
  let elastic = -(old.stress[2] / dt + lambda * (d[0] + d[1])) / (lambda + 2.0lf * mu);
  let first = plane_stress_with(mat, old, d, elastic, dt);
  if (materials[base + 6u] < 0.5lf || first.eps == old.eps) { return first; }
  var a = elastic;
  var b = -(d[0] + d[1]);
  var fa = first.stress[2];
  var fb = plane_stress_with(mat, old, d, b, dt).stress[2];
  for (var it = 0u; it < 10u; it = it + 1u) {
    if (fb == fa) { break; }
    let next = b - (b - a) / (fb - fa) * fb;
    a = b;
    fa = fb;
    b = next;
    fb = plane_stress_with(mat, old, d, b, dt).stress[2];
    if (abs(b - a) <= 1.0e-4lf * max(abs(b), 1.0e-30lf)) { break; }
  }
  return plane_stress_with(mat, old, d, b, dt);
}

// ---------------------------------------------------------------- shell_kick: angular velocities (shells.rs kick)
@compute @workgroup_size(64)
fn shell_kick(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  let dtp = scalars[0];
  let dt = scalars[1];
  for (var c = 0u; c < 3u; c = c + 1u) {
    let k = 3u * i + c;
    omega_prev[k] = omega[k];
    var w = omega[k];
    if (inertia[i] > 0.0lf) { w = w - 0.5lf * (dtp + dt) * moments[k] / inertia[i]; }
    if (fixed_rotation[k] != 0u) { w = 0.0lf; }
    omega[k] = w;
  }
}

// ---------------------------------------------------------------- nodal normals of the mid-step surface (shells.rs nodal_normals)
@compute @workgroup_size(64)
fn shell_normals(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let s = linear_id(wid, lid);
  if (s >= shell_counts.shells) { return; }
  var p: array<vec3<f64>, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let n = shell_nodes[4u * s + k];
    for (var c = 0u; c < 3u; c = c + 1u) { p[k][c] = 0.5lf * (x[3u * n + c] + x_new[3u * n + c]); }
  }
  let normal = cross3(sub3(p[2], p[0]), sub3(p[3], p[1]));
  shell_normal[3u * s] = normal.x; shell_normal[3u * s + 1u] = normal.y; shell_normal[3u * s + 2u] = normal.z;
}

@compute @workgroup_size(64)
fn node_normals(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  var acc = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
  for (var j = shell_start[i]; j < shell_start[i + 1u]; j = j + 1u) {
    let s = shell_incidence[j] / 4u;
    acc.x = acc.x + shell_normal[3u * s]; acc.y = acc.y + shell_normal[3u * s + 1u]; acc.z = acc.z + shell_normal[3u * s + 2u];
  }
  let length = sqrt(dot3(acc, acc));
  if (length > 0.0lf) { acc = vec3<f64>(acc.x / length, acc.y / length, acc.z / length); }
  normals[3u * i] = acc.x; normals[3u * i + 1u] = acc.y; normals[3u * i + 2u] = acc.z;
}

// ---------------------------------------------------------------- one step of every shell (shell.rs step)
@compute @workgroup_size(64)
fn shell_step(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let s = linear_id(wid, lid);
  if (s >= shell_counts.shells) { return; }
  let dt = scalars[1];
  let thickness = shell_info[2u * s];
  let mat = u32(shell_info[2u * s + 1u]);
  let points = shell_counts.points;
  let stride = 10u * points + 5u;
  let base = stride * s;
  let slot = shell_counts.solids + s;
  var all_failed = true;
  for (var q = 0u; q < points; q = q + 1u) { if (shell_state[base + 10u * q + 8u] < 0.5lf) { all_failed = false; } }
  if (all_failed) {
    for (var k = 0u; k < 24u; k = k + 1u) { elem_force[24u * slot + k] = 0.0lf; }
    for (var k = 0u; k < 12u; k = k + 1u) { shell_moment[12u * s + k] = 0.0lf; }
    elem_energy[3u * slot + 2u] = BIG;
    return;
  }
  var nodes: array<u32, 4>;
  var mid: array<vec3<f64>, 4>;
  var p_end: array<vec3<f64>, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let n = shell_nodes[4u * s + k];
    nodes[k] = n;
    p_end[k] = node_point(true, n);
    let p_start = node_point(false, n);
    mid[k] = vec3<f64>(0.5lf * (p_start.x + p_end[k].x), 0.5lf * (p_start.y + p_end[k].y), 0.5lf * (p_start.z + p_end[k].z));
  }
  let f = shell_frame(mid);
  var px: array<f64, 4>; var py: array<f64, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let l = to_local(f, sub3(mid[k], mid[0]));
    px[k] = l.x; py[k] = l.y;
  }
  let g = shell_gradients(px, py);
  let b1 = g.b1; let b2 = g.b2; let area = g.area;
  var vl: array<vec3<f64>, 4>; var tl: array<vec3<f64>, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let n = nodes[k];
    vl[k] = to_local(f, vec3<f64>(v_new[3u * n], v_new[3u * n + 1u], v_new[3u * n + 2u]));
    tl[k] = to_local(f, vec3<f64>(omega[3u * n], omega[3u * n + 1u], omega[3u * n + 2u]));
  }
  let warping = shell_counts.warping != 0u;
  var fibers: array<vec3<f64>, 4>;
  var pr: Projector;
  if (warping) {
    var centre = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
    for (var k = 0u; k < 4u; k = k + 1u) { centre.x = centre.x + mid[k].x; centre.y = centre.y + mid[k].y; centre.z = centre.z + mid[k].z; }
    centre = vec3<f64>(0.25lf * centre.x, 0.25lf * centre.y, 0.25lf * centre.z);
    var xl: array<vec3<f64>, 4>;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let n = nodes[k];
      xl[k] = to_local(f, sub3(mid[k], centre));
      fibers[k] = to_local(f, vec3<f64>(normals[3u * n], normals[3u * n + 1u], normals[3u * n + 2u]));
    }
    pr = shell_projector(xl, fibers);
    var u: array<f64, 24>;
    for (var k = 0u; k < 4u; k = k + 1u) {
      u[6u * k] = vl[k].x; u[6u * k + 1u] = vl[k].y; u[6u * k + 2u] = vl[k].z;
      u[6u * k + 3u] = tl[k].x; u[6u * k + 4u] = tl[k].y; u[6u * k + 5u] = tl[k].z;
    }
    let pu = shell_project(pr, u);
    for (var k = 0u; k < 4u; k = k + 1u) {
      vl[k] = vec3<f64>(pu[6u * k], pu[6u * k + 1u], pu[6u * k + 2u]);
      tl[k] = vec3<f64>(pu[6u * k + 3u], pu[6u * k + 4u], pu[6u * k + 5u]);
    }
  } else {
    for (var k = 0u; k < 4u; k = k + 1u) { fibers[k] = vec3<f64>(0.0lf, 0.0lf, 1.0lf); }
  }
  var c1: array<f64, 4>; var c2: array<f64, 4>;
  var shear_rows: array<array<f64, 12>, 2>;
  if (warping) {
    var qx: array<f64, 4>; var qy: array<f64, 4>;
    for (var k = 0u; k < 4u; k = k + 1u) { qx[k] = fibers[k].x; qy[k] = fibers[k].y; }
    let fg = shell_fiber_gradients(px, py, qx, qy);
    c1 = fg.b1; c2 = fg.b2;
    shear_rows = shell_edge_shear(px, py);
  } else {
    for (var k = 0u; k < 4u; k = k + 1u) { c1[k] = 0.0lf; c2[k] = 0.0lf; }
  }
  var pdot: array<vec3<f64>, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) { pdot[k] = cross3(tl[k], fibers[k]); }
  var membrane = array<f64, 3>(0.0lf, 0.0lf, 0.0lf);
  var bending = array<f64, 3>(0.0lf, 0.0lf, 0.0lf);
  for (var k = 0u; k < 4u; k = k + 1u) { membrane[0] = membrane[0] + b1[k] * vl[k].x; }
  for (var k = 0u; k < 4u; k = k + 1u) { membrane[1] = membrane[1] + b2[k] * vl[k].y; }
  var m2a = 0.0lf; var m2b = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) { m2a = m2a + b2[k] * vl[k].x; m2b = m2b + b1[k] * vl[k].y; }
  membrane[2] = m2a + m2b;
  var t0 = 0.0lf; var t1 = 0.0lf; var t2 = 0.0lf; var t3 = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) { t0 = t0 + c1[k] * vl[k].x; t1 = t1 + b1[k] * pdot[k].x; }
  bending[0] = t0 + t1;
  t0 = 0.0lf; t1 = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) { t0 = t0 + c2[k] * vl[k].y; t1 = t1 + b2[k] * pdot[k].y; }
  bending[1] = t0 + t1;
  t0 = 0.0lf; t1 = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) {
    t0 = t0 + c1[k] * vl[k].y; t1 = t1 + b1[k] * pdot[k].y; t2 = t2 + c2[k] * vl[k].x; t3 = t3 + b2[k] * pdot[k].x;
  }
  bending[2] = t0 + t1 + t2 + t3;
  var shear_xz = 0.0lf; var shear_yz = 0.0lf;
  if (warping) {
    for (var r = 0u; r < 2u; r = r + 1u) {
      var acc = 0.0lf;
      for (var k = 0u; k < 4u; k = k + 1u) {
        acc = acc + shear_rows[r][3u * k] * vl[k].z + shear_rows[r][3u * k + 1u] * tl[k].x + shear_rows[r][3u * k + 2u] * tl[k].y;
      }
      if (r == 0u) { shear_xz = acc; } else { shear_yz = acc; }
    }
  } else {
    var sw1 = 0.0lf; var sw2 = 0.0lf; var sy = 0.0lf; var sx = 0.0lf;
    for (var k = 0u; k < 4u; k = k + 1u) { sw1 = sw1 + b1[k] * vl[k].z; sw2 = sw2 + b2[k] * vl[k].z; sy = sy + tl[k].y; sx = sx + tl[k].x; }
    shear_xz = sw1 + 0.25lf * sy;
    shear_yz = sw2 - 0.25lf * sx;
  }
  var fr = array<f64, 5>(0.0lf, 0.0lf, 0.0lf, 0.0lf, 0.0lf);
  var mr = array<f64, 3>(0.0lf, 0.0lf, 0.0lf);
  var work = 0.0lf;
  for (var q = 0u; q < points; q = q + 1u) {
    let zw = thickness_point(points, q, thickness);
    let z = zw.x;
    let weight = zw.y;
    let d = array<f64, 6>(
      membrane[0] + z * bending[0],
      membrane[1] + z * bending[1],
      0.0lf,
      0.5lf * (membrane[2] + z * bending[2]),
      0.5lf * shear_yz,
      0.5lf * shear_xz,
    );
    let at = base + 10u * q;
    var old: Point;
    for (var k = 0u; k < 6u; k = k + 1u) { old.stress[k] = shell_state[at + k]; }
    old.eps = shell_state[at + 6u];
    old.damage = shell_state[at + 7u];
    old.failed = shell_state[at + 8u];
    old.temperature = shell_state[at + 9u];
    let updated = plane_stress(mat, old, d, dt);
    let st = updated.stress;
    var power = 0.0lf;
    for (var k = 0u; k < 3u; k = k + 1u) { power = power + 0.5lf * (old.stress[k] + st[k]) * d[k]; }
    var shear_power = 0.0lf;
    for (var k = 3u; k < 6u; k = k + 1u) { shear_power = shear_power + 0.5lf * (old.stress[k] + st[k]) * d[k]; }
    power = power + 2.0lf * shear_power;
    work = work + weight * power * area * dt;
    fr = array<f64, 5>(fr[0] + weight * st[0], fr[1] + weight * st[1], fr[2] + weight * st[3], fr[3] + weight * st[5], fr[4] + weight * st[4]);
    mr = array<f64, 3>(mr[0] - weight * z * st[0], mr[1] - weight * z * st[1], mr[2] - weight * z * st[3]);
    for (var k = 0u; k < 6u; k = k + 1u) { shell_state[at + k] = st[k]; }
    shell_state[at + 6u] = updated.eps;
    shell_state[at + 7u] = updated.damage;
    shell_state[at + 8u] = updated.failed;
    shell_state[at + 9u] = updated.temperature;
  }
  let fxx = fr[0]; let fyy = fr[1]; let fxy = fr[2]; let fxz = fr[3]; let fyz = fr[4];
  let sxx = -mr[0]; let syy = -mr[1]; let sxy = -mr[2];
  let kappa = SHEAR_FACTOR;
  var force_local: array<vec3<f64>, 4>;
  var moment_local: array<vec3<f64>, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let cv = vec3<f64>(sxx * b1[k] + sxy * b2[k], syy * b2[k] + sxy * b1[k], 0.0lf);
    let bend = cross3(fibers[k], cv);
    var shear_force = 0.0lf;
    var shear_mx = 0.0lf;
    var shear_my = 0.0lf;
    if (warping) {
      shear_force = kappa * (shear_rows[0][3u * k] * fxz + shear_rows[1][3u * k] * fyz);
      shear_mx = kappa * (shear_rows[0][3u * k + 1u] * fxz + shear_rows[1][3u * k + 1u] * fyz);
      shear_my = kappa * (shear_rows[0][3u * k + 2u] * fxz + shear_rows[1][3u * k + 2u] * fyz);
    } else {
      shear_force = kappa * (b1[k] * fxz + b2[k] * fyz);
      shear_mx = -kappa / 4.0lf * fyz;
      shear_my = kappa / 4.0lf * fxz;
    }
    force_local[k] = vec3<f64>(
      area * (b1[k] * fxx + b2[k] * fxy + c1[k] * sxx + c2[k] * sxy),
      area * (b2[k] * fyy + b1[k] * fxy + c2[k] * syy + c1[k] * sxy),
      area * shear_force,
    );
    moment_local[k] = vec3<f64>(area * (bend.x + shear_mx), area * (bend.y + shear_my), area * bend.z);
  }
  // Belytschko-Tsay hourglass (Eqs. 9.31-9.42)
  var proj = array<f64, 2>(0.0lf, 0.0lf);
  for (var k = 0u; k < 4u; k = k + 1u) { proj[0] = proj[0] + HG[k] * px[k]; }
  for (var k = 0u; k < 4u; k = k + 1u) { proj[1] = proj[1] + HG[k] * py[k]; }
  var tau: array<f64, 4>;
  for (var k = 0u; k < 4u; k = k + 1u) { tau[k] = HG[k] - (proj[0] * b1[k] + proj[1] * b2[k]); }
  var bb = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) { bb = bb + (b1[k] * b1[k] + b2[k] * b2[k]); }
  let mbase = 26u * mat;
  let e = materials[mbase + 1u];
  let gm = materials[mbase + 4u];
  let t = thickness;
  var rates = array<f64, 5>(0.0lf, 0.0lf, 0.0lf, 0.0lf, 0.0lf);
  for (var k = 0u; k < 4u; k = k + 1u) { rates[0] = rates[0] + tau[k] * tl[k].x; }
  for (var k = 0u; k < 4u; k = k + 1u) { rates[1] = rates[1] + tau[k] * tl[k].y; }
  for (var k = 0u; k < 4u; k = k + 1u) { rates[2] = rates[2] + tau[k] * vl[k].z; }
  for (var k = 0u; k < 4u; k = k + 1u) { rates[3] = rates[3] + tau[k] * vl[k].x; }
  for (var k = 0u; k < 4u; k = k + 1u) { rates[4] = rates[4] + tau[k] * vl[k].y; }
  let thick3 = t * t * t;
  let bending_scale = SHELL_HOURGLASS * e * thick3 * area / 192.0lf * bb;
  let warping_scale = SHELL_HOURGLASS * kappa * gm * thick3 * area / 12.0lf * bb;
  let membrane_scale = SHELL_HOURGLASS * e * t * area / 8.0lf * bb;
  let scales = array<f64, 5>(bending_scale, bending_scale, warping_scale, membrane_scale, membrane_scale);
  var hourglass_power = 0.0lf;
  var qh: array<f64, 5>;
  let hbase = base + 10u * points;
  for (var a = 0u; a < 5u; a = a + 1u) {
    qh[a] = shell_state[hbase + a] + dt * scales[a] * rates[a];
    hourglass_power = hourglass_power + qh[a] * rates[a];
    shell_state[hbase + a] = qh[a];
  }
  for (var k = 0u; k < 4u; k = k + 1u) {
    moment_local[k].x = moment_local[k].x + tau[k] * qh[0];
    moment_local[k].y = moment_local[k].y + tau[k] * qh[1];
    force_local[k].z = force_local[k].z + tau[k] * qh[2];
    force_local[k].x = force_local[k].x + tau[k] * qh[3];
    force_local[k].y = force_local[k].y + tau[k] * qh[4];
  }
  if (warping) {
    var u: array<f64, 24>;
    for (var k = 0u; k < 4u; k = k + 1u) {
      u[6u * k] = force_local[k].x; u[6u * k + 1u] = force_local[k].y; u[6u * k + 2u] = force_local[k].z;
      u[6u * k + 3u] = moment_local[k].x; u[6u * k + 4u] = moment_local[k].y; u[6u * k + 5u] = moment_local[k].z;
    }
    let pu = shell_project(pr, u);
    for (var k = 0u; k < 4u; k = k + 1u) {
      force_local[k] = vec3<f64>(pu[6u * k], pu[6u * k + 1u], pu[6u * k + 2u]);
      moment_local[k] = vec3<f64>(pu[6u * k + 3u], pu[6u * k + 4u], pu[6u * k + 5u]);
    }
  }
  for (var k = 0u; k < 4u; k = k + 1u) {
    let force = to_global(f, force_local[k]);
    let moment = to_global(f, moment_local[k]);
    // elem_force holds what the gather subtracts: the shell's internal force enters f_int with a + (shells.rs cycle).
    elem_force[24u * slot + 3u * k] = -force.x;
    elem_force[24u * slot + 3u * k + 1u] = -force.y;
    elem_force[24u * slot + 3u * k + 2u] = -force.z;
    shell_moment[12u * s + 3u * k] = moment.x;
    shell_moment[12u * s + 3u * k + 1u] = moment.y;
    shell_moment[12u * s + 3u * k + 2u] = moment.z;
  }
  var lengths = 0.0lf;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let edge = sub3(p_end[(k + 1u) % 4u], p_end[k]);
    lengths = max(lengths, sqrt(dot3(edge, edge)));
  }
  let nu = materials[mbase + 2u];
  let speed = sqrt(e / (materials[mbase] * (1.0lf - nu * nu)));
  elem_energy[3u * slot] = elem_energy[3u * slot] + work;
  elem_energy[3u * slot + 1u] = elem_energy[3u * slot + 1u] + hourglass_power * dt;
  elem_energy[3u * slot + 2u] = area / lengths / speed;
}

// ---------------------------------------------------------------- moments by node over the shell-ordered incidence
@compute @workgroup_size(64)
fn moment_gather(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  var acc = array<f64, 3>(0.0lf, 0.0lf, 0.0lf);
  for (var j = shell_start[i]; j < shell_start[i + 1u]; j = j + 1u) {
    let slot = shell_incidence[j];
    let s = slot / 4u;
    let k = slot % 4u;
    for (var c = 0u; c < 3u; c = c + 1u) { acc[c] = acc[c] + shell_moment[12u * s + 3u * k + c]; }
  }
  for (var c = 0u; c < 3u; c = c + 1u) { moments[3u * i + c] = acc[c]; }
}
