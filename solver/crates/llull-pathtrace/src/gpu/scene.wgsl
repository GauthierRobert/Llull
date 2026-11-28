// GPU path tracer, part 2 of 6: the two-level BVH walk and the surface point of a hit (ports of bvh.rs and scene.rs). The trees are
// the CPU's own (same build), flattened by pack.rs; an instance ray is moved into mesh space without renormalising, so t is shared.

struct Hit { t: f32, instance: u32, tri: u32, u: f32, v: f32, found: bool };

struct Instance {
  to_world: array<vec4f, 3>,
  to_local: array<vec4f, 3>,
  node_base: u32,
  tri_base: u32,
  material: u32,
  empty: bool,
};

fn load_instance(i: u32) -> Instance {
  let b = P.instance_base + 8u * i;
  let w = bitcast<vec4u>(objects[b + 6u]);
  return Instance(
    array<vec4f, 3>(objects[b], objects[b + 1u], objects[b + 2u]),
    array<vec4f, 3>(objects[b + 3u], objects[b + 4u], objects[b + 5u]),
    w.x, w.y, w.z, w.w != 0u,
  );
}

fn xform_point(m: array<vec4f, 3>, p: vec3f) -> vec3f {
  return vec3f(dot(m[0].xyz, p) + m[0].w, dot(m[1].xyz, p) + m[1].w, dot(m[2].xyz, p) + m[2].w);
}

fn xform_vector(m: array<vec4f, 3>, v: vec3f) -> vec3f {
  return vec3f(dot(m[0].xyz, v), dot(m[1].xyz, v), dot(m[2].xyz, v));
}

// Transposed linear part times v: with the world-to-local inverse this maps a local normal to world.
fn xform_transpose(m: array<vec4f, 3>, v: vec3f) -> vec3f {
  return m[0].xyz * v.x + m[1].xyz * v.y + m[2].xyz * v.z;
}

// 1 / d with zero components replaced by a tiny value: keeps the slab test free of 0 * inf.
fn safe_inverse(d: vec3f) -> vec3f {
  return 1.0 / select(vec3f(1e-30), d, abs(d) > vec3f(1e-30));
}

// Slab test: entry distance when the ray meets the box within (0, t_max), else -1.
fn box_hit(node: u32, o: vec3f, inv: vec3f, t_max: f32) -> f32 {
  let t1 = (nodes[2u * node].xyz - o) * inv;
  let t2 = (nodes[2u * node + 1u].xyz - o) * inv;
  let near = max(max3(min(t1, t2)), 0.0);
  let f = max(t1, t2);
  let far = min(min(f.x, f.y), min(f.z, t_max));
  return select(-1.0, near, near <= far);
}

// Möller-Trumbore; (t, u, v) of a hit with t in (0, t_max), x < 0 for a miss.
fn triangle_hit(o: vec3f, d: vec3f, a: vec3f, b: vec3f, c: vec3f, t_max: f32) -> vec3f {
  let e1 = b - a;
  let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (det == 0.0 || !finite(det)) {
    return vec3f(-1.0);
  }
  let inv = 1.0 / det;
  let s = o - a;
  let u = dot(s, p) * inv;
  if (!(u >= 0.0 && u <= 1.0)) {
    return vec3f(-1.0);
  }
  let q = cross(s, e1);
  let v = dot(d, q) * inv;
  if (v < 0.0 || u + v > 1.0) {
    return vec3f(-1.0);
  }
  let t = dot(e2, q) * inv;
  if (t > 0.0 && t < t_max) {
    return vec3f(t, u, v);
  }
  return vec3f(-1.0);
}

fn position(i: u32) -> vec3f {
  return verts[2u * i].xyz;
}

// Nearest-first walk of one instance's BLAS in mesh space; updates `best` with a closer hit.
fn walk_blas(inst: Instance, index: u32, o: vec3f, d: vec3f, any: bool, best: ptr<function, Hit>) {
  let inv = safe_inverse(d);
  let root = inst.node_base;
  if (box_hit(root, o, inv, (*best).t) < 0.0) {
    return;
  }
  var stack: array<u32, STACK>;
  stack[0] = 0u;
  var top = 1u;
  while (top > 0u) {
    top = top - 1u;
    let node = root + stack[top];
    let first = bitcast<u32>(nodes[2u * node].w);
    let count = bitcast<u32>(nodes[2u * node + 1u].w);
    if (count > 0u) {
      for (var k = first; k < first + count; k = k + 1u) {
        let tri = inst.tri_base + k;
        let a = position(words[3u * tri]);
        let b = position(words[3u * tri + 1u]);
        let c = position(words[3u * tri + 2u]);
        let h = triangle_hit(o, d, a, b, c, (*best).t);
        if (h.x >= 0.0) {
          *best = Hit(h.x, index, tri, h.y, h.z, true);
          if (any) {
            return;
          }
        }
      }
      continue;
    }
    let left = box_hit(root + first, o, inv, (*best).t);
    let right = box_hit(root + first + 1u, o, inv, (*best).t);
    if (left >= 0.0 && right >= 0.0) {
      let near_right = right < left;
      stack[top] = select(first + 1u, first, near_right);
      stack[top + 1u] = select(first, first + 1u, near_right);
      top = top + 2u;
    } else if (left >= 0.0) {
      stack[top] = first;
      top = top + 1u;
    } else if (right >= 0.0) {
      stack[top] = first + 1u;
      top = top + 1u;
    }
  }
}

// Closest hit (or, with `any`, the first) along a world ray within (0, t_max).
fn trace(o: vec3f, d: vec3f, t_max: f32, any: bool) -> Hit {
  var best = Hit(t_max, 0u, 0u, 0.0, 0.0, false);
  if (P.instance_count == 0u) {
    return best;
  }
  let inv = safe_inverse(d);
  let root = P.tlas_nodes;
  if (box_hit(root, o, inv, t_max) < 0.0) {
    return best;
  }
  var stack: array<u32, STACK>;
  stack[0] = 0u;
  var top = 1u;
  while (top > 0u) {
    top = top - 1u;
    let node = root + stack[top];
    let first = bitcast<u32>(nodes[2u * node].w);
    let count = bitcast<u32>(nodes[2u * node + 1u].w);
    if (count > 0u) {
      for (var k = first; k < first + count; k = k + 1u) {
        let index = words[P.tlas_order + k];
        let inst = load_instance(index);
        if (inst.empty) {
          continue;
        }
        walk_blas(inst, index, xform_point(inst.to_local, o), xform_vector(inst.to_local, d), any, &best);
        if (any && best.found) {
          return best;
        }
      }
      continue;
    }
    let left = box_hit(root + first, o, inv, best.t);
    let right = box_hit(root + first + 1u, o, inv, best.t);
    if (left >= 0.0 && right >= 0.0) {
      let near_right = right < left;
      stack[top] = select(first + 1u, first, near_right);
      stack[top + 1u] = select(first, first + 1u, near_right);
      top = top + 2u;
    } else if (left >= 0.0) {
      stack[top] = first;
      top = top + 1u;
    } else if (right >= 0.0) {
      stack[top] = first + 1u;
      top = top + 1u;
    }
  }
  return best;
}

// Shading inputs at a hit, in world space; ng points to the side of the interpolated normal.
struct Surface { p: vec3f, ng: vec3f, ns: vec3f, uv: vec2f, tangent: vec3f, bitangent: vec3f, material: u32 };

fn surface_of(hit: Hit) -> Surface {
  let inst = load_instance(hit.instance);
  let ia = words[3u * hit.tri];
  let ib = words[3u * hit.tri + 1u];
  let ic = words[3u * hit.tri + 2u];
  let w = 1.0 - hit.u - hit.v;
  let va0 = verts[2u * ia];
  let vb0 = verts[2u * ib];
  let vc0 = verts[2u * ic];
  let va1 = verts[2u * ia + 1u];
  let vb1 = verts[2u * ib + 1u];
  let vc1 = verts[2u * ic + 1u];
  let pa = xform_point(inst.to_world, va0.xyz);
  let pb = xform_point(inst.to_world, vb0.xyz);
  let pc = xform_point(inst.to_world, vc0.xyz);
  let p = pa * w + pb * hit.u + pc * hit.v;
  let e1 = pb - pa;
  let e2 = pc - pa;
  var ng = unit(cross(e1, e2));
  let local_n = va1.xyz * w + vb1.xyz * hit.u + vc1.xyz * hit.v;
  var ns = unit(xform_transpose(inst.to_local, local_n));
  if (!finite3(ns) || length(ns) < 0.5) {
    ns = ng;
  }
  if (dot(ng, ns) < 0.0) {
    ng = -ng;
  }
  let ua = vec2f(va0.w, va1.w);
  let ub = vec2f(vb0.w, vb1.w);
  let uc = vec2f(vc0.w, vc1.w);
  let uv = ua * w + ub * hit.u + uc * hit.v;
  let du1 = ub.x - ua.x;
  let dv1 = ub.y - ua.y;
  let du2 = uc.x - ua.x;
  let dv2 = uc.y - ua.y;
  let r = du1 * dv2 - du2 * dv1;
  var tangent = vec3f(0.0);
  var bitangent = vec3f(0.0);
  if (abs(r) > 1e-12) {
    let inv = 1.0 / r;
    tangent = (e1 * dv2 - e2 * dv1) * inv;
    bitangent = (e2 * du1 - e1 * du2) * inv;
  }
  return Surface(p, ng, ns, uv, tangent, bitangent, inst.material);
}
