// llull-explicit GPU kernels (RS1 RS-8b): the CPU path of solver.rs / hex8.rs / tet4.rs / material.rs / stability.rs line for line,
// in f64 (wgpu SHADER_F64). exp / log / pow have no 64-bit SPIR-V GLSL.std.450 form: they run in f32 (Johnson-Cook terms, V^(1/3)).
// No atomics: nodal forces are gathered per node over a fixed, element-ordered incidence list; the time step is a min over a fixed
// tree. A run is therefore bit-reproducible on one device and driver.

struct Counts { nodes: u32, elements: u32, walls: u32, groups_x: u32 };

@group(0) @binding(0) var<uniform> counts: Counts;
// [dt_prev, dt, hourglass, bulk_linear, bulk_quadratic, gx, gy, gz, time]
@group(0) @binding(1) var<storage, read> scalars: array<f64>;
@group(0) @binding(2) var<storage, read> mass: array<f64>;
@group(0) @binding(3) var<storage, read_write> x: array<f64>;
@group(0) @binding(4) var<storage, read_write> x_new: array<f64>;
@group(0) @binding(5) var<storage, read_write> v_half: array<f64>;
@group(0) @binding(6) var<storage, read_write> v_new: array<f64>;
@group(0) @binding(7) var<storage, read_write> f_int: array<f64>;
// 6 per wall: point, unit normal
@group(0) @binding(8) var<storage, read> walls: array<f64>;
// walls x nodes, reset by the host at each history sample
@group(0) @binding(9) var<storage, read_write> wall_impulse: array<f64>;
// 2 per node: wall energy, external work (running totals)
@group(0) @binding(10) var<storage, read_write> node_energy: array<f64>;
// 8 per element (tet4 uses the first 4)
@group(0) @binding(11) var<storage, read> elem_nodes: array<u32>;
// 2 per element: node count, material
@group(0) @binding(12) var<storage, read> elem_info: array<u32>;
// 9 per element: mass, node masses
@group(0) @binding(13) var<storage, read> elem_mass: array<f64>;
// 26 per material: density, E, nu, lambda, mu, K, has_jc, a, b, n, c, rate0, m, has_failure, d1..d5, melt, transition,
// has_heating, taylor_quinney, specific_heat, cp table start (pair index into cp_table), cp table length (0 = constant)
@group(0) @binding(14) var<storage, read> materials: array<f64>;
// 10 per element: stress (6), plastic strain, damage, failed, temperature
@group(0) @binding(15) var<storage, read_write> state: array<f64>;
// 24 per element
@group(0) @binding(16) var<storage, read_write> elem_force: array<f64>;
// 3 per element: internal work total, hourglass work total, stable step
@group(0) @binding(17) var<storage, read_write> elem_energy: array<f64>;
@group(0) @binding(18) var<storage, read> incidence_start: array<u32>;
@group(0) @binding(19) var<storage, read> incidence: array<u32>;
@group(0) @binding(20) var<storage, read_write> reduced: array<f64>;
// 3 per node: forces the host adds (contact minus the shells' internal forces), zero without contact and shells
@group(0) @binding(21) var<storage, read> host_force: array<f64>;
// 3 per node: 1 = fixed degree of freedom (velocity held at 0 after the walls, as solver.rs)
@group(0) @binding(22) var<storage, read> fixed: array<u32>;
// (temperature K, c_p) pairs of every material's c_p table, in material order
@group(0) @binding(23) var<storage, read> cp_table: array<f64>;
// 1 per dof: 0 = free, k + 1 = imposed by motion k
@group(0) @binding(24) var<storage, read> imposed: array<u32>;
// per motion [kind (0 velocity, 1 displacement), first point (index of its time in this array), point count]; then the (t, value) points
@group(0) @binding(25) var<storage, read> motions: array<f64>;
// 3 per node: initial coordinates (displacement curves)
@group(0) @binding(26) var<storage, read> x_ref: array<f64>;

// A motion curve at a time: linear, constant outside it (model.rs ImposedMotion::at).
fn curve_at(motion: u32, time: f64) -> f64 {
  let start = u32(motions[3u * motion + 1u]);
  let count = u32(motions[3u * motion + 2u]);
  if (time <= motions[start]) { return motions[start + 1u]; }
  let last = start + 2u * (count - 1u);
  if (time >= motions[last]) { return motions[last + 1u]; }
  for (var k = start + 2u; k <= last; k = k + 2u) {
    if (time < motions[k]) {
      let t0 = motions[k - 2u];
      let v0 = motions[k - 1u];
      return v0 + (motions[k + 1u] - v0) * (time - t0) / (motions[k] - t0);
    }
  }
  return motions[last + 1u];
}

const BIG: f64 = 1.0e300lf;

fn linear_id(wid: vec3<u32>, lid: u32) -> u32 {
  return (wid.y * counts.groups_x + wid.x) * 64u + lid;
}

fn pow_f(value: f64, exponent: f64) -> f64 {
  return f64(pow(f32(value), f32(exponent)));
}

fn ln_f(value: f64) -> f64 {
  return f64(log(f32(value)));
}

fn exp_f(value: f64) -> f64 {
  return f64(exp(f32(value)));
}

// ---------------------------------------------------------------- kick: central-difference velocity, stonewalls, positions
@compute @workgroup_size(64)
fn kick(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  let dtp = scalars[0];
  let dt = scalars[1];
  let m = mass[i];
  var v: array<f64, 3>;
  for (var c = 0u; c < 3u; c = c + 1u) {
    let f_ext = m * scalars[5u + c];
    v[c] = v_half[3u * i + c] + 0.5lf * (dtp + dt) * (f_ext + host_force[3u * i + c] - f_int[3u * i + c]) / m;
  }
  for (var w = 0u; w < counts.walls; w = w + 1u) {
    let n = array<f64, 3>(walls[6u * w + 3u], walls[6u * w + 4u], walls[6u * w + 5u]);
    let normal_speed = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
    if (normal_speed >= 0.0lf) { continue; }
    var gap = 0.0lf;
    for (var c = 0u; c < 3u; c = c + 1u) {
      gap = gap + (x[3u * i + c] + dt * v[c] - walls[6u * w + c]) * n[c];
    }
    if (gap < 0.0lf) {
      let previous = v_half[3u * i] * n[0] + v_half[3u * i + 1u] * n[1] + v_half[3u * i + 2u] * n[2];
      for (var c = 0u; c < 3u; c = c + 1u) {
        v[c] = v[c] - normal_speed * n[c];
      }
      wall_impulse[w * counts.nodes + i] = wall_impulse[w * counts.nodes + i] + (-m * normal_speed);
      node_energy[2u * i] = node_energy[2u * i] + 0.5lf * m * normal_speed * previous;
    }
  }
  for (var c = 0u; c < 3u; c = c + 1u) {
    if (fixed[3u * i + c] != 0u) { v[c] = 0.0lf; }
    let code = imposed[3u * i + c];
    if (code != 0u) {
      let motion = code - 1u;
      let time = scalars[8];
      var target_v = curve_at(motion, time + 0.5lf * dt);
      if (motions[3u * motion] > 0.5lf) {
        target_v = (curve_at(motion, time + dt) - (x[3u * i + c] - x_ref[3u * i + c])) / dt;
      }
      // Reaction work over the central-difference step (solver.rs impose).
      let reaction = m * (target_v - v[c]) / (0.5lf * (dtp + dt));
      node_energy[2u * i + 1u] = node_energy[2u * i + 1u] + reaction * 0.5lf * (dtp * v_half[3u * i + c] + dt * target_v);
      v[c] = target_v;
    }
    v_new[3u * i + c] = v[c];
    x_new[3u * i + c] = x[3u * i + c] + dt * v[c];
  }
}

// ---------------------------------------------------------------- element geometry (hex8.rs, tet4.rs)
struct Gradients { b: array<vec3<f64>, 8>, volume: f64 };

fn hex_component(y: array<f64, 8>, z: array<f64, 8>, node: u32) -> f64 {
  var perm = array<array<u32, 7>, 8>(
    array<u32, 7>(1u, 2u, 3u, 4u, 5u, 6u, 7u),
    array<u32, 7>(2u, 3u, 0u, 5u, 6u, 7u, 4u),
    array<u32, 7>(3u, 0u, 1u, 6u, 7u, 4u, 5u),
    array<u32, 7>(0u, 1u, 2u, 7u, 4u, 5u, 6u),
    array<u32, 7>(7u, 6u, 5u, 0u, 3u, 2u, 1u),
    array<u32, 7>(4u, 7u, 6u, 1u, 0u, 3u, 2u),
    array<u32, 7>(5u, 4u, 7u, 2u, 1u, 0u, 3u),
    array<u32, 7>(6u, 5u, 4u, 3u, 2u, 1u, 0u),
  );
  var yy = y;
  var zl = z;
  let p = perm[node];
  // n(k) = p[k - 2], k = 2..8
  let n2 = p[0]; let n3 = p[1]; let n4 = p[2]; let n5 = p[3]; let n6 = p[4]; let n8 = p[6];
  let z63 = zl[n6] - zl[n3];
  let z45 = zl[n4] - zl[n5];
  let z24 = zl[n2] - zl[n4];
  let z38 = zl[n3] - zl[n8];
  let z52 = zl[n5] - zl[n2];
  let z86 = zl[n8] - zl[n6];
  return (yy[n2] * (z63 - z45) + yy[n3] * z24 + yy[n4] * (z38 - z52) + yy[n5] * (z86 - z24) + yy[n6] * z52 + yy[n8] * z45) / 12.0lf;
}

fn hex_gradients(p: array<vec3<f64>, 8>) -> Gradients {
  var xs: array<f64, 8>;
  var ys: array<f64, 8>;
  var zs: array<f64, 8>;
  for (var k = 0u; k < 8u; k = k + 1u) {
    xs[k] = p[k].x;
    ys[k] = p[k].y;
    zs[k] = p[k].z;
  }
  var g: Gradients;
  var volume = 0.0lf;
  for (var k = 0u; k < 8u; k = k + 1u) {
    g.b[k] = vec3<f64>(hex_component(ys, zs, k), hex_component(zs, xs, k), hex_component(xs, ys, k));
    volume = volume + xs[k] * g.b[k].x;
  }
  g.volume = volume;
  return g;
}

fn cross3(a: vec3<f64>, b: vec3<f64>) -> vec3<f64> {
  return vec3<f64>(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

fn tet_gradients(p: array<vec3<f64>, 8>) -> Gradients {
  let a = p[1] - p[0];
  let b = p[2] - p[0];
  let c = p[3] - p[0];
  let bc = cross3(b, c);
  let det = a.x * bc.x + a.y * bc.y + a.z * bc.z;
  var g: Gradients;
  g.volume = det / 6.0lf;
  g.b[1] = cross3(b, c) / 6.0lf;
  g.b[2] = cross3(c, a) / 6.0lf;
  g.b[3] = cross3(a, b) / 6.0lf;
  g.b[0] = vec3<f64>(-(g.b[1].x + g.b[2].x + g.b[3].x), -(g.b[1].y + g.b[2].y + g.b[3].y), -(g.b[1].z + g.b[2].z + g.b[3].z));
  return g;
}

fn gradients_of(p: array<vec3<f64>, 8>, count: u32) -> Gradients {
  if (count == 8u) { return hex_gradients(p); }
  return tet_gradients(p);
}

// ---------------------------------------------------------------- stable step (stability.rs)
fn largest_eigenvalue(input: array<array<f64, 6>, 6>) -> f64 {
  var a = input;
  for (var sweep = 0u; sweep < 30u; sweep = sweep + 1u) {
    var off = 0.0lf;
    var diagonal = 0.0lf;
    for (var i = 0u; i < 6u; i = i + 1u) {
      for (var j = 0u; j < 6u; j = j + 1u) {
        if (j != i) { off = off + a[i][j] * a[i][j]; }
      }
    }
    for (var i = 0u; i < 6u; i = i + 1u) { diagonal = diagonal + a[i][i] * a[i][i]; }
    if (off <= 1.0e-30lf * diagonal) { break; }
    for (var p = 0u; p < 5u; p = p + 1u) {
      for (var q = p + 1u; q < 6u; q = q + 1u) {
        if (a[p][q] == 0.0lf) { continue; }
        let theta = (a[q][q] - a[p][p]) / (2.0lf * a[p][q]);
        var t = 1.0lf;
        if (theta != 0.0lf) {
          var s = 1.0lf;
          if (theta < 0.0lf) { s = -1.0lf; }
          t = s / (abs(theta) + sqrt(theta * theta + 1.0lf));
        }
        let cs = 1.0lf / sqrt(t * t + 1.0lf);
        let sn = t * cs;
        for (var k = 0u; k < 6u; k = k + 1u) {
          let akp = a[k][p];
          let akq = a[k][q];
          a[k][p] = cs * akp - sn * akq;
          a[k][q] = sn * akp + cs * akq;
        }
        for (var k = 0u; k < 6u; k = k + 1u) {
          let apk = a[p][k];
          let aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk;
          a[q][k] = sn * apk + cs * aqk;
        }
      }
    }
  }
  var largest = -BIG;
  for (var i = 0u; i < 6u; i = i + 1u) { largest = max(largest, a[i][i]); }
  return largest;
}

fn mandel(b: vec3<f64>) -> array<array<f64, 3>, 6> {
  let s = 0.7071067811865475lf;
  return array<array<f64, 3>, 6>(
    array<f64, 3>(b.x, 0.0lf, 0.0lf),
    array<f64, 3>(0.0lf, b.y, 0.0lf),
    array<f64, 3>(0.0lf, 0.0lf, b.z),
    array<f64, 3>(s * b.y, s * b.x, 0.0lf),
    array<f64, 3>(0.0lf, s * b.z, s * b.y),
    array<f64, 3>(s * b.z, 0.0lf, s * b.x),
  );
}

fn omega_squared(g: Gradients, count: u32, e: u32, mat: u32) -> f64 {
  var h: array<array<f64, 6>, 6>;
  for (var k = 0u; k < count; k = k + 1u) {
    let op = mandel(g.b[k]);
    let m = elem_mass[9u * e + 1u + k];
    for (var i = 0u; i < 6u; i = i + 1u) {
      for (var j = 0u; j < 6u; j = j + 1u) {
        h[i][j] = h[i][j] + (op[i][0] * op[j][0] + op[i][1] * op[j][1] + op[i][2] * op[j][2]) / m;
      }
    }
  }
  let shear = sqrt(2.0lf * materials[26u * mat + 4u]);
  let bulk = sqrt(3.0lf * materials[26u * mat + 5u]);
  var root: array<array<f64, 6>, 6>;
  for (var i = 0u; i < 6u; i = i + 1u) {
    for (var j = 0u; j < 6u; j = j + 1u) {
      var value = 0.0lf;
      if (i < 3u && j < 3u) { value = (bulk - shear) / 3.0lf; }
      if (i == j) { value = value + shear; }
      root[i][j] = value;
    }
  }
  var ch: array<array<f64, 6>, 6>;
  for (var i = 0u; i < 6u; i = i + 1u) {
    for (var j = 0u; j < 6u; j = j + 1u) {
      var sum = 0.0lf;
      for (var k = 0u; k < 6u; k = k + 1u) { sum = sum + root[i][k] * h[k][j]; }
      ch[i][j] = sum;
    }
  }
  var s: array<array<f64, 6>, 6>;
  for (var i = 0u; i < 6u; i = i + 1u) {
    for (var j = 0u; j < 6u; j = j + 1u) {
      var sum = 0.0lf;
      for (var k = 0u; k < 6u; k = k + 1u) { sum = sum + ch[i][k] * root[k][j]; }
      s[i][j] = sum / g.volume;
    }
  }
  return largest_eigenvalue(s);
}

// ---------------------------------------------------------------- material (material.rs)
fn von_mises(s: array<f64, 6>) -> f64 {
  let p = (s[0] + s[1] + s[2]) / 3.0lf;
  let a = s[0] - p;
  let b = s[1] - p;
  let c = s[2] - p;
  return sqrt(1.5lf * (a * a + b * b + c * c + 2.0lf * (s[3] * s[3] + s[4] * s[4] + s[5] * s[5])));
}

// Johnson-Cook flow stress with the thermal term (1 - T*^m) (model.rs flow_stress_at).
fn flow_stress(mat: u32, eps: f64, rate: f64, t_star: f64) -> f64 {
  let base = 26u * mat;
  let hardening = materials[base + 7u] + materials[base + 8u] * pow_f(max(eps, 0.0lf), materials[base + 9u]);
  let rate_term = 1.0lf + materials[base + 10u] * ln_f(max(rate / materials[base + 11u], 1.0lf));
  var thermal = 1.0lf;
  if (t_star > 0.0lf) { thermal = 1.0lf - pow_f(t_star, materials[base + 12u]); }
  return hardening * rate_term * thermal;
}

// c_p at a temperature: the constant, or linear interpolation in the material's table clamped at its ends (model.rs specific_heat_at).
fn specific_heat_at(mat: u32, temperature: f64) -> f64 {
  let base = 26u * mat;
  let count = u32(materials[base + 25u]);
  if (count == 0u) { return materials[base + 23u]; }
  let start = u32(materials[base + 24u]);
  if (temperature <= cp_table[2u * start]) { return cp_table[2u * start + 1u]; }
  let last = start + count - 1u;
  if (temperature >= cp_table[2u * last]) { return cp_table[2u * last + 1u]; }
  for (var k = start + 1u; k <= last; k = k + 1u) {
    if (temperature < cp_table[2u * k]) {
      let t0 = cp_table[2u * (k - 1u)];
      let c0 = cp_table[2u * (k - 1u) + 1u];
      return c0 + (cp_table[2u * k + 1u] - c0) * (temperature - t0) / (cp_table[2u * k] - t0);
    }
  }
  return cp_table[2u * last + 1u];
}

// Homologous temperature clamped to [0, 1] (model.rs homologous).
fn homologous(mat: u32, temperature: f64) -> f64 {
  let base = 26u * mat;
  return clamp((temperature - materials[base + 20u]) / (materials[base + 19u] - materials[base + 20u]), 0.0lf, 1.0lf);
}

struct Point { stress: array<f64, 6>, eps: f64, damage: f64, failed: f64, temperature: f64 };

fn update_point(mat: u32, old: Point, d: array<f64, 6>, w: vec3<f64>, dt: f64) -> Point {
  if (old.failed > 0.5lf) { return old; }
  let base = 26u * mat;
  // Jaumann rotation r_ij = (σ_ip ω_pj + σ_jp ω_pi) dt with ω = [[0, wxy, -wzx], [-wxy, 0, wyz], [wzx, -wyz, 0]]
  let st = old.stress;
  var sf = array<array<f64, 3>, 3>(
    array<f64, 3>(st[0], st[3], st[5]),
    array<f64, 3>(st[3], st[1], st[4]),
    array<f64, 3>(st[5], st[4], st[2]),
  );
  var om = array<array<f64, 3>, 3>(
    array<f64, 3>(0.0lf, w.x, -w.z),
    array<f64, 3>(-w.x, 0.0lf, w.y),
    array<f64, 3>(w.z, -w.y, 0.0lf),
  );
  var idx_i = array<u32, 6>(0u, 1u, 2u, 0u, 1u, 2u);
  var idx_j = array<u32, 6>(0u, 1u, 2u, 1u, 2u, 0u);
  var trial: array<f64, 6>;
  for (var k = 0u; k < 6u; k = k + 1u) {
    let i = idx_i[k];
    let j = idx_j[k];
    var r = 0.0lf;
    for (var p = 0u; p < 3u; p = p + 1u) { r = r + (sf[i][p] * om[p][j] + sf[j][p] * om[p][i]); }
    trial[k] = st[k] + r * dt;
  }
  let lambda = materials[base + 3u];
  let mu = materials[base + 4u];
  let trace = d[0] + d[1] + d[2];
  for (var k = 0u; k < 3u; k = k + 1u) { trial[k] = trial[k] + dt * (lambda * trace + 2.0lf * mu * d[k]); }
  for (var k = 3u; k < 6u; k = k + 1u) { trial[k] = trial[k] + dt * 2.0lf * mu * d[k]; }
  var next = old;
  next.stress = trial;
  if (materials[base + 6u] < 0.5lf) { return next; }
  let equivalent = von_mises(trial);
  let eps = old.eps;
  let t_star = homologous(mat, old.temperature);
  if (equivalent <= flow_stress(mat, eps, 0.0lf, t_star)) { return next; }
  var low = 0.0lf;
  var high = equivalent / (3.0lf * mu);
  for (var it = 0u; it < 200u; it = it + 1u) {
    let middle = 0.5lf * (low + high);
    if (middle <= low || middle >= high) { break; }
    let residual = equivalent - 3.0lf * mu * middle - flow_stress(mat, eps + middle, middle / dt, t_star);
    if (residual > 0.0lf) { low = middle; } else { high = middle; }
  }
  let increment = 0.5lf * (low + high);
  let yield_stress = equivalent - 3.0lf * mu * increment;
  let pressure = (trial[0] + trial[1] + trial[2]) / 3.0lf;
  let scale = yield_stress / equivalent;
  var stress: array<f64, 6>;
  for (var k = 0u; k < 3u; k = k + 1u) { stress[k] = pressure + (trial[k] - pressure) * scale; }
  for (var k = 3u; k < 6u; k = k + 1u) { stress[k] = trial[k] * scale; }
  next.stress = stress;
  next.eps = eps + increment;
  if (materials[base + 21u] > 0.5lf) {
    next.temperature = old.temperature + materials[base + 22u] * yield_stress * increment / (materials[base] * specific_heat_at(mat, old.temperature));
  }
  if (materials[base + 13u] < 0.5lf) { return next; }
  let triaxiality = pressure / yield_stress;
  var strain = (materials[base + 14u] + materials[base + 15u] * exp_f(materials[base + 16u] * triaxiality))
    * (1.0lf + materials[base + 17u] * ln_f(max((increment / dt) / materials[base + 11u], 1.0lf)))
    * (1.0lf + materials[base + 18u] * t_star);
  strain = max(strain, 1.0e-6lf);
  next.damage = old.damage + increment / strain;
  if (next.damage >= 1.0lf) {
    next.stress = array<f64, 6>(0.0lf, 0.0lf, 0.0lf, 0.0lf, 0.0lf, 0.0lf);
    next.failed = 1.0lf;
  }
  return next;
}

// ---------------------------------------------------------------- element pass (solver.rs step_element)
fn hourglass_gamma(alpha: u32, k: u32) -> f64 {
  var gamma = array<array<f64, 8>, 4>(
    array<f64, 8>(1.0lf, 1.0lf, -1.0lf, -1.0lf, -1.0lf, -1.0lf, 1.0lf, 1.0lf),
    array<f64, 8>(1.0lf, -1.0lf, -1.0lf, 1.0lf, -1.0lf, 1.0lf, 1.0lf, -1.0lf),
    array<f64, 8>(1.0lf, -1.0lf, 1.0lf, -1.0lf, 1.0lf, -1.0lf, 1.0lf, -1.0lf),
    array<f64, 8>(1.0lf, -1.0lf, 1.0lf, -1.0lf, -1.0lf, 1.0lf, -1.0lf, 1.0lf),
  );
  return gamma[alpha][k];
}

@compute @workgroup_size(64)
fn element(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let e = linear_id(wid, lid);
  if (e >= counts.elements) { return; }
  let count = elem_info[2u * e];
  let mat = elem_info[2u * e + 1u];
  let dt = scalars[1];
  var old: Point;
  for (var k = 0u; k < 6u; k = k + 1u) { old.stress[k] = state[10u * e + k]; }
  old.eps = state[10u * e + 6u];
  old.damage = state[10u * e + 7u];
  old.failed = state[10u * e + 8u];
  old.temperature = state[10u * e + 9u];
  if (old.failed > 0.5lf) {
    for (var k = 0u; k < 24u; k = k + 1u) { elem_force[24u * e + k] = 0.0lf; }
    elem_energy[3u * e + 2u] = BIG;
    return;
  }
  var p0: array<vec3<f64>, 8>;
  var p1: array<vec3<f64>, 8>;
  var pm: array<vec3<f64>, 8>;
  var vel: array<vec3<f64>, 8>;
  for (var k = 0u; k < count; k = k + 1u) {
    let n = elem_nodes[8u * e + k];
    p0[k] = vec3<f64>(x[3u * n], x[3u * n + 1u], x[3u * n + 2u]);
    p1[k] = vec3<f64>(x_new[3u * n], x_new[3u * n + 1u], x_new[3u * n + 2u]);
    pm[k] = vec3<f64>(0.5lf * (p0[k].x + p1[k].x), 0.5lf * (p0[k].y + p1[k].y), 0.5lf * (p0[k].z + p1[k].z));
    vel[k] = vec3<f64>(v_new[3u * n], v_new[3u * n + 1u], v_new[3u * n + 2u]);
  }
  let gm = gradients_of(pm, count);
  // velocity gradient L_ij = Σ v_i B_j / V
  var l: array<array<f64, 3>, 3>;
  for (var k = 0u; k < count; k = k + 1u) {
    let v = array<f64, 3>(vel[k].x, vel[k].y, vel[k].z);
    let b = array<f64, 3>(gm.b[k].x, gm.b[k].y, gm.b[k].z);
    for (var i = 0u; i < 3u; i = i + 1u) {
      for (var j = 0u; j < 3u; j = j + 1u) { l[i][j] = l[i][j] + v[i] * b[j] / gm.volume; }
    }
  }
  let d = array<f64, 6>(l[0][0], l[1][1], l[2][2], 0.5lf * (l[0][1] + l[1][0]), 0.5lf * (l[1][2] + l[2][1]), 0.5lf * (l[2][0] + l[0][2]));
  let w = vec3<f64>(0.5lf * (l[0][1] - l[1][0]), 0.5lf * (l[1][2] - l[2][1]), 0.5lf * (l[2][0] - l[0][2]));
  let next = update_point(mat, old, d, w, dt);
  let g1 = gradients_of(p1, count);
  let density = elem_mass[9u * e] / g1.volume;
  let base = 26u * mat;
  let speed = sqrt((materials[base + 3u] + 2.0lf * materials[base + 4u]) / density);
  let trace = d[0] + d[1] + d[2];
  var bulk = 0.0lf;
  if (trace < 0.0lf) {
    let l_bulk = pow_f(g1.volume, 1.0lf / 3.0lf);
    bulk = density * l_bulk * (scalars[4] * l_bulk * trace * trace - scalars[3] * speed * trace);
  }
  var fs = next.stress;
  for (var k = 0u; k < 3u; k = k + 1u) { fs[k] = fs[k] - bulk; }
  let sm = array<array<f64, 3>, 3>(
    array<f64, 3>(fs[0], fs[3], fs[5]),
    array<f64, 3>(fs[3], fs[1], fs[4]),
    array<f64, 3>(fs[5], fs[4], fs[2]),
  );
  var forces: array<vec3<f64>, 8>;
  for (var k = 0u; k < count; k = k + 1u) {
    let b = g1.b[k];
    forces[k] = vec3<f64>(
      -(sm[0][0] * b.x + sm[0][1] * b.y + sm[0][2] * b.z),
      -(sm[1][0] * b.x + sm[1][1] * b.y + sm[1][2] * b.z),
      -(sm[2][0] * b.x + sm[2][1] * b.y + sm[2][2] * b.z),
    );
  }
  var hourglass_work = 0.0lf;
  if (count == 8u && scalars[2] > 0.0lf) {
    let a_h = scalars[2] * density * pow_f(g1.volume, 2.0lf / 3.0lf) * speed / 4.0lf;
    var power = 0.0lf;
    for (var alpha = 0u; alpha < 4u; alpha = alpha + 1u) {
      var projection = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
      for (var k = 0u; k < 8u; k = k + 1u) { projection = projection + hourglass_gamma(alpha, k) * p1[k]; }
      var gamma: array<f64, 8>;
      for (var k = 0u; k < 8u; k = k + 1u) {
        gamma[k] = hourglass_gamma(alpha, k) - (projection.x * g1.b[k].x + projection.y * g1.b[k].y + projection.z * g1.b[k].z) / g1.volume;
      }
      var gv = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
      for (var k = 0u; k < 8u; k = k + 1u) { gv = gv + vel[k] * gamma[k]; }
      power = power + a_h * (gv.x * gv.x + gv.y * gv.y + gv.z * gv.z);
      for (var k = 0u; k < 8u; k = k + 1u) { forces[k] = forces[k] - a_h * gv * gamma[k]; }
    }
    hourglass_work = power * dt;
  }
  var mean: array<f64, 6>;
  for (var k = 0u; k < 6u; k = k + 1u) { mean[k] = 0.5lf * (old.stress[k] + next.stress[k]); }
  let power = mean[0] * d[0] + mean[1] * d[1] + mean[2] * d[2] + 2.0lf * (mean[3] * d[3] + mean[4] * d[4] + mean[5] * d[5]) - bulk * trace;
  elem_energy[3u * e] = elem_energy[3u * e] + power * gm.volume * dt;
  elem_energy[3u * e + 1u] = elem_energy[3u * e + 1u] + hourglass_work;
  // stable step: h = 2c/ω, Δt = h / (Q + sqrt(Q² + c²))
  var step = BIG;
  if (next.failed < 0.5lf) {
    let eigen = 2.0lf / sqrt(omega_squared(g1, count, e, mat));
    let length = speed * eigen;
    var q = 0.0lf;
    if (trace < 0.0lf) { q = scalars[3] * speed + scalars[4] * length * abs(trace); }
    step = length / (q + sqrt(q * q + speed * speed));
  }
  elem_energy[3u * e + 2u] = step;
  for (var k = 0u; k < 6u; k = k + 1u) { state[10u * e + k] = next.stress[k]; }
  state[10u * e + 6u] = next.eps;
  state[10u * e + 7u] = next.damage;
  state[10u * e + 8u] = next.failed;
  state[10u * e + 9u] = next.temperature;
  for (var k = 0u; k < 8u; k = k + 1u) {
    var f = vec3<f64>(0.0lf, 0.0lf, 0.0lf);
    if (k < count && next.failed < 0.5lf) { f = forces[k]; }
    elem_force[24u * e + 3u * k] = f.x;
    elem_force[24u * e + 3u * k + 1u] = f.y;
    elem_force[24u * e + 3u * k + 2u] = f.z;
  }
}

// ---------------------------------------------------------------- gather: f_int by node over the element-ordered incidence
@compute @workgroup_size(64)
fn gather(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  var acc = array<f64, 3>(0.0lf, 0.0lf, 0.0lf);
  for (var j = incidence_start[i]; j < incidence_start[i + 1u]; j = j + 1u) {
    let slot = incidence[j];
    for (var c = 0u; c < 3u; c = c + 1u) { acc[c] = acc[c] - elem_force[3u * slot + c]; }
  }
  for (var c = 0u; c < 3u; c = c + 1u) { f_int[3u * i + c] = acc[c]; }
}

// ---------------------------------------------------------------- min stable step over a fixed tree (one workgroup)
var<workgroup> scratch: array<f64, 64>;

@compute @workgroup_size(64)
fn min_step(@builtin(local_invocation_index) lid: u32) {
  var m = BIG;
  for (var e = lid; e < counts.elements; e = e + 64u) { m = min(m, elem_energy[3u * e + 2u]); }
  scratch[lid] = m;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (lid < s) { scratch[lid] = min(scratch[lid], scratch[lid + s]); }
    workgroupBarrier();
  }
  if (lid == 0u) { reduced[0] = scratch[0]; }
}

// ---------------------------------------------------------------- commit: external work, x <- x_new, v_half <- v_new
@compute @workgroup_size(64)
fn commit(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let i = linear_id(wid, lid);
  if (i >= counts.nodes) { return; }
  let m = mass[i];
  var work = 0.0lf;
  for (var c = 0u; c < 3u; c = c + 1u) {
    work = work + m * scalars[5u + c] * (x_new[3u * i + c] - x[3u * i + c]);
    x[3u * i + c] = x_new[3u * i + c];
    v_half[3u * i + c] = v_new[3u * i + c];
  }
  node_energy[2u * i + 1u] = node_energy[2u * i + 1u] + work;
}
