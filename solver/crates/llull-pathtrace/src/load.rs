//! Reads and validates a job folder into a renderable `Job`. Every refusal is a named code with the offending field or file:
//! `PATHTRACE_JOB_IO` (job.json unreadable), `PATHTRACE_JOB_INVALID` (a field out of range), `PATHTRACE_CAMERA_INVALID`,
//! `PATHTRACE_BUFFER_MISSING`, `PATHTRACE_BUFFER_INVALID` (size, non-finite value, index out of range, singular instance),
//! `PATHTRACE_TEXTURE_MISSING`, `PATHTRACE_TEXTURE_INVALID`.

use crate::camera::Camera;
use crate::emitters::{Emitters, MAX_EMITTERS};
use crate::env::{EnvMap, Environment};
use crate::integrator::World;
use crate::job::{self, invalid, CameraJson, Engine, EnvironmentJson, JobFile, Projection};
use crate::lights_load::lights;
use crate::material::Material;
use crate::math::{Affine, Vec3};
use crate::scene::{Geometry, Instance, Mesh};
use crate::texture::Texture;
use crate::{sky, PathTraceError};
use std::fs;
use std::path::Path;
use std::sync::Arc;

pub const MAX_SIDE: u32 = 8192;
pub const MAX_SAMPLES: u32 = 65536;
pub const MAX_BOUNCES: u32 = 64;

#[derive(Debug, Clone)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub target_noise: Option<f32>,
    pub max_bounces: u32,
    pub seed: u32,
    pub denoise: bool,
    pub engine: Engine,
    pub exr: bool,
    pub png: bool,
    pub exposure: f32,
    pub max_seconds: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct Job {
    pub settings: Settings,
    pub world: World,
}

fn buffer_error(message: String) -> PathTraceError {
    PathTraceError { code: "PATHTRACE_BUFFER_INVALID", message }
}

fn read_buffer(folder: &Path, name: &str, width: usize) -> Result<Vec<u8>, PathTraceError> {
    let bytes = fs::read(folder.join(name))
        .map_err(|error| PathTraceError { code: "PATHTRACE_BUFFER_MISSING", message: format!("{name}: {error}") })?;
    if !bytes.len().is_multiple_of(width) {
        return Err(buffer_error(format!("{name}: {} bytes is not a whole number of {width}-byte values", bytes.len())));
    }
    Ok(bytes)
}

fn read_f32(folder: &Path, name: &str) -> Result<Vec<f32>, PathTraceError> {
    let values: Vec<f32> = read_buffer(folder, name, 4)?.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    if let Some(index) = values.iter().position(|v| !v.is_finite()) {
        return Err(buffer_error(format!("{name}: value {index} is not finite")));
    }
    Ok(values)
}

pub fn finite3(name: &str, v: [f64; 3]) -> Result<Vec3, PathTraceError> {
    if v.iter().all(|x| x.is_finite()) {
        Ok(Vec3::from_f64(v))
    } else {
        Err(invalid(format!("{name} must be finite")))
    }
}

/// A unit-length direction (within 1e-3) of the job, normalised.
pub fn unit3(name: &str, v: [f64; 3], code: &'static str) -> Result<Vec3, PathTraceError> {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if !length.is_finite() || (length - 1.0).abs() > 1e-3 {
        return Err(PathTraceError { code, message: format!("{name} must be a finite unit vector (length {length})") });
    }
    Ok(Vec3::from_f64([v[0] / length, v[1] / length, v[2] / length]))
}

pub fn range(name: &str, value: f64, low: f64, high: f64) -> Result<f32, PathTraceError> {
    if value.is_finite() && value >= low && value <= high {
        Ok(value as f32)
    } else {
        Err(invalid(format!("{name} = {value} is outside [{low}, {high}]")))
    }
}

fn settings(job: &JobFile) -> Result<Settings, PathTraceError> {
    if job.kind != "pathtrace" || job.version != 1 {
        return Err(invalid(format!("kind / version must be \"pathtrace\" / 1, got \"{}\" / {}", job.kind, job.version)));
    }
    for (name, value) in [("width", job.width), ("height", job.height)] {
        if value == 0 || value > MAX_SIDE {
            return Err(invalid(format!("{name} = {value} is outside 1..{MAX_SIDE}")));
        }
    }
    if job.samples == 0 || job.samples > MAX_SAMPLES {
        return Err(invalid(format!("samples = {} is outside 1..{MAX_SAMPLES}", job.samples)));
    }
    if job.max_bounces > MAX_BOUNCES {
        return Err(invalid(format!("maxBounces = {} is outside 0..{MAX_BOUNCES}", job.max_bounces)));
    }
    let target_noise = job.target_noise.map(|v| range("targetNoise", v, 1e-6, 1.0)).transpose()?;
    if let Some(seconds) = job.max_seconds {
        if !seconds.is_finite() || seconds <= 0.0 {
            return Err(invalid(format!("maxSeconds = {seconds} must be a positive number or null")));
        }
    }
    Ok(Settings {
        width: job.width,
        height: job.height,
        samples: job.samples,
        target_noise,
        max_bounces: job.max_bounces,
        seed: job.seed,
        denoise: job.denoise,
        engine: job.engine,
        exr: job.exr,
        png: job.png,
        exposure: range("exposure", job.exposure, -64.0, 64.0)?,
        max_seconds: job.max_seconds,
    })
}

fn camera(c: &CameraJson, width: u32, height: u32) -> Result<Camera, PathTraceError> {
    let code = "PATHTRACE_CAMERA_INVALID";
    let fail = |message: String| PathTraceError { code, message };
    if !c.position.iter().all(|v| v.is_finite()) {
        return Err(fail("camera.position must be finite".to_string()));
    }
    let forward = unit3("camera.forward", c.forward, code)?;
    let up = unit3("camera.up", c.up, code)?;
    let right = forward.cross(up);
    if right.length() < 1e-3 {
        return Err(fail("camera.up is parallel to camera.forward".to_string()));
    }
    let right = right.normalized();
    let (tan_half, half_height) = match c.projection {
        Projection::Perspective => {
            if !(c.fov_y.is_finite() && c.fov_y > 0.0 && c.fov_y < std::f64::consts::PI) {
                return Err(fail(format!("camera.fovY = {} must be in (0, pi)", c.fov_y)));
            }
            ((c.fov_y / 2.0).tan() as f32, 1.0)
        }
        Projection::Orthographic => {
            if !(c.ortho_height.is_finite() && c.ortho_height > 0.0) {
                return Err(fail(format!("camera.orthoHeight = {} must be positive", c.ortho_height)));
            }
            (1.0, (c.ortho_height / 2.0) as f32)
        }
    };
    if !(c.aperture_radius.is_finite() && c.aperture_radius >= 0.0) {
        return Err(fail(format!("camera.apertureRadius = {} must be >= 0", c.aperture_radius)));
    }
    if !c.focus_distance.is_finite() || (c.aperture_radius > 0.0 && c.focus_distance <= 0.0) {
        return Err(fail(format!("camera.focusDistance = {} must be finite (and positive with an aperture)", c.focus_distance)));
    }
    Ok(Camera {
        position: Vec3::from_f64(c.position),
        forward,
        right,
        up: right.cross(forward),
        projection: c.projection,
        tan_half,
        half_height,
        aperture: c.aperture_radius as f32,
        focus: c.focus_distance as f32,
        width,
        height,
    })
}

fn textures(folder: &Path, job: &JobFile) -> Result<Vec<Arc<Texture>>, PathTraceError> {
    let mut out = Vec::with_capacity(job.textures.len());
    for (i, t) in job.textures.iter().enumerate() {
        let extension = match t.format {
            job::TextureFormat::Png => "png",
            job::TextureFormat::Jpeg => "jpg",
            job::TextureFormat::Hdr => "hdr",
        };
        let expected = format!("tex-{i}.{extension}");
        if t.file != expected {
            return Err(PathTraceError {
                code: "PATHTRACE_TEXTURE_INVALID",
                message: format!("textures[{i}].file must be \"{expected}\", got \"{}\"", t.file),
            });
        }
        let bytes = fs::read(folder.join(&t.file))
            .map_err(|error| PathTraceError { code: "PATHTRACE_TEXTURE_MISSING", message: format!("textures[{i}] {}: {error}", t.file) })?;
        out.push(Arc::new(Texture::decode(&t.file, &bytes, t.format, t.color_space)?));
    }
    Ok(out)
}

fn texture_ref(name: &str, index: Option<u32>, count: usize) -> Result<Option<u32>, PathTraceError> {
    match index {
        Some(i) if i as usize >= count => Err(invalid(format!("{name} = {i} but there are {count} textures"))),
        other => Ok(other),
    }
}

fn materials(job: &JobFile, texture_count: usize) -> Result<Vec<Material>, PathTraceError> {
    let mut out = Vec::with_capacity(job.materials.len());
    for (i, m) in job.materials.iter().enumerate() {
        let name = |field: &str| format!("materials[{i}].{field}");
        let colour = |field: &str, v: [f64; 3]| -> Result<Vec3, PathTraceError> {
            let c = finite3(&name(field), v)?;
            if c.x < 0.0 || c.y < 0.0 || c.z < 0.0 {
                return Err(invalid(format!("{} must be >= 0", name(field))));
            }
            Ok(c)
        };
        let tex = |field: &str, index: Option<u32>| texture_ref(&name(field), index, texture_count);
        out.push(Material {
            base_color: colour("baseColor", m.base_color)?,
            base_color_texture: tex("baseColorTexture", m.base_color_texture)?,
            metalness: range(&name("metalness"), m.metalness, 0.0, 1.0)?,
            metalness_texture: tex("metalnessTexture", m.metalness_texture)?,
            roughness: range(&name("roughness"), m.roughness, 0.0, 1.0)?,
            roughness_texture: tex("roughnessTexture", m.roughness_texture)?,
            normal_texture: tex("normalTexture", m.normal_texture)?,
            normal_scale: range(&name("normalScale"), m.normal_scale, -16.0, 16.0)?,
            emission: colour("emission", m.emission)?,
            emission_texture: tex("emissionTexture", m.emission_texture)?,
            transmission: range(&name("transmission"), m.transmission, 0.0, 1.0)?,
            transmission_texture: tex("transmissionTexture", m.transmission_texture)?,
            ior: range(&name("ior"), m.ior, 1.0, 4.0)?,
            coat: range(&name("coat"), m.coat, 0.0, 1.0)?,
            coat_texture: tex("coatTexture", m.coat_texture)?,
            coat_roughness: range(&name("coatRoughness"), m.coat_roughness, 0.0, 1.0)?,
        });
    }
    Ok(out)
}

fn geometry(folder: &Path, job: &JobFile) -> Result<Geometry, PathTraceError> {
    let positions = read_f32(folder, "positions.f32")?;
    let normals = read_f32(folder, "normals.f32")?;
    let uvs = read_f32(folder, "uvs.f32")?;
    let indices: Vec<u32> =
        read_buffer(folder, "indices.u32", 4)?.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let instance_values: Vec<f64> = read_buffer(folder, "instances.f64", 8)?
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
        .collect();
    if !positions.len().is_multiple_of(3)
        || normals.len() != positions.len()
        || uvs.len() / 2 != positions.len() / 3
        || !uvs.len().is_multiple_of(2)
    {
        return Err(buffer_error(format!(
            "positions.f32 ({} values), normals.f32 ({}) and uvs.f32 ({}) disagree: need 3, 3 and 2 values per vertex",
            positions.len(),
            normals.len(),
            uvs.len()
        )));
    }
    let vertex_total = (positions.len() / 3) as u64;
    let to_vec = |v: &[f32]| v.chunks_exact(3).map(|c| Vec3 { x: c[0], y: c[1], z: c[2] }).collect::<Vec<Vec3>>();
    let positions = to_vec(&positions);
    let normals = to_vec(&normals);
    let uvs: Vec<[f32; 2]> = uvs.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
    let mut meshes = Vec::with_capacity(job.meshes.len());
    for (i, m) in job.meshes.iter().enumerate() {
        let vertex_end = m.vertex_offset.checked_add(m.vertex_count).filter(|end| *end <= vertex_total);
        let index_end = m.index_offset.checked_add(m.index_count).filter(|end| *end <= indices.len() as u64);
        let (Some(_), Some(index_end)) = (vertex_end, index_end) else {
            return Err(buffer_error(format!("meshes[{i}] reaches past the vertex ({vertex_total}) or index ({}) buffers", indices.len())));
        };
        if !m.index_count.is_multiple_of(3) {
            return Err(buffer_error(format!("meshes[{i}].indexCount = {} is not a multiple of 3", m.index_count)));
        }
        let local = &indices[m.index_offset as usize..index_end as usize];
        if let Some(bad) = local.iter().find(|v| u64::from(**v) >= m.vertex_count) {
            return Err(buffer_error(format!("meshes[{i}] index {bad} >= vertexCount {}", m.vertex_count)));
        }
        let base = m.vertex_offset as u32;
        let triangles = local.chunks_exact(3).map(|t| [t[0] + base, t[1] + base, t[2] + base]).collect();
        meshes.push(Mesh::build(&positions, triangles));
    }
    let expected = job.instance_count.checked_mul(14 * 8);
    if expected != Some(instance_values.len() as u64 * 8) {
        return Err(buffer_error(format!(
            "instances.f64 has {} values, instanceCount {} needs 14 each",
            instance_values.len(),
            job.instance_count
        )));
    }
    let mut instances = Vec::with_capacity(job.instance_count as usize);
    for (i, row) in instance_values.chunks_exact(14).enumerate() {
        let (mesh, material) = (row[0], row[1]);
        if mesh.fract() != 0.0
            || mesh < 0.0
            || mesh >= meshes.len() as f64
            || material.fract() != 0.0
            || material < 0.0
            || material >= job.materials.len() as f64
        {
            return Err(buffer_error(format!("instance {i}: meshIndex {mesh} / materialIndex {material} out of range")));
        }
        let mut affine = Affine::IDENTITY;
        for r in 0..3 {
            for c in 0..4 {
                affine.m[r][c] = row[2 + r * 4 + c];
            }
        }
        let inverse = affine.inverse().filter(|_| row[2..].iter().all(|v| v.is_finite()));
        let Some(inverse) = inverse else {
            return Err(buffer_error(format!("instance {i}: the transform is not finite and invertible")));
        };
        instances.push(Instance { mesh: mesh as u32, material: material as u32, to_world: affine.to_f32(), to_local: inverse.to_f32() });
    }
    Ok(Geometry::new(positions, normals, uvs, meshes, instances))
}

fn environment(env: &EnvironmentJson, textures: &[Arc<Texture>]) -> Result<Environment, PathTraceError> {
    Ok(match env {
        EnvironmentJson::Default {} => Environment::Uniform(Vec3::splat(0.3)),
        EnvironmentJson::Color { color, intensity } => {
            let c = finite3("environment.color", *color)?;
            Environment::Uniform(c.max(Vec3::ZERO) * range("environment.intensity", *intensity, 0.0, 1e9)?)
        }
        EnvironmentJson::Sky { turbidity, intensity, sun_direction } => {
            let turbidity = range("environment.turbidity", *turbidity, 1.0, 32.0)?;
            let intensity = range("environment.intensity", *intensity, 0.0, 1e9)?;
            let sun = unit3("environment.sunDirection", *sun_direction, "PATHTRACE_JOB_INVALID")?;
            let baked = sky::bake(f64::from(turbidity), f64::from(intensity), [f64::from(sun.x), f64::from(sun.y), f64::from(sun.z)]);
            EnvMap::new(Arc::new(baked), 0.0, 1.0).map_or(Environment::Uniform(Vec3::ZERO), Environment::Map)
        }
        EnvironmentJson::Hdr { texture, rotation, intensity } => {
            let Some(map) = textures.get(*texture as usize) else {
                return Err(invalid(format!("environment.texture = {texture} but there are {} textures", textures.len())));
            };
            let rotation = range("environment.rotation", *rotation, -1e6, 1e6)?;
            let intensity = range("environment.intensity", *intensity, 0.0, 1e9)?;
            EnvMap::new(Arc::clone(map), rotation, intensity).map_or(Environment::Uniform(Vec3::ZERO), Environment::Map)
        }
    })
}

/// Reads `job.json` and its buffers and textures.
pub fn load(folder: &Path) -> Result<Job, PathTraceError> {
    let text = fs::read_to_string(folder.join("job.json"))
        .map_err(|error| PathTraceError { code: "PATHTRACE_JOB_IO", message: format!("job.json: {error}") })?;
    let job = job::parse(&text)?;
    let settings = settings(&job)?;
    let camera = camera(&job.camera, settings.width, settings.height)?;
    let unit_metres = range("unitMetres", job.unit_metres, 1e-9, 1e9)?;
    if job.unit_metres <= 0.0 {
        return Err(invalid("unitMetres must be positive".to_string()));
    }
    let textures = textures(folder, &job)?;
    let materials = materials(&job, textures.len())?;
    let lights = lights(&job.lights, unit_metres)?;
    let environment = environment(&job.environment, &textures)?;
    let geometry = geometry(folder, &job)?;
    let emitters = Emitters::build(&geometry, &materials, &textures, MAX_EMITTERS);
    Ok(Job { settings, world: World { geometry, materials, textures, lights, emitters, environment, camera } })
}
