//! Flattens a loaded `World` into the GPU buffers the WGSL reads (row layouts in the headers of `common.wgsl`, `lights.wgsl` and
//! `material.wgsl`) and checks them against the device limits first, so an oversized scene is a named fallback reason and never a
//! failed allocation. The BVHs are the CPU's own trees (same build), only re-indexed into shared arrays:
//!
//! - `nodes` (32 B per node): every BLAS, mesh after mesh, then the TLAS; child / leaf indices stay local to their tree.
//! - `words` (4 B): 3 global vertex indices per triangle (BLAS leaf order, mesh after mesh), then the TLAS instance order.
//! - `verts` (32 B per vertex): position + u, normal + v.
//! - `objects` (16 B rows): instances (8 rows: to-world, to-local, BLAS bases), materials (5), lights (6), texture descriptors (1).
//! - `ldr` (4 B per texel, RGBA8) and `hdr` (12 B per texel, then the environment CDFs and the sRGB decode table).

use crate::bvh::Bvh;
use crate::env::Environment;
use crate::integrator::World;
use crate::lights::Shape;
use crate::texture::{srgb_table, Pixels, Texture};
use std::sync::Arc;

/// BVH traversal stack of the WGSL (`STACK`); a deeper tree falls back to the CPU.
pub const STACK: usize = 64;
const INSTANCE_ROWS: usize = 8;
const MATERIAL_ROWS: usize = 5;
const LIGHT_ROWS: usize = 6;

/// Offsets of the sections the kernel reads (units: nodes, words, rows or floats of their buffer).
#[derive(Debug, Clone, Copy, Default)]
pub struct Layout {
    pub tlas_nodes: u32,
    pub tlas_order: u32,
    pub instance_base: u32,
    pub material_base: u32,
    pub light_base: u32,
    pub texture_base: u32,
    pub env_kind: u32,
    pub env_texture: u32,
    pub env_marginal: u32,
    pub env_conditional: u32,
    pub env_rows: u32,
    pub srgb_table: u32,
    /// GGX albedo tables (`albedo::flattened`).
    pub albedo_table: u32,
    pub env_color: [f32; 4],
    pub env_rot: [f32; 4],
}

#[derive(Debug, Clone, Default)]
pub struct Packed {
    pub nodes: Vec<[f32; 4]>,
    pub words: Vec<u32>,
    pub verts: Vec<[f32; 4]>,
    pub objects: Vec<[f32; 4]>,
    pub ldr: Vec<u32>,
    pub hdr: Vec<f32>,
    pub layout: Layout,
}

/// The device limits a scene must fit.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Largest storage buffer binding in bytes (min of the binding and buffer limits).
    pub max_binding: u64,
}

/// Deepest level of a tree (root = 0).
pub fn depth(bvh: &Bvh) -> usize {
    let mut deepest = 0;
    let mut stack = vec![(0usize, 0usize)];
    while let Some((node, level)) = stack.pop() {
        deepest = deepest.max(level);
        let n = &bvh.nodes[node];
        if n.count == 0 && !bvh.order.is_empty() && (n.first as usize + 1) < bvh.nodes.len() {
            stack.push((n.first as usize, level + 1));
            stack.push((n.first as usize + 1, level + 1));
        }
    }
    deepest
}

fn env_map(world: &World) -> Option<&crate::env::EnvMap> {
    match &world.environment {
        Environment::Map(map) => Some(map),
        Environment::Uniform(_) => None,
    }
}

fn texel_count(t: &Texture) -> u64 {
    u64::from(t.width) * u64::from(t.height)
}

/// Byte sizes of the six buffers, named, before anything is allocated.
fn sizes(world: &World, env_extra: Option<&Arc<Texture>>) -> [(&'static str, u64); 6] {
    let g = &world.geometry;
    let nodes: u64 = g.meshes.iter().map(|m| m.bvh.nodes.len() as u64).sum::<u64>() + g.tlas.nodes.len() as u64;
    let triangles = g.triangle_count() as u64;
    let textures = world.textures.iter().chain(env_extra);
    let (mut ldr, mut hdr) = (0u64, 0u64);
    for t in textures {
        match t.pixels {
            Pixels::Ldr(_) => ldr += texel_count(t),
            Pixels::Hdr(_) => hdr += 3 * texel_count(t),
        }
    }
    if let Some(map) = env_map(world) {
        hdr += (map.marginal.len() + map.conditional.len() + map.row_weights.len()) as u64;
    }
    let objects = INSTANCE_ROWS * g.instances.len()
        + MATERIAL_ROWS * world.materials.len()
        + LIGHT_ROWS * world.lights.len()
        + world.textures.len()
        + 1;
    [
        ("BVH nodes", nodes * 32),
        ("triangle indices", (3 * triangles + g.instances.len() as u64) * 4),
        ("vertices", g.positions.len() as u64 * 32),
        ("instances, materials and lights", objects as u64 * 16),
        ("8-bit textures", ldr * 4),
        ("HDR textures", (hdr + 256 + crate::albedo::flattened().len() as u64) * 4),
    ]
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

/// Refuses a scene the GPU cannot hold: a buffer over the binding limit, a BVH deeper than the stack, or an index past u32.
pub fn check(world: &World, limits: Limits) -> Result<(), String> {
    let env_extra = env_extra(world);
    for (name, bytes) in sizes(world, env_extra.as_ref()) {
        if bytes > limits.max_binding || bytes / 4 > u64::from(u32::MAX) {
            return Err(format!(
                "the scene's {name} ({:.1} MiB) exceed this GPU's {:.1} MiB storage-buffer limit",
                mib(bytes),
                mib(limits.max_binding)
            ));
        }
    }
    let g = &world.geometry;
    let deepest = g.meshes.iter().map(|m| depth(&m.bvh)).chain(std::iter::once(depth(&g.tlas))).max().unwrap_or(0);
    if deepest + 2 > STACK {
        return Err(format!("a BVH is {deepest} levels deep, over the GPU traversal stack of {STACK}"));
    }
    Ok(())
}

/// The environment map's texture when it is not one of the job's textures (the baked sky).
fn env_extra(world: &World) -> Option<Arc<Texture>> {
    let map = env_map(world)?;
    (!world.textures.iter().any(|t| Arc::ptr_eq(t, &map.texture))).then(|| Arc::clone(&map.texture))
}

fn bits(value: u32) -> f32 {
    f32::from_bits(value)
}

fn texture_index(index: Option<u32>) -> f32 {
    index.map_or(-1.0, |i| i as f32)
}

fn push_geometry(world: &World, out: &mut Packed) {
    let g = &world.geometry;
    for (p, (n, uv)) in g.positions.iter().zip(g.normals.iter().zip(&g.uvs)) {
        out.verts.push([p.x, p.y, p.z, uv[0]]);
        out.verts.push([n.x, n.y, n.z, uv[1]]);
    }
    let push_tree = |bvh: &Bvh, nodes: &mut Vec<[f32; 4]>| {
        for node in &bvh.nodes {
            let b = node.bounds;
            nodes.push([b.min.x, b.min.y, b.min.z, bits(node.first)]);
            nodes.push([b.max.x, b.max.y, b.max.z, bits(node.count)]);
        }
    };
    let mut bases = Vec::with_capacity(g.meshes.len());
    for mesh in &g.meshes {
        bases.push(((out.nodes.len() / 2) as u32, (out.words.len() / 3) as u32, mesh.triangles.is_empty()));
        push_tree(&mesh.bvh, &mut out.nodes);
        out.words.extend(mesh.triangles.iter().flatten());
    }
    out.layout.tlas_nodes = (out.nodes.len() / 2) as u32;
    push_tree(&g.tlas, &mut out.nodes);
    out.layout.tlas_order = out.words.len() as u32;
    out.words.extend(&g.tlas.order);
    out.layout.instance_base = out.objects.len() as u32;
    for instance in &g.instances {
        out.objects.extend(instance.to_world.m);
        out.objects.extend(instance.to_local.m);
        let (node_base, tri_base, empty) = bases[instance.mesh as usize];
        out.objects.push([bits(node_base), bits(tri_base), bits(instance.material), bits(u32::from(empty))]);
        out.objects.push([0.0; 4]);
    }
}

fn push_materials(world: &World, out: &mut Packed) {
    out.layout.material_base = out.objects.len() as u32;
    for m in &world.materials {
        let (c, e) = (m.base_color, m.emission);
        out.objects.push([c.x, c.y, c.z, texture_index(m.base_color_texture)]);
        out.objects.push([e.x, e.y, e.z, texture_index(m.emission_texture)]);
        out.objects.push([m.metalness, texture_index(m.metalness_texture), m.roughness, texture_index(m.roughness_texture)]);
        out.objects.push([m.transmission, texture_index(m.transmission_texture), m.coat, texture_index(m.coat_texture)]);
        out.objects.push([texture_index(m.normal_texture), m.normal_scale, m.ior, m.coat_roughness]);
    }
}

fn push_lights(world: &World, out: &mut Packed) {
    out.layout.light_base = out.objects.len() as u32;
    for light in &world.lights {
        let mut rows = [[0.0f32; 4]; LIGHT_ROWS];
        match light.shape {
            Shape::Sun { direction: d, irradiance: e, cos_max, solid_angle, radiance: l, .. } => {
                rows[0] = [d.x, d.y, d.z, 0.0];
                rows[1] = [e.x, e.y, e.z, cos_max];
                rows[2] = [l.x, l.y, l.z, solid_angle];
            }
            Shape::Sphere { centre: c, radius, intensity: i, radiance: l, unit_metres, spot } => {
                rows[0] = [c.x, c.y, c.z, 1.0];
                rows[1] = [i.x, i.y, i.z, radius];
                rows[2] = [l.x, l.y, l.z, unit_metres];
                if let Some(spot) = spot {
                    let a = spot.direction;
                    rows[3] = [a.x, a.y, a.z, spot.cos_half];
                    rows[4] = [spot.blend, 1.0, 0.0, 0.0];
                }
            }
            Shape::Rect { centre: c, u, v, normal: n, area, radiance: l } => {
                rows[0] = [c.x, c.y, c.z, 2.0];
                rows[1] = [u.x, u.y, u.z, area];
                rows[2] = [l.x, l.y, l.z, 0.0];
                rows[3] = [v.x, v.y, v.z, 0.0];
                rows[4] = [n.x, n.y, n.z, 0.0];
            }
        }
        rows[5][0] = if light.cast_shadows { 1.0 } else { 0.0 };
        out.objects.extend(rows);
    }
}

fn push_texture(t: &Texture, out: &mut Packed) {
    let (flags, offset) = match &t.pixels {
        Pixels::Ldr(texels) => {
            let offset = out.ldr.len() as u32;
            out.ldr.extend(texels.iter().map(|p| u32::from_le_bytes(*p)));
            (if t.srgb { 2 } else { 0 }, offset)
        }
        Pixels::Hdr(texels) => {
            let offset = out.hdr.len() as u32;
            out.hdr.extend(texels.iter().flat_map(|v| [v.x, v.y, v.z]));
            (1, offset)
        }
    };
    out.objects.push([bits(offset), bits(t.width), bits(t.height), bits(flags)]);
}

fn push_textures(world: &World, out: &mut Packed) {
    out.layout.texture_base = out.objects.len() as u32;
    for t in &world.textures {
        push_texture(t, out);
    }
    match &world.environment {
        Environment::Uniform(c) => out.layout.env_color = [c.x, c.y, c.z, 0.0],
        Environment::Map(map) => {
            let index = world.textures.iter().position(|t| Arc::ptr_eq(t, &map.texture));
            out.layout.env_texture = index.unwrap_or(world.textures.len()) as u32;
            if index.is_none() {
                push_texture(&map.texture, out);
            }
            out.layout.env_kind = 1;
            out.layout.env_color = [0.0, 0.0, 0.0, map.intensity];
            out.layout.env_rot = [map.cos_rot, map.sin_rot, 0.0, 0.0];
            out.layout.env_marginal = out.hdr.len() as u32;
            out.hdr.extend(&map.marginal);
            out.layout.env_conditional = out.hdr.len() as u32;
            out.hdr.extend(&map.conditional);
            out.layout.env_rows = out.hdr.len() as u32;
            out.hdr.extend(&map.row_weights);
        }
    }
    out.layout.srgb_table = out.hdr.len() as u32;
    out.hdr.extend(srgb_table());
    out.layout.albedo_table = out.hdr.len() as u32;
    out.hdr.extend(crate::albedo::flattened());
}

/// Flattens the world; call [`check`] first.
pub fn pack(world: &World) -> Packed {
    let mut out = Packed::default();
    push_geometry(world, &mut out);
    push_materials(world, &mut out);
    push_lights(world, &mut out);
    push_textures(world, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bvh::Aabb;
    use crate::math::v3;

    fn one_triangle_world() -> World {
        use crate::camera::Camera;
        use crate::job::Projection;
        use crate::math::{Affine, Vec3};
        use crate::scene::{Geometry, Instance, Mesh};
        let positions = vec![v3(0.0, 0.0, 0.0), v3(1.0, 0.0, 0.0), v3(0.0, 1.0, 0.0)];
        let mesh = Mesh::build(&positions, vec![[0, 1, 2]]);
        let identity = Affine::IDENTITY.to_f32();
        let instance = Instance { mesh: 0, material: 0, to_world: identity, to_local: identity };
        let geometry = Geometry::new(positions, vec![v3(0.0, 0.0, 1.0); 3], vec![[0.0, 0.0]; 3], vec![mesh], vec![instance]);
        let camera = Camera {
            position: Vec3::ZERO,
            forward: v3(0.0, 1.0, 0.0),
            right: v3(1.0, 0.0, 0.0),
            up: v3(0.0, 0.0, 1.0),
            projection: Projection::Perspective,
            tan_half: 0.5,
            half_height: 1.0,
            aperture: 0.0,
            focus: 1.0,
            width: 4,
            height: 4,
        };
        World {
            geometry,
            materials: Vec::new(),
            textures: Vec::new(),
            lights: Vec::new(),
            environment: Environment::Uniform(Vec3::ONE),
            camera,
        }
    }

    #[test]
    fn a_buffer_over_the_binding_limit_is_a_named_reason() {
        let world = one_triangle_world();
        assert!(check(&world, Limits { max_binding: 1 << 20 }).is_ok());
        let error = check(&world, Limits { max_binding: 64 }).unwrap_err();
        assert!(error.contains("storage-buffer limit"), "{error}");
        let packed = pack(&world);
        assert_eq!((packed.words.len(), packed.verts.len(), packed.layout.tlas_order), (4, 6, 3));
        assert_eq!(packed.hdr.len(), 256 + 2 * crate::albedo::N * crate::albedo::N + 2 * crate::albedo::N);
    }

    #[test]
    fn depth_counts_levels_and_an_empty_tree_is_flat() {
        let boxes: Vec<Aabb> = (0..64).map(|i| Aabb { min: v3(i as f32, 0.0, 0.0), max: v3(i as f32 + 0.5, 1.0, 1.0) }).collect();
        let tree = Bvh::build(&boxes);
        let d = depth(&tree);
        assert!((4..=8).contains(&d), "{d}");
        assert_eq!(depth(&Bvh::build(&[])), 0);
    }
}
