// GPU path tracer, part 5 of 6: the lights (lights.rs), sampled for next-event estimation and intersected by BSDF rays for MIS, and
// the emissive triangles (emitters.rs).
// Rows (6 vec4) per light, by kind in r0.w (0 sun, 1 sphere = point / spot, 2 rect = area); r5.x = castShadows:
//   sun    r0 direction · r1 (irradiance, cosMax) · r2 (cone radiance, solidAngle)
//   sphere r0 centre · r1 (intensity, radius) · r2 (radiance, unitMetres) · r3 (spot axis, cosHalf) · r4 (blend, hasSpot)
//   rect   r0 centre · r1 (u edge, area) · r2 (radiance) · r3 (v edge) · r4 (normal)

// A light sample: direction, distance (BIG = infinite), value (radiance, or irradiance / intensity term for a delta light),
// pdf in solid angle (0 = delta light), ok.
struct LightSample { wi: vec3f, distance: f32, value: vec3f, pdf: f32, ok: bool };

fn light_row(i: u32, r: u32) -> vec4f {
  return objects[P.light_base + 6u * i + r];
}

fn light_kind(i: u32) -> u32 {
  return u32(light_row(i, 0u).w);
}

fn light_casts(i: u32) -> bool {
  return light_row(i, 5u).x > 0.5;
}

fn sample_cone(f: Frame, cos_max: f32, u1: f32, u2: f32) -> vec3f {
  let c = 1.0 - u1 * (1.0 - cos_max);
  let s = sqrt(max(1.0 - c * c, 0.0));
  let phi = 2.0 * PI * u2;
  return to_world(f, vec3f(s * cos(phi), s * sin(phi), c));
}

fn spot_mask(i: u32, from_light: vec3f) -> f32 {
  let r4 = light_row(i, 4u);
  if (r4.y < 0.5) {
    return 1.0;
  }
  let r3 = light_row(i, 3u);
  let c = dot(from_light, r3.xyz);
  if (c <= r3.w) {
    return 0.0;
  }
  let width = (1.0 - r3.w) * r4.x;
  if (width <= 0.0) {
    return 1.0;
  }
  let t = clamp((c - r3.w) / width, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn one_minus_cos_max(radius: f32, distance: f32) -> f32 {
  let s2 = (radius / distance) * (radius / distance);
  return s2 / (1.0 + sqrt(max(1.0 - s2, 0.0)));
}

// Distance to a sphere along a ray (first positive root), -1 for a miss.
fn sphere_hit(o: vec3f, d: vec3f, centre: vec3f, radius: f32) -> f32 {
  let oc = o - centre;
  let b = dot(oc, d);
  let c = dot(oc, oc) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return -1.0;
  }
  let root = sqrt(disc);
  let t0 = -b - root;
  if (t0 > 0.0) {
    return t0;
  }
  let t1 = -b + root;
  return select(-1.0, t1, t1 > 0.0);
}

fn light_sample(i: u32, p: vec3f, u1: f32, u2: f32) -> LightSample {
  var out = LightSample(vec3f(0.0), BIG, vec3f(0.0), 0.0, false);
  let r0 = light_row(i, 0u);
  let r1 = light_row(i, 1u);
  let r2 = light_row(i, 2u);
  let kind = u32(r0.w);
  if (kind == 0u) {
    if (r2.w <= 0.0) {
      return LightSample(r0.xyz, BIG, r1.xyz, 0.0, true);
    }
    return LightSample(sample_cone(frame_from(r0.xyz), r1.w, u1, u2), BIG, r2.xyz, 1.0 / r2.w, true);
  }
  if (kind == 1u) {
    let to_centre = r0.xyz - p;
    let distance = length(to_centre);
    let radius = r1.w;
    if (distance <= radius || distance <= 0.0) {
      return out;
    }
    let axis = to_centre / distance;
    let mask = spot_mask(i, -axis);
    if (mask <= 0.0) {
      return out;
    }
    if (radius <= 0.0) {
      let metres = distance * r2.w;
      return LightSample(axis, distance, r1.xyz * (mask / (metres * metres)), 0.0, true);
    }
    let gap = one_minus_cos_max(radius, distance);
    let wi = sample_cone(frame_from(axis), 1.0 - gap, u1, u2);
    var t = sphere_hit(p, wi, r0.xyz, radius);
    if (t < 0.0) {
      t = distance - radius;
    }
    return LightSample(wi, t, r2.xyz * mask, 1.0 / (2.0 * PI * gap), true);
  }
  let u = r1.xyz;
  let v = light_row(i, 3u).xyz;
  let normal = light_row(i, 4u).xyz;
  let q = r0.xyz + u * (u1 - 0.5) + v * (u2 - 0.5);
  let to = q - p;
  let d2 = dot(to, to);
  let distance = sqrt(d2);
  if (distance <= 0.0) {
    return out;
  }
  let wi = to / distance;
  let cos_light = -dot(wi, normal);
  if (cos_light <= 0.0) {
    return out;
  }
  return LightSample(wi, distance, r2.xyz, d2 / (r1.w * cos_light), true);
}

// A BSDF ray meeting a light: (t, radiance, solid-angle pdf); t < 0 for no hit. Lights without castShadows are never hit.
struct LightHit { t: f32, radiance: vec3f, pdf: f32 };

fn light_intersect(i: u32, o: vec3f, d: vec3f, t_max: f32) -> LightHit {
  var out = LightHit(-1.0, vec3f(0.0), 0.0);
  if (!light_casts(i)) {
    return out;
  }
  let r0 = light_row(i, 0u);
  let r1 = light_row(i, 1u);
  let r2 = light_row(i, 2u);
  let kind = u32(r0.w);
  if (kind == 0u) {
    if (r2.w > 0.0 && t_max >= BIG && dot(d, r0.xyz) >= r1.w) {
      out = LightHit(BIG, r2.xyz, 1.0 / r2.w);
    }
    return out;
  }
  if (kind == 1u) {
    let radius = r1.w;
    if (radius <= 0.0) {
      return out;
    }
    let t = sphere_hit(o, d, r0.xyz, radius);
    if (t < 0.0 || t >= t_max) {
      return out;
    }
    let distance = length(r0.xyz - o);
    if (distance <= radius) {
      return out;
    }
    let mask = spot_mask(i, (o - r0.xyz) / distance);
    return LightHit(t, r2.xyz * mask, 1.0 / (2.0 * PI * one_minus_cos_max(radius, distance)));
  }
  let normal = light_row(i, 4u).xyz;
  let denom = dot(d, normal);
  if (denom >= 0.0) {
    return out;
  }
  let t = dot(r0.xyz - o, normal) / denom;
  if (t <= 0.0 || t >= t_max) {
    return out;
  }
  let offset = o + d * t - r0.xyz;
  let u = r1.xyz;
  let v = light_row(i, 3u).xyz;
  if (abs(dot(offset, u) / dot(u, u)) > 0.5 || abs(dot(offset, v) / dot(v, v)) > 0.5) {
    return out;
  }
  return LightHit(t, r2.xyz, t * t / (r1.w * -denom));
}

// --- emissive triangles (emitters.rs): one row each (alias threshold, bitcast alias, area pdf, bitcast instance); an instance's
// row 7 x holds its first emitter (0xffffffff = none), so emitter = first + (triangle - the instance's tri_base).

fn emitter_first(instance: u32) -> u32 {
  return bitcast<u32>(objects[P.instance_base + 8u * instance + 7u].x);
}

// Area pdf the emitter sampler gives a point of global triangle `tri` of `instance`, -1 when it is not light-sampled.
fn emitter_pdf_area(instance: u32, tri: u32) -> f32 {
  if (P.emitter_count == 0u) {
    return -1.0;
  }
  let first = emitter_first(instance);
  if (first == 0xffffffffu) {
    return -1.0;
  }
  let inst = load_instance(instance);
  return objects[P.emitter_base + first + (tri - inst.tri_base)].z;
}

// A point on an emitter chosen by power: its surface, emitted radiance and area pdf (pdf 0 = none).
struct EmitterSample { s: Surface, radiance: vec3f, pdf_area: f32 };

fn emitter_sample(bin: u32, u: f32, u1: f32, u2: f32) -> EmitterSample {
  let row = objects[P.emitter_base + bin];
  var e = bin;
  if (!(u < row.x)) {
    e = bitcast<u32>(row.y);
  }
  let chosen = objects[P.emitter_base + e];
  let instance = bitcast<u32>(chosen.w);
  let inst = load_instance(instance);
  let tri = inst.tri_base + (e - emitter_first(instance));
  let root = sqrt(u1);
  let s = surface_of(Hit(0.0, instance, tri, root * (1.0 - u2), root * u2, true));
  var radiance = vec3f(0.0);
  if (s.material < P.material_count) {
    radiance = emission_at(s.material, s.uv);
  }
  return EmitterSample(s, radiance, chosen.z);
}
