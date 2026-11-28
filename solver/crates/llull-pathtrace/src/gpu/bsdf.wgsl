// GPU path tracer, part 4 of 6: the material BSDF, a port of microfacet.rs and bsdf.rs (GGX metal-roughness with clear coat and
// rough transmission, one lobe sampled in proportion to its albedo estimate, the full mixture pdf returned by eval and sample alike).

const MIN_ALPHA: f32 = 1e-3;
const COAT_F0: f32 = 0.04;

// Material values at one surface point (textures applied).
struct Shading { base: vec3f, metalness: f32, roughness: f32, transmission: f32, ior: f32, coat: f32, coat_roughness: f32 };

struct Bsdf { p: Shading, alpha: f32, coat_alpha: f32, f0: f32, spec_average: f32, coat_average: f32 };

fn alpha_of(roughness: f32) -> f32 {
  return max(roughness * roughness, MIN_ALPHA);
}

fn ggx_d(h: vec3f, alpha: f32) -> f32 {
  let a2 = alpha * alpha;
  let denom = h.z * h.z * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

fn ggx_lambda(w: vec3f, alpha: f32) -> f32 {
  let c2 = w.z * w.z;
  if (c2 <= 0.0) {
    return BIG;
  }
  let tan2 = max((1.0 - c2) / c2, 0.0);
  return 0.5 * (sqrt(1.0 + alpha * alpha * tan2) - 1.0);
}

fn ggx_g1(w: vec3f, alpha: f32) -> f32 {
  return 1.0 / (1.0 + ggx_lambda(w, alpha));
}

fn ggx_g2(wo: vec3f, wi: vec3f, alpha: f32) -> f32 {
  return 1.0 / (1.0 + ggx_lambda(wo, alpha) + ggx_lambda(wi, alpha));
}

fn visible_pdf(wo: vec3f, h: vec3f, alpha: f32) -> f32 {
  let cos_o = abs(wo.z);
  if (cos_o <= 0.0) {
    return 0.0;
  }
  return ggx_g1(wo, alpha) / cos_o * ggx_d(h, alpha) * abs(dot(wo, h));
}

// Visible-normal sample (Heitz 2018) for wo mirrored to the upper hemisphere.
fn sample_visible(wo_in: vec3f, alpha: f32, u1: f32, u2: f32) -> vec3f {
  let wo = select(wo_in, -wo_in, wo_in.z < 0.0);
  let vh = unit(vec3f(alpha * wo.x, alpha * wo.y, wo.z));
  let lensq = vh.x * vh.x + vh.y * vh.y;
  var t1 = vec3f(1.0, 0.0, 0.0);
  if (lensq > 0.0) {
    t1 = vec3f(-vh.y, vh.x, 0.0) * (1.0 / sqrt(lensq));
  }
  let t2 = cross(vh, t1);
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2;
  let p1 = r * cos(phi);
  let s = 0.5 * (1.0 + vh.z);
  let p2 = (1.0 - s) * sqrt(max(1.0 - p1 * p1, 0.0)) + s * r * sin(phi);
  let nh = t1 * p1 + t2 * p2 + vh * sqrt(max(1.0 - p1 * p1 - p2 * p2, 0.0));
  return unit(vec3f(alpha * nh.x, alpha * nh.y, max(nh.z, 1e-7)));
}

// Schlick with f90 = min(1, 50 f0).
fn schlick(f0: f32, c: f32) -> f32 {
  let f90 = min(50.0 * f0, 1.0);
  let m = max(1.0 - clamp(c, 0.0, 1.0), 0.0);
  let m2 = m * m;
  return f0 + (f90 - f0) * m2 * m2 * m;
}

fn schlick_rgb(f0: vec3f, c: f32) -> vec3f {
  let f90 = min(50.0 * max3(f0), 1.0);
  let m = max(1.0 - clamp(c, 0.0, 1.0), 0.0);
  let m2 = m * m;
  return f0 + (vec3f(f90) - f0) * (m2 * m2 * m);
}

fn f0_of_ior(ior: f32) -> f32 {
  let r = (ior - 1.0) / (ior + 1.0);
  return r * r;
}

// Unpolarised dielectric Fresnel; cos_i signed (negative = from inside), eta = inside / outside.
fn fresnel_dielectric(cos_in: f32, eta_in: f32) -> f32 {
  var c = cos_in;
  var eta = eta_in;
  if (c < 0.0) {
    c = -c;
    eta = 1.0 / eta;
  }
  let sin2_t = max(1.0 - c * c, 0.0) / (eta * eta);
  if (sin2_t >= 1.0) {
    return 1.0;
  }
  let cos_t = sqrt(max(1.0 - sin2_t, 0.0));
  let parallel = (eta * c - cos_t) / (eta * c + cos_t);
  let perpendicular = (c - eta * cos_t) / (c + eta * cos_t);
  return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}

fn mirror(wo: vec3f, h: vec3f) -> vec3f {
  return h * (2.0 * dot(wo, h)) - wo;
}

// Transmitted direction through microfacet n (pbrt Refract); w = 0 on total internal reflection.
fn refract_through(wi: vec3f, n_in: vec3f, eta_in: f32) -> vec4f {
  var cos_i = dot(n_in, wi);
  var eta = eta_in;
  var n = n_in;
  if (cos_i < 0.0) {
    eta = 1.0 / eta;
    cos_i = -cos_i;
    n = -n;
  }
  let sin2_t = max(1.0 - cos_i * cos_i, 0.0) / (eta * eta);
  if (sin2_t >= 1.0) {
    return vec4f(0.0);
  }
  let cos_t = sqrt(1.0 - sin2_t);
  return vec4f(-wi / eta + n * (cos_i / eta - cos_t), 1.0);
}

// Directional albedo E(mu) of a GGX lobe with Schlick f0 from the tables of albedo.rs (hdr[P.albedo_table..]: e1, e5 N x N, avg1, avg5 N).
const ALBEDO_N: u32 = 32u;

fn albedo_cell(x: f32) -> vec2f {
  let s = clamp(x, 0.0, 1.0) * f32(ALBEDO_N - 1u);
  let i = min(floor(s), f32(ALBEDO_N - 2u));
  return vec2f(i, s - i);
}

fn albedo_at(table: u32, r: vec2f, m: vec2f) -> f32 {
  let base = P.albedo_table + table * ALBEDO_N * ALBEDO_N;
  let ri = u32(r.x);
  let mi = u32(m.x);
  let row0 = hdr[base + ri * ALBEDO_N + mi] * (1.0 - m.y) + hdr[base + ri * ALBEDO_N + mi + 1u] * m.y;
  let row1 = hdr[base + (ri + 1u) * ALBEDO_N + mi] * (1.0 - m.y) + hdr[base + (ri + 1u) * ALBEDO_N + mi + 1u] * m.y;
  return row0 * (1.0 - r.y) + row1 * r.y;
}

fn specular_albedo(f0: f32, roughness: f32, mu: f32) -> f32 {
  let r = albedo_cell(roughness);
  let m = albedo_cell(abs(mu));
  let f90 = min(50.0 * f0, 1.0);
  return clamp(f0 * albedo_at(0u, r, m) + (f90 - f0) * albedo_at(1u, r, m), 0.0, 1.0);
}

fn specular_albedo_average(f0: f32, roughness: f32) -> f32 {
  let r = albedo_cell(roughness);
  let base = P.albedo_table + 2u * ALBEDO_N * ALBEDO_N;
  let i = u32(r.x);
  let a1 = hdr[base + i] * (1.0 - r.y) + hdr[base + i + 1u] * r.y;
  let a5 = hdr[base + ALBEDO_N + i] * (1.0 - r.y) + hdr[base + ALBEDO_N + i + 1u] * r.y;
  let f90 = min(50.0 * f0, 1.0);
  return clamp(f0 * a1 + (f90 - f0) * a5, 0.0, 0.999);
}

fn make_bsdf(p: Shading) -> Bsdf {
  let f0 = f0_of_ior(p.ior);
  return Bsdf(p, alpha_of(p.roughness), alpha_of(p.coat_roughness), f0,
    specular_albedo_average(f0, p.roughness), specular_albedo_average(COAT_F0, p.coat_roughness));
}

fn coat_transmittance(b: Bsdf, c: f32) -> f32 {
  return 1.0 - b.p.coat * specular_albedo(COAT_F0, b.p.coat_roughness, abs(c));
}

fn coat_fresnel(b: Bsdf, c: f32) -> f32 {
  return b.p.coat * schlick(COAT_F0, abs(c));
}

// Lobe selection weights at wo: specular, diffuse, transmission, coat.
fn weights(b: Bsdf, wo: vec3f) -> vec4f {
  let c = abs(wo.z);
  let coat = coat_fresnel(b, c);
  let base = 1.0 - coat;
  let m = b.p.metalness;
  let t = b.p.transmission;
  let fd = schlick(b.f0, c);
  let fm = luminance(schlick_rgb(b.p.base, c));
  return vec4f(
    base * ((1.0 - m) * (1.0 - t) * fd + m * fm),
    base * (1.0 - m) * (1.0 - t) * (1.0 - fd) * luminance(b.p.base),
    base * (1.0 - m) * t,
    coat,
  );
}

// Rough dielectric value (radiance transport) and its own pdf.
fn dielectric(b: Bsdf, wo: vec3f, wi: vec3f) -> vec2f {
  let eta = b.p.ior;
  let reflect_side = wo.z * wi.z > 0.0;
  var etap = 1.0;
  if (!reflect_side) {
    etap = select(1.0 / eta, eta, wo.z > 0.0);
  }
  let wm0 = wi * etap + wo;
  if (dot(wm0, wm0) == 0.0) {
    return vec2f(0.0);
  }
  var wm = unit(wm0);
  if (wm.z < 0.0) {
    wm = -wm;
  }
  if (dot(wm, wi) * wi.z < 0.0 || dot(wm, wo) * wo.z < 0.0) {
    return vec2f(0.0);
  }
  let fresnel = fresnel_dielectric(dot(wo, wm), eta);
  let dm = ggx_d(wm, b.alpha);
  let g = ggx_g2(wo, wi, b.alpha);
  let visible = visible_pdf(wo, wm, b.alpha);
  if (reflect_side) {
    return vec2f(dm * g * fresnel / abs(4.0 * wi.z * wo.z), visible / (4.0 * abs(dot(wo, wm))) * fresnel);
  }
  let denom = dot(wi, wm) + dot(wo, wm) / etap;
  let denom2 = denom * denom;
  let f = dm * g * (1.0 - fresnel) * abs(dot(wi, wm) * dot(wo, wm) / (wi.z * wo.z * denom2)) / (etap * etap);
  return vec2f(f, visible * abs(dot(wi, wm)) / denom2 * (1.0 - fresnel));
}

// BSDF value (xyz) and mixture pdf (w) for local directions, no cosine.
fn eval_local(b: Bsdf, wo: vec3f, wi: vec3f) -> vec4f {
  if (wo.z == 0.0 || wi.z == 0.0) {
    return vec4f(0.0);
  }
  let w = weights(b, wo);
  let total = w.x + w.y + w.z + w.w;
  if (total <= 0.0) {
    return vec4f(0.0);
  }
  let attenuation = coat_transmittance(b, wi.z) * coat_transmittance(b, wo.z) / (1.0 - b.p.coat * b.coat_average);
  let m = b.p.metalness;
  let t = b.p.transmission;
  var trans = vec2f(0.0);
  if (t > 0.0 && m < 1.0) {
    trans = dielectric(b, wo, wi);
  }
  // refraction tinted by sqrt(base) per interface (a closed body: base), the dielectric's reflection not (as bsdf.rs)
  let tint = select(sqrt(b.p.base), vec3f(1.0), wo.z * wi.z > 0.0);
  var f = tint * (trans.x * (1.0 - m) * t * attenuation);
  var pdf = w.z * trans.y;
  if (wo.z * wi.z > 0.0) {
    let flip = wo.z < 0.0;
    let o = select(wo, -wo, flip);
    let i = select(wi, -wi, flip);
    let h = unit(o + i);
    let oh = max(dot(o, h), 0.0);
    let micro = ggx_d(h, b.alpha) * ggx_g2(o, i, b.alpha) / (4.0 * o.z * i.z);
    let fd = schlick(b.f0, oh);
    let spec = vec3f((1.0 - m) * (1.0 - t) * fd) + schlick_rgb(b.p.base, oh) * m;
    let diffuse_fresnel = (1.0 - specular_albedo(b.f0, b.p.roughness, o.z)) * (1.0 - specular_albedo(b.f0, b.p.roughness, i.z))
      / (1.0 - b.spec_average);
    let diffuse = b.p.base * ((1.0 - m) * (1.0 - t) * diffuse_fresnel * INV_PI);
    f = f + (spec * micro + diffuse) * attenuation;
    let coat_micro = ggx_d(h, b.coat_alpha) * ggx_g2(o, i, b.coat_alpha) / (4.0 * o.z * i.z);
    f = f + vec3f(coat_fresnel(b, oh) * coat_micro);
    let jacobian = 1.0 / (4.0 * max(oh, 1e-12));
    pdf = pdf + w.x * visible_pdf(o, h, b.alpha) * jacobian + w.y * i.z * INV_PI + w.w * visible_pdf(o, h, b.coat_alpha) * jacobian;
  }
  return vec4f(f, pdf / total);
}

struct BsdfSample { wi: vec3f, f: vec3f, pdf: f32, ok: bool };

fn cosine_hemisphere(u1: f32, u2: f32) -> vec3f {
  let r = sqrt(u1);
  let phi = 2.0 * PI * u2;
  return vec3f(r * cos(phi), r * sin(phi), sqrt(max(1.0 - u1, 0.0)));
}

// Dielectric lobe direction; w = 0 when the sampled event is inconsistent.
fn sample_dielectric(b: Bsdf, wo: vec3f, u: f32, u1: f32, u2: f32) -> vec4f {
  let wm = sample_visible(wo, b.alpha, u1, u2);
  let fresnel = fresnel_dielectric(dot(wo, wm), b.p.ior);
  if (u < fresnel) {
    let wi = mirror(wo, wm);
    return vec4f(wi, select(0.0, 1.0, wo.z * wi.z > 0.0));
  }
  let r = refract_through(wo, wm, b.p.ior);
  return vec4f(r.xyz, select(0.0, 1.0, r.w > 0.0 && !(wo.z * r.z > 0.0) && r.z != 0.0));
}

fn sample_local(b: Bsdf, wo: vec3f, u: f32, u1: f32, u2: f32) -> BsdfSample {
  var out = BsdfSample(vec3f(0.0), vec3f(0.0), 0.0, false);
  if (wo.z == 0.0) {
    return out;
  }
  let w = weights(b, wo);
  let total = w.x + w.y + w.z + w.w;
  if (total <= 0.0) {
    return out;
  }
  let pick = u * total;
  let sign = select(1.0, -1.0, wo.z < 0.0);
  let up = wo * sign;
  var wi: vec3f;
  if (pick < w.x) {
    wi = mirror(up, sample_visible(up, b.alpha, u1, u2)) * sign;
  } else if (pick < w.x + w.y) {
    wi = cosine_hemisphere(u1, u2) * sign;
  } else if (pick < w.x + w.y + w.z) {
    let d = sample_dielectric(b, wo, min((pick - w.x - w.y) / w.z, 0.999999), u1, u2);
    if (d.w == 0.0) {
      return out;
    }
    wi = d.xyz;
  } else {
    wi = mirror(up, sample_visible(up, b.coat_alpha, u1, u2)) * sign;
  }
  let e = eval_local(b, wo, wi);
  if (e.w > 0.0 && !is_black(e.xyz)) {
    out = BsdfSample(wi, e.xyz, e.w, true);
  }
  return out;
}

// A BSDF placed on a surface: shading frame plus the geometric normal that decides sides (bsdf.rs `SurfaceBsdf`).
struct Placed { frame: Frame, ng: vec3f, bsdf: Bsdf };

fn consistent(p: Placed, w_world: vec3f, w_local: vec3f) -> bool {
  return dot(w_world, p.ng) * w_local.z > 0.0;
}

fn placed_eval(p: Placed, wo: vec3f, wi: vec3f) -> vec4f {
  let o = to_local(p.frame, wo);
  let i = to_local(p.frame, wi);
  if (!consistent(p, wo, o) || !consistent(p, wi, i)) {
    return vec4f(0.0);
  }
  return eval_local(p.bsdf, o, i);
}

fn placed_sample(p: Placed, wo: vec3f, u: f32, u1: f32, u2: f32) -> BsdfSample {
  var out = BsdfSample(vec3f(0.0), vec3f(0.0), 0.0, false);
  let o = to_local(p.frame, wo);
  if (!consistent(p, wo, o)) {
    return out;
  }
  let s = sample_local(p.bsdf, o, u, u1, u2);
  if (!s.ok) {
    return out;
  }
  let wi = to_world(p.frame, s.wi);
  if (consistent(p, wi, s.wi)) {
    out = BsdfSample(wi, s.f, s.pdf, true);
  }
  return out;
}

fn placed_cos(p: Placed, w: vec3f) -> f32 {
  return abs(dot(w, p.frame.n));
}
