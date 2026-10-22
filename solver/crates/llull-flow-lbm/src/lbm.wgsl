// D3Q19 lattice Boltzmann step, the WGSL twin of `kernel.rs::step_cell` (same pulls, same boundary rules, same collision, same
// operation order). Populations are SoA: `f[q * n + cell]`. One thread per cell; non-fluid cells return at once.

struct Params {
  nx: u32, ny: u32, nz: u32, n: u32,
  groups_x: u32, periodic_x: u32, periodic_y: u32, periodic_z: u32,
  tau: f32, smagorinsky: f32, pad0: f32, pad1: f32,
  u_in_x: f32, u_in_y: f32, u_in_z: f32, pad2: f32,
  u_wall_x: f32, u_wall_y: f32, u_wall_z: f32, pad3: f32,
  g_x: f32, g_y: f32, g_z: f32, pad4: f32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> f_in: array<f32>;
@group(0) @binding(2) var<storage, read_write> f_out: array<f32>;
@group(0) @binding(3) var<storage, read> flags: array<u32>;
@group(0) @binding(4) var<storage, read> body: array<u32>;
@group(0) @binding(5) var<storage, read_write> rho_out: array<f32>;
@group(0) @binding(6) var<storage, read_write> vel_out: array<f32>;
@group(0) @binding(7) var<storage, read_write> force_out: array<f32>;
@group(0) @binding(8) var<storage, read_write> avg_rho: array<f32>;
@group(0) @binding(9) var<storage, read_write> avg_vel: array<f32>;

const Q: u32 = 19u;
const CS2: f32 = 1.0 / 3.0;
const SQRT2: f32 = 1.4142135623730951;
const FLUID: u32 = 0u;
const SOLID: u32 = 1u;
const INLET: u32 = 2u;
const OUTLET: u32 = 3u;
const SLIP_X: u32 = 4u;
const MOVING_WALL: u32 = 7u;
const NO_BODY: u32 = 65535u;

var<private> CX: array<i32, 19> = array<i32, 19>(0, 1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0);
var<private> CY: array<i32, 19> = array<i32, 19>(0, 0, 0, 1, -1, 0, 0, 1, -1, -1, 1, 0, 0, 0, 0, 1, -1, 1, -1);
var<private> CZ: array<i32, 19> = array<i32, 19>(0, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, 1, -1, -1, 1, 1, -1, -1, 1);
var<private> W: array<f32, 19> = array<f32, 19>(
  1.0 / 3.0,
  1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0, 1.0 / 18.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0,
  1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0, 1.0 / 36.0);
var<private> OPP: array<u32, 19> = array<u32, 19>(0u, 2u, 1u, 4u, 3u, 6u, 5u, 8u, 7u, 10u, 9u, 12u, 11u, 14u, 13u, 16u, 15u, 18u, 17u);
var<private> REFLECT_X: array<u32, 19> = array<u32, 19>(0u, 2u, 1u, 3u, 4u, 5u, 6u, 10u, 9u, 8u, 7u, 14u, 13u, 12u, 11u, 15u, 16u, 17u, 18u);
var<private> REFLECT_Y: array<u32, 19> = array<u32, 19>(0u, 1u, 2u, 4u, 3u, 5u, 6u, 9u, 10u, 7u, 8u, 11u, 12u, 13u, 14u, 18u, 17u, 16u, 15u);
var<private> REFLECT_Z: array<u32, 19> = array<u32, 19>(0u, 1u, 2u, 3u, 4u, 6u, 5u, 7u, 8u, 9u, 10u, 13u, 14u, 11u, 12u, 17u, 18u, 15u, 16u);

fn cvec(q: u32) -> vec3<f32> {
  return vec3<f32>(f32(CX[q]), f32(CY[q]), f32(CZ[q]));
}

fn feq(rho: f32, u: vec3<f32>, q: u32) -> f32 {
  let cu = dot(cvec(q), u);
  let uu = dot(u, u);
  return W[q] * rho * (1.0 + cu / CS2 + cu * cu / (2.0 * CS2 * CS2) - uu / (2.0 * CS2));
}

fn reflected(axis: u32, q: u32) -> u32 {
  if (axis == 0u) { return REFLECT_X[q]; }
  if (axis == 1u) { return REFLECT_Y[q]; }
  return REFLECT_Z[q];
}

// Index of the neighbour `x − c_q`, or n (no neighbour) when it leaves the grid on a non-periodic axis.
fn source_of(i: u32, j: u32, k: u32, q: u32) -> u32 {
  var si = i32(i) - CX[q];
  var sj = i32(j) - CY[q];
  var sk = i32(k) - CZ[q];
  let nx = i32(p.nx);
  let ny = i32(p.ny);
  let nz = i32(p.nz);
  if (si < 0 || si >= nx) { if (p.periodic_x == 0u) { return p.n; } si = (si + nx) % nx; }
  if (sj < 0 || sj >= ny) { if (p.periodic_y == 0u) { return p.n; } sj = (sj + ny) % ny; }
  if (sk < 0 || sk >= nz) { if (p.periodic_z == 0u) { return p.n; } sk = (sk + nz) % nz; }
  return u32(si) + p.nx * (u32(sj) + p.ny * u32(sk));
}

@compute @workgroup_size(64)
fn step(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let cell = (wid.y * p.groups_x + wid.x) * 64u + lid;
  if (cell >= p.n) { return; }
  if (flags[cell] != FLUID) { return; }
  let i = cell % p.nx;
  let j = (cell / p.nx) % p.ny;
  let k = cell / (p.nx * p.ny);

  var own: array<f32, 19>;
  var rho_x = 0.0;
  var m_x = vec3<f32>(0.0, 0.0, 0.0);
  for (var q = 0u; q < Q; q = q + 1u) {
    let v = f_in[q * p.n + cell];
    own[q] = v;
    rho_x = rho_x + v;
    m_x = m_x + cvec(q) * v;
  }
  let u_x = m_x / rho_x;
  let u_in = vec3<f32>(p.u_in_x, p.u_in_y, p.u_in_z);
  let u_wall = vec3<f32>(p.u_wall_x, p.u_wall_y, p.u_wall_z);

  var pulled: array<f32, 19>;
  var force = vec3<f32>(0.0, 0.0, 0.0);
  pulled[0] = own[0];
  for (var q = 1u; q < Q; q = q + 1u) {
    let src = source_of(i, j, k, q);
    var flag = SOLID;
    if (src < p.n) { flag = flags[src]; }
    let cq = cvec(q);
    var value = 0.0;
    if (flag == FLUID) {
      value = f_in[q * p.n + src];
    } else if (flag == SOLID || flag == MOVING_WALL) {
      let bounced = own[OPP[q]];
      var moving = 0.0;
      if (flag == MOVING_WALL) { moving = 2.0 * W[q] * rho_x * dot(cq, u_wall) / CS2; }
      value = bounced + moving;
      if (src < p.n && body[src] != NO_BODY) {
        let exchanged = bounced + value;
        force = force - cq * exchanged;
      }
    } else if (flag == INLET) {
      value = feq(rho_x, u_in, q);
    } else if (flag == OUTLET) {
      value = feq(1.0, u_x, q) + own[q] - feq(rho_x, u_x, q);
    } else {
      value = own[reflected(flag - SLIP_X, q)];
    }
    pulled[q] = value;
  }

  var rho = 0.0;
  var m = vec3<f32>(0.0, 0.0, 0.0);
  for (var q = 0u; q < Q; q = q + 1u) {
    rho = rho + pulled[q];
    m = m + cvec(q) * pulled[q];
  }
  let g = vec3<f32>(p.g_x, p.g_y, p.g_z);
  let u = (m + 0.5 * g) / rho;
  var fe: array<f32, 19>;
  for (var q = 0u; q < Q; q = q + 1u) { fe[q] = feq(rho, u, q); }
  var tau = p.tau;
  if (p.smagorinsky > 0.0) {
    var pi = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for (var q = 0u; q < Q; q = q + 1u) {
      let neq = pulled[q] - fe[q];
      let cq = cvec(q);
      pi[0] = pi[0] + neq * cq.x * cq.x;
      pi[1] = pi[1] + neq * cq.y * cq.y;
      pi[2] = pi[2] + neq * cq.z * cq.z;
      pi[3] = pi[3] + neq * cq.x * cq.y;
      pi[4] = pi[4] + neq * cq.x * cq.z;
      pi[5] = pi[5] + neq * cq.y * cq.z;
    }
    let q_bar = sqrt(pi[0] * pi[0] + pi[1] * pi[1] + pi[2] * pi[2] + 2.0 * (pi[3] * pi[3] + pi[4] * pi[4] + pi[5] * pi[5]));
    let cs = p.smagorinsky;
    tau = 0.5 * (p.tau + sqrt(p.tau * p.tau + 18.0 * SQRT2 * cs * cs * q_bar / rho));
  }
  let omega = 1.0 / tau;
  let forcing = 1.0 - 0.5 * omega;
  for (var q = 0u; q < Q; q = q + 1u) {
    let cq = cvec(q);
    let cu = dot(cq, u);
    let term = (cq - u) / CS2 + cu * cq / (CS2 * CS2);
    f_out[q * p.n + cell] = pulled[q] - omega * (pulled[q] - fe[q]) + forcing * W[q] * dot(term, g);
  }
  rho_out[cell] = rho;
  vel_out[3u * cell] = u.x;
  vel_out[3u * cell + 1u] = u.y;
  vel_out[3u * cell + 2u] = u.z;
  force_out[3u * cell] = force.x;
  force_out[3u * cell + 1u] = force.y;
  force_out[3u * cell + 2u] = force.z;
}

@compute @workgroup_size(64)
fn accumulate(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let cell = (wid.y * p.groups_x + wid.x) * 64u + lid;
  if (cell >= p.n) { return; }
  avg_rho[cell] = avg_rho[cell] + rho_out[cell];
  avg_vel[3u * cell] = avg_vel[3u * cell] + vel_out[3u * cell];
  avg_vel[3u * cell + 1u] = avg_vel[3u * cell + 1u] + vel_out[3u * cell + 1u];
  avg_vel[3u * cell + 2u] = avg_vel[3u * cell + 2u] + vel_out[3u * cell + 2u];
}
