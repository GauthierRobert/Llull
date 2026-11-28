// GPU path tracer, part 3 of 6: textures (texture.rs: bilinear, repeat wrap, row 0 at v = 1, sRGB decoded per texel through the CPU's
// table), materials (material.rs: factor x texture, normal map in the per-triangle tangent frame) and the environment (env.rs).

// Linear RGB of texel (x, y) of texture descriptor `desc` (offset, width, height, flags: 1 = HDR, 2 = sRGB).
fn texel(desc: vec4u, x: u32, y: u32) -> vec3f {
  let i = y * desc.y + x;
  if ((desc.w & 1u) != 0u) {
    let j = desc.x + 3u * i;
    return vec3f(hdr[j], hdr[j + 1u], hdr[j + 2u]);
  }
  let p = ldr[desc.x + i];
  let c = vec3u(p & 255u, (p >> 8u) & 255u, (p >> 16u) & 255u);
  if ((desc.w & 2u) != 0u) {
    return vec3f(hdr[P.srgb_table + c.x], hdr[P.srgb_table + c.y], hdr[P.srgb_table + c.z]);
  }
  return vec3f(c) * (1.0 / 255.0);
}

fn wrap(i: i32, n: i32) -> u32 {
  return u32(((i % n) + n) % n);
}

// Bilinear sample at (u, v): repeat wrap in u; in v repeat (materials) or clamp (`clamp_v`, the environment's poles).
fn tex_sample(index: u32, u: f32, v: f32, clamp_v: bool) -> vec3f {
  if (!finite(u) || !finite(v)) {
    return vec3f(0.0);
  }
  let desc = bitcast<vec4u>(objects[P.texture_base + index]);
  let w = i32(desc.y);
  let h = i32(desc.z);
  let x = u * f32(desc.y) - 0.5;
  let y = (1.0 - v) * f32(desc.z) - 0.5;
  let x0 = floor(x);
  let y0 = floor(y);
  let fx = x - x0;
  let fy = y - y0;
  let xi = i32(x0);
  let yi = i32(y0);
  let xa = wrap(xi, w);
  let xb = wrap(xi + 1, w);
  var ya: u32;
  var yb: u32;
  if (clamp_v) {
    ya = u32(clamp(yi, 0, h - 1));
    yb = u32(clamp(yi + 1, 0, h - 1));
  } else {
    ya = wrap(yi, h);
    yb = wrap(yi + 1, h);
  }
  let top = lerp3(texel(desc, xa, ya), texel(desc, xb, ya), fx);
  let bottom = lerp3(texel(desc, xa, yb), texel(desc, xb, yb), fx);
  return lerp3(top, bottom, fy);
}

struct Resolved { params: Shading, emission: vec3f, ns: vec3f };

// Optional texture index stored as a float (-1 = none).
fn lookup(index: f32, uv: vec2f) -> vec4f {
  if (index < 0.0) {
    return vec4f(0.0);
  }
  return vec4f(tex_sample(u32(index), uv.x, uv.y, false), 1.0);
}

fn scalar(factor: f32, index: f32, uv: vec2f) -> f32 {
  let t = lookup(index, uv);
  return clamp(factor * select(1.0, t.x, t.w > 0.0), 0.0, 1.0);
}

// Tangent-space normal map texel to a world shading normal; xy scaled by `scale` (material.rs `perturb`).
fn perturb(s: Surface, texel: vec3f, scale: f32) -> vec3f {
  let n = s.ns;
  let t0 = s.tangent - n * dot(n, s.tangent);
  var t: vec3f;
  var b: vec3f;
  if (length(t0) > 1e-12) {
    t = unit(t0);
    b = cross(n, t);
    if (dot(b, s.bitangent) < 0.0) {
      b = -b;
    }
  } else {
    let f = frame_from(n);
    t = f.s;
    b = f.t;
  }
  let local = vec3f((2.0 * texel.x - 1.0) * scale, (2.0 * texel.y - 1.0) * scale, 2.0 * texel.z - 1.0);
  let perturbed = unit(t * local.x + b * local.y + n * local.z);
  if (finite3(perturbed) && dot(perturbed, n) > 0.0) {
    return perturbed;
  }
  return n;
}

// Material rows (5 vec4): (baseColor, tex) (emission, tex) (metalness, tex, roughness, tex) (transmission, tex, coat, tex)
// (normal tex, normalScale, ior, coatRoughness).
fn resolve(m: u32, s: Surface) -> Resolved {
  let b = P.material_base + 5u * m;
  let r0 = objects[b];
  let r1 = objects[b + 1u];
  let r2 = objects[b + 2u];
  let r3 = objects[b + 3u];
  let r4 = objects[b + 4u];
  let uv = s.uv;
  let bt = lookup(r0.w, uv);
  let base = select(r0.xyz, bt.xyz * r0.xyz, bt.w > 0.0);
  let et = lookup(r1.w, uv);
  let emission = select(r1.xyz, et.xyz * r1.xyz, et.w > 0.0);
  var ns = s.ns;
  let nt = lookup(r4.x, uv);
  if (nt.w > 0.0) {
    ns = perturb(s, nt.xyz, r4.y);
  }
  let params = Shading(base, scalar(r2.x, r2.y, uv), scalar(r2.z, r2.w, uv), scalar(r3.x, r3.y, uv), r4.z, scalar(r3.z, r3.w, uv), r4.w);
  return Resolved(params, emission, ns);
}

// --- environment (env.rs): uniform radiance or an equirectangular map with a piecewise-constant importance-sampling CDF.

fn env_desc() -> vec4u {
  return bitcast<vec4u>(objects[P.texture_base + P.env_texture]);
}

// (u, v, cos elevation) of a world direction turned by -rotation about +Z.
fn env_uv(d: vec3f) -> vec3f {
  let c = P.env_rot.x;
  let s = P.env_rot.y;
  let x = c * d.x + s * d.y;
  let y = -s * d.x + c * d.y;
  let z = clamp(d.z, -1.0, 1.0);
  let u = 0.5 + atan2(-y, x) / (2.0 * PI);
  let v = 0.5 + asin(z) / PI;
  return vec3f(u, v, sqrt(max(1.0 - z * z, 0.0)));
}

fn env_radiance(d: vec3f) -> vec3f {
  if (P.env_kind == 0u) {
    return P.env_color.xyz;
  }
  let uv = env_uv(d);
  return tex_sample(P.env_texture, uv.x, uv.y, true) * P.env_color.w;
}

fn env_pdf(d: vec3f) -> f32 {
  if (P.env_kind == 0u) {
    return 0.0;
  }
  let uv = env_uv(d);
  if (uv.z <= 0.0) {
    return 0.0;
  }
  let desc = env_desc();
  let w = desc.y;
  let h = desc.z;
  let col = min(u32(fract(uv.x) * f32(w)), w - 1u);
  let row = min(u32(max((1.0 - uv.y) * f32(h), 0.0)), h - 1u);
  let cdf = P.env_conditional + row * (w + 1u);
  let texel_pdf = hdr[P.env_rows + row] * (hdr[cdf + col + 1u] - hdr[cdf + col]) * f32(w * h);
  return texel_pdf / (2.0 * PI * PI * uv.z);
}

// Index of the CDF bucket holding u (cdf[i] <= u < cdf[i + 1]) of a CDF with `len` entries at `base`.
fn find(base: u32, len: u32, u: f32) -> u32 {
  var lo = 0u;
  var hi = len;
  while (lo < hi) {
    let mid = (lo + hi) / 2u;
    if (hdr[base + mid] <= u) {
      lo = mid + 1u;
    } else {
      hi = mid;
    }
  }
  return min(select(lo - 1u, 0u, lo == 0u), len - 2u);
}

struct EnvSample { wi: vec3f, radiance: vec3f, pdf: f32, ok: bool };

fn env_sample(u1: f32, u2: f32) -> EnvSample {
  var out = EnvSample(vec3f(0.0), vec3f(0.0), 0.0, false);
  if (P.env_kind == 0u) {
    return out;
  }
  let desc = env_desc();
  let w = desc.y;
  let h = desc.z;
  let row = find(P.env_marginal, h + 1u, u1);
  let m0 = hdr[P.env_marginal + row];
  let row_span = hdr[P.env_marginal + row + 1u] - m0;
  let fy = select(0.5, clamp((u1 - m0) / row_span, 0.0, 0.999999), row_span > 0.0);
  let cdf = P.env_conditional + row * (w + 1u);
  let col = find(cdf, w + 1u, u2);
  let c0 = hdr[cdf + col];
  let col_span = hdr[cdf + col + 1u] - c0;
  let fx = select(0.5, clamp((u2 - c0) / col_span, 0.0, 0.999999), col_span > 0.0);
  let u = (f32(col) + fx) / f32(w);
  let v = 1.0 - (f32(row) + fy) / f32(h);
  let elevation = (v - 0.5) * PI;
  let azimuth = (u - 0.5) * 2.0 * PI;
  let cos_e = cos(elevation);
  let x = cos_e * cos(azimuth);
  let y = -cos_e * sin(azimuth);
  let c = P.env_rot.x;
  let s = P.env_rot.y;
  let d = vec3f(c * x - s * y, s * x + c * y, sin(elevation));
  if (cos_e <= 0.0) {
    return out;
  }
  let pdf = env_pdf(d);
  if (pdf > 0.0) {
    out = EnvSample(d, env_radiance(d), pdf, true);
  }
  return out;
}
