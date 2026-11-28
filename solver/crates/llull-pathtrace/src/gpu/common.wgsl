// GPU path tracer (RV1 RV-M3), part 1 of 6: bindings, the per-submission parameters, random numbers and vector helpers.
// The buffer layout is written by src/gpu/pack.rs (documented there); each algorithm is a port of the CPU module it names.

const PI: f32 = 3.14159265358979;
const INV_PI: f32 = 0.31830988618379;
// Stands for an infinite distance (rays without a bound, the sun, the environment).
const BIG: f32 = 3.0e38;
// BVH traversal stack depth; pack.rs refuses trees deeper than this.
const STACK: u32 = 64u;
// Words per pixel accumulator: rgb sum, luminance mean + M2 (Welford), albedo sum, normal sum, depth sum, first hits, samples.
const ACC: u32 = 16u;

struct Params {
  width: u32, height: u32, tile_x: u32, tile_y: u32,
  tile_w: u32, tile_h: u32, samples: u32, seed: u32,
  max_bounces: u32, light_count: u32, tlas_nodes: u32, tlas_order: u32,
  instance_count: u32, instance_base: u32, material_base: u32, light_base: u32,
  texture_base: u32, material_count: u32, env_kind: u32, env_texture: u32,
  env_marginal: u32, env_conditional: u32, env_rows: u32, srgb_table: u32,
  projection: u32, tile_blocks_x: u32, mask_base: u32, albedo_table: u32,
  // Emissive triangles (lights.wgsl): first row in `objects` and count (0 = none light-sampled); then two pad words.
  emitter_base: u32, emitter_count: u32, pad0: u32, pad1: u32,
  // xyz uniform radiance (env_kind 0); w map intensity (env_kind 1).
  env_color: vec4f,
  // cos, sin of the map rotation.
  env_rot: vec4f,
  // w: tan(fovY / 2), orthographic half height, aperture radius, focus distance.
  cam_pos: vec4f,
  cam_forward: vec4f,
  cam_right: vec4f,
  cam_up: vec4f,
};

@group(0) @binding(0) var<uniform> P: Params;
// BVH nodes, two vec4 each: (min, bitcast first), (max, bitcast count); count 0 = inner node with children first, first + 1.
@group(0) @binding(1) var<storage, read> nodes: array<vec4f>;
// Triangle vertex indices (3 per triangle, BLAS leaf order) followed by the TLAS instance order.
@group(0) @binding(2) var<storage, read> words: array<u32>;
// Vertices, two vec4 each: (position, u), (normal, v).
@group(0) @binding(3) var<storage, read> verts: array<vec4f>;
// Instances (8 vec4), materials (5 vec4), lights (6 vec4), texture descriptors (1 vec4), emitters (1 vec4) at the Params bases.
@group(0) @binding(4) var<storage, read> objects: array<vec4f>;
// LDR texels, RGBA8 packed little-endian.
@group(0) @binding(5) var<storage, read> ldr: array<u32>;
// HDR texels (3 f32 each), the environment CDFs and the 256-entry sRGB decode table.
@group(0) @binding(6) var<storage, read> hdr: array<f32>;
// The tile's pixel accumulators (ACC words each), then one activity word per 16 x 16 block (adaptive stop).
@group(0) @binding(7) var<storage, read_write> accum: array<f32>;

fn finite(x: f32) -> bool {
  return abs(x) <= 3.4028234e38;
}

fn finite3(v: vec3f) -> bool {
  return finite(v.x) && finite(v.y) && finite(v.z);
}

fn is_black(v: vec3f) -> bool {
  return v.x <= 0.0 && v.y <= 0.0 && v.z <= 0.0;
}

fn luminance(v: vec3f) -> f32 {
  return 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
}

fn max3(v: vec3f) -> f32 {
  return max(v.x, max(v.y, v.z));
}

// Unit vector; the zero vector stays zero (math.rs `normalized`).
fn unit(v: vec3f) -> vec3f {
  let l = length(v);
  if (l > 0.0) {
    return v * (1.0 / l);
  }
  return v;
}

fn lerp3(a: vec3f, b: vec3f, t: f32) -> vec3f {
  return a + (b - a) * t;
}

struct Frame { s: vec3f, t: vec3f, n: vec3f };

// math.rs `Frame::from_normal` (Duff et al. 2017).
fn frame_from(n: vec3f) -> Frame {
  let sign = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (sign + n.z);
  let b = n.x * n.y * a;
  return Frame(vec3f(1.0 + sign * n.x * n.x * a, sign * b, -sign * n.x), vec3f(b, sign + n.y * n.y * a, -n.y), n);
}

fn to_local(f: Frame, v: vec3f) -> vec3f {
  return vec3f(dot(v, f.s), dot(v, f.t), dot(v, f.n));
}

fn to_world(f: Frame, v: vec3f) -> vec3f {
  return f.s * v.x + f.t * v.y + f.n * v.z;
}

// math.rs `offset_ray` (Wächter and Binder): integer ulp steps far from the origin, a fixed epsilon near it.
fn offset_ray(p: vec3f, n: vec3f) -> vec3f {
  let of_i = vec3i(256.0 * n);
  let moved = bitcast<vec3f>(bitcast<vec3i>(p) + select(of_i, -of_i, p < vec3f(0.0)));
  return select(moved, p + n * (1.0 / 65536.0), abs(p) < vec3f(1.0 / 32.0));
}

// Random numbers: a counter-based hash of (seed, pixel, sample, dimension) like rng.rs, in 32-bit words (lowbias32,
// C. Wellons); the stream key is two words so distinct (pixel, sample) streams do not share a key.
var<private> rng_a: u32;
var<private> rng_b: u32;
var<private> rng_dim: u32;

fn hash(x: u32) -> u32 {
  var v = x;
  v = v ^ (v >> 16u);
  v = v * 0x7feb352du;
  v = v ^ (v >> 15u);
  v = v * 0x846ca68bu;
  v = v ^ (v >> 16u);
  return v;
}

fn rng_start(pixel: u32, sample: u32) {
  rng_a = hash(hash(P.seed ^ 0x9e3779b9u) ^ pixel);
  rng_b = hash(hash(sample ^ 0x85ebca6bu) + pixel * 0xc2b2ae35u);
  rng_dim = 0u;
}

// Next uniform value in [0, 1) with 24 random bits.
fn rand() -> f32 {
  let value = hash(rng_a ^ hash(rng_b + rng_dim * 0x9e3779b9u));
  rng_dim = rng_dim + 1u;
  return f32(value >> 8u) * (1.0 / 16777216.0);
}

// (a * b) >> 32 without 64-bit integers.
fn mul_hi(a: u32, b: u32) -> u32 {
  let a_lo = a & 0xffffu;
  let a_hi = a >> 16u;
  let b_lo = b & 0xffffu;
  let b_hi = b >> 16u;
  let hi_lo = a_hi * b_lo;
  let cross = ((a_lo * b_lo) >> 16u) + (hi_lo & 0xffffu) + a_lo * b_hi;
  return a_hi * b_hi + (hi_lo >> 16u) + (cross >> 16u);
}

// Next index in 0..n from 32 random bits (rng.rs `Sampler::index`).
fn rand_index(n: u32) -> u32 {
  let value = hash(rng_a ^ hash(rng_b + rng_dim * 0x9e3779b9u));
  rng_dim = rng_dim + 1u;
  return mul_hi(value, n);
}
