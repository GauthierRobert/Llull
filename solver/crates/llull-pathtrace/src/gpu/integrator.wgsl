// GPU path tracer, part 6 of 6: the camera (camera.rs), the path integrator (integrator.rs: NEE to every light and the map, MIS with
// the power heuristic, Russian roulette after three bounces) and the kernel: one invocation per pixel of the tile, `P.samples`
// samples added to the pixel's accumulator (blocks whose activity word is 0 have met targetNoise and are skipped).

fn power_heuristic(a: f32, b: f32) -> f32 {
  let a2 = a * a;
  let b2 = b * b;
  if (a2 + b2 > 0.0 && finite(a2 + b2)) {
    return a2 / (a2 + b2);
  }
  return select(0.0, 1.0, !finite(a) && a > 0.0);
}

// Radiance escaping along a BSDF ray (MIS against the map and the sun cones when `has_pdf`).
fn escaped(d: vec3f, has_pdf: bool, bsdf_pdf: f32) -> vec3f {
  var l = env_radiance(d);
  if (!has_pdf) {
    return l;
  }
  l = l * power_heuristic(bsdf_pdf, env_pdf(d));
  for (var i = 0u; i < P.light_count; i = i + 1u) {
    if (light_kind(i) != 0u) {
      continue;
    }
    let h = light_intersect(i, vec3f(0.0), d, BIG);
    if (h.t >= 0.0) {
      l = l + h.radiance * power_heuristic(bsdf_pdf, h.pdf);
    }
  }
  return l;
}

// Nearest sphere / rect light hit before t_max (suns are met only by escaping rays).
fn light_hit(o: vec3f, d: vec3f, t_max: f32) -> LightHit {
  var best = LightHit(-1.0, vec3f(0.0), 0.0);
  var limit = t_max;
  for (var i = 0u; i < P.light_count; i = i + 1u) {
    if (light_kind(i) == 0u) {
      continue;
    }
    let h = light_intersect(i, o, d, limit);
    if (h.t >= 0.0 && h.t < BIG) {
      best = h;
      limit = h.t;
    }
  }
  return best;
}

fn shadowed(p: vec3f, ng: vec3f, wi: vec3f, distance: f32) -> bool {
  let origin = offset_ray(p, select(-ng, ng, dot(wi, ng) > 0.0));
  let t_max = select(BIG, distance * (1.0 - 1e-4), distance < BIG);
  return trace(origin, wi, t_max, true).found;
}

fn direct(b: Placed, p: vec3f, wo: vec3f) -> vec3f {
  var l = vec3f(0.0);
  for (var i = 0u; i < P.light_count; i = i + 1u) {
    let u1 = rand();
    let u2 = rand();
    let s = light_sample(i, p, u1, u2);
    if (!s.ok || is_black(s.value)) {
      continue;
    }
    let e = placed_eval(b, wo, s.wi);
    if (is_black(e.xyz)) {
      continue;
    }
    let casts = light_casts(i);
    var weight = 1.0;
    if (s.pdf > 0.0) {
      weight = select(1.0 / s.pdf, power_heuristic(s.pdf, e.w) / s.pdf, casts);
    }
    if (casts && shadowed(p, b.ng, s.wi, s.distance)) {
      continue;
    }
    l = l + e.xyz * s.value * (placed_cos(b, s.wi) * weight);
  }
  let u1 = rand();
  let u2 = rand();
  let s = env_sample(u1, u2);
  if (s.ok) {
    let e = placed_eval(b, wo, s.wi);
    if (!is_black(e.xyz) && !shadowed(p, b.ng, s.wi, BIG)) {
      l = l + e.xyz * s.radiance * (placed_cos(b, s.wi) * power_heuristic(s.pdf, e.w) / s.pdf);
    }
  }
  return l;
}

struct Path { l: vec3f, albedo: vec3f, normal: vec3f, depth: f32 };

fn radiance(o_in: vec3f, d_in: vec3f) -> Path {
  var o = o_in;
  var d = d_in;
  var out = Path(vec3f(0.0), vec3f(1.0), vec3f(0.0), BIG);
  var beta = vec3f(1.0);
  var has_pdf = false;
  var bsdf_pdf = 0.0;
  var depth = 0u;
  loop {
    let hit = trace(o, d, BIG, false);
    if (has_pdf) {
      let lh = light_hit(o, d, select(BIG, hit.t, hit.found));
      if (lh.t >= 0.0) {
        out.l = out.l + beta * lh.radiance * power_heuristic(bsdf_pdf, lh.pdf);
        break;
      }
    }
    if (!hit.found) {
      out.l = out.l + beta * escaped(d, has_pdf, bsdf_pdf);
      break;
    }
    let s = surface_of(hit);
    if (s.material >= P.material_count) {
      break;
    }
    let r = resolve(s.material, s);
    let wo = -d;
    var ns = r.ns;
    if (dot(wo, ns) * dot(wo, s.ng) <= 0.0) {
      ns = s.ng;
    }
    if (depth == 0u) {
      out.albedo = r.params.base;
      out.normal = ns;
      out.depth = hit.t;
    }
    out.l = out.l + beta * r.emission;
    if (depth >= P.max_bounces) {
      break;
    }
    let b = Placed(frame_from(ns), s.ng, make_bsdf(r.params));
    out.l = out.l + beta * direct(b, s.p, wo);
    let u = rand();
    let u1 = rand();
    let u2 = rand();
    let smp = placed_sample(b, wo, u, u1, u2);
    if (!smp.ok) {
      break;
    }
    beta = beta * smp.f * (placed_cos(b, smp.wi) / smp.pdf);
    if (!finite3(beta) || is_black(beta)) {
      break;
    }
    has_pdf = true;
    bsdf_pdf = smp.pdf;
    o = offset_ray(s.p, select(-s.ng, s.ng, dot(smp.wi, s.ng) > 0.0));
    d = smp.wi;
    depth = depth + 1u;
    if (depth >= 3u) {
      let survive = min(max3(beta), 0.95);
      if (rand() >= survive) {
        break;
      }
      beta = beta / survive;
    }
  }
  return out;
}

fn tent(u: f32) -> f32 {
  let r = 2.0 * u;
  if (r < 1.0) {
    return sqrt(r) - 1.0;
  }
  return 1.0 - sqrt(max(2.0 - r, 0.0));
}

// Concentric square-to-disk map (Shirley and Chiu).
fn disk(u1: f32, u2: f32) -> vec2f {
  let a = 2.0 * u1 - 1.0;
  let b = 2.0 * u2 - 1.0;
  if (a == 0.0 && b == 0.0) {
    return vec2f(0.0);
  }
  var r = b;
  var theta = PI / 2.0 - PI / 4.0 * (a / b);
  if (abs(a) > abs(b)) {
    r = a;
    theta = PI / 4.0 * (b / a);
  }
  return vec2f(r * cos(theta), r * sin(theta));
}

struct Ray { o: vec3f, d: vec3f };

fn camera_ray(x: u32, y: u32) -> Ray {
  let j0 = rand();
  let j1 = rand();
  let l0 = rand();
  let l1 = rand();
  let px = f32(x) + 0.5 + tent(j0);
  let py = f32(y) + 0.5 + tent(j1);
  let aspect = f32(P.width) / f32(P.height);
  let sx = (2.0 * px / f32(P.width) - 1.0) * aspect;
  let sy = 1.0 - 2.0 * py / f32(P.height);
  let forward = P.cam_forward.xyz;
  let right = P.cam_right.xyz;
  let up = P.cam_up.xyz;
  var o = P.cam_pos.xyz;
  var d = forward;
  if (P.projection == 0u) {
    d = unit(forward + right * (sx * P.cam_pos.w) + up * (sy * P.cam_pos.w));
  } else {
    o = o + right * (sx * P.cam_forward.w) + up * (sy * P.cam_forward.w);
  }
  if (P.cam_right.w <= 0.0) {
    return Ray(o, d);
  }
  let focus_point = o + d * (P.cam_up.w / dot(d, forward));
  let lens2 = disk(l0, l1);
  let lens = o + right * (lens2.x * P.cam_right.w) + up * (lens2.y * P.cam_right.w);
  return Ray(lens, unit(focus_point - lens));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.tile_w || gid.y >= P.tile_h) {
    return;
  }
  let block = (gid.y / 16u) * P.tile_blocks_x + gid.x / 16u;
  if (accum[P.mask_base + block] < 0.5) {
    return;
  }
  let x = P.tile_x + gid.x;
  let y = P.tile_y + gid.y;
  let pixel = y * P.width + x;
  let a = (gid.y * P.tile_w + gid.x) * ACC;
  var rgb = vec3f(accum[a], accum[a + 1u], accum[a + 2u]);
  var mean = accum[a + 3u];
  var m2 = accum[a + 4u];
  var albedo = vec3f(accum[a + 5u], accum[a + 6u], accum[a + 7u]);
  var normal = vec3f(accum[a + 8u], accum[a + 9u], accum[a + 10u]);
  var depth = accum[a + 11u];
  var hits = accum[a + 12u];
  var n = accum[a + 13u];
  for (var k = 0u; k < P.samples; k = k + 1u) {
    rng_start(pixel, u32(n));
    let ray = camera_ray(x, y);
    let path = radiance(ray.o, ray.d);
    var l = path.l;
    if (!finite3(l)) {
      l = vec3f(0.0);
    }
    rgb = rgb + l;
    n = n + 1.0;
    let lum = luminance(l);
    let delta = lum - mean;
    mean = mean + delta / n;
    m2 = m2 + delta * (lum - mean);
    if (path.depth < BIG) {
      hits = hits + 1.0;
      depth = depth + path.depth;
      albedo = albedo + path.albedo;
      normal = normal + path.normal;
    } else {
      albedo = albedo + vec3f(1.0);
    }
  }
  accum[a] = rgb.x;
  accum[a + 1u] = rgb.y;
  accum[a + 2u] = rgb.z;
  accum[a + 3u] = mean;
  accum[a + 4u] = m2;
  accum[a + 5u] = albedo.x;
  accum[a + 6u] = albedo.y;
  accum[a + 7u] = albedo.z;
  accum[a + 8u] = normal.x;
  accum[a + 9u] = normal.y;
  accum[a + 10u] = normal.z;
  accum[a + 11u] = depth;
  accum[a + 12u] = hits;
  accum[a + 13u] = n;
}
