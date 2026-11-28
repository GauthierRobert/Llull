//! Job-folder builder for the path tracer tests: writes `job.json` + buffers exactly as the host contract (RV1 §5b) describes.
#![allow(dead_code)]

use llull_pathtrace::load::{load, Job};
use llull_pathtrace::render::Image;
use serde_json::{json, Value};
use std::path::PathBuf;

pub const IDENTITY: [f64; 12] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];

pub struct MeshData {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
}

pub struct SceneBuilder {
    pub settings: serde_json::Map<String, Value>,
    pub camera: Value,
    pub environment: Value,
    pub lights: Vec<Value>,
    pub materials: Vec<Value>,
    pub textures: Vec<(Value, Vec<u8>)>,
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
    meshes: Vec<Value>,
    instances: Vec<f64>,
}

pub fn lambert(rho: f64) -> Value {
    material(json!({ "baseColor": [rho, rho, rho], "ior": 1.0 }))
}

/// A material with defaults (white dielectric, roughness 0.5, ior 1.5) overridden by `fields`.
pub fn material(fields: Value) -> Value {
    let mut m = json!({
        "baseColor": [1.0, 1.0, 1.0], "baseColorTexture": null, "metalness": 0.0, "metalnessTexture": null,
        "roughness": 0.5, "roughnessTexture": null, "normalTexture": null, "normalScale": 1.0,
        "emission": [0.0, 0.0, 0.0], "emissionTexture": null, "transmission": 0.0, "transmissionTexture": null,
        "ior": 1.5, "coat": 0.0, "coatTexture": null, "coatRoughness": 0.0
    });
    if let (Some(target), Some(source)) = (m.as_object_mut(), fields.as_object()) {
        for (k, v) in source {
            target.insert(k.clone(), v.clone());
        }
    }
    m
}

pub fn ortho_down(height: f64, at: f64) -> Value {
    json!({ "position": [0.0, 0.0, at], "forward": [0.0, 0.0, -1.0], "up": [0.0, 1.0, 0.0], "projection": "orthographic",
            "fovY": 0.8, "orthoHeight": height, "apertureRadius": 0.0, "focusDistance": 1.0 })
}

pub fn perspective(position: [f64; 3], forward: [f64; 3], up: [f64; 3], fov_y: f64) -> Value {
    json!({ "position": position, "forward": forward, "up": up, "projection": "perspective",
            "fovY": fov_y, "orthoHeight": 1.0, "apertureRadius": 0.0, "focusDistance": 1.0 })
}

impl SceneBuilder {
    pub fn new(width: u32, height: u32, samples: u32) -> SceneBuilder {
        let settings = json!({
            "kind": "pathtrace", "version": 1, "width": width, "height": height, "samples": samples, "targetNoise": null,
            "maxBounces": 8, "seed": 1, "denoise": false, "engine": "cpu", "exr": true, "png": true, "exposure": 0.0,
            "maxSeconds": null, "unitMetres": 1.0
        });
        SceneBuilder {
            settings: settings.as_object().cloned().unwrap_or_default(),
            camera: perspective([0.0, -5.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], 0.6),
            environment: json!({ "type": "default" }),
            lights: Vec::new(),
            materials: Vec::new(),
            textures: Vec::new(),
            positions: Vec::new(),
            normals: Vec::new(),
            uvs: Vec::new(),
            indices: Vec::new(),
            meshes: Vec::new(),
            instances: Vec::new(),
        }
    }

    pub fn set(&mut self, key: &str, value: Value) -> &mut Self {
        self.settings.insert(key.to_string(), value);
        self
    }

    pub fn add_material(&mut self, m: Value) -> u32 {
        self.materials.push(m);
        (self.materials.len() - 1) as u32
    }

    pub fn add_mesh(&mut self, mesh: &MeshData) -> u32 {
        let vertex_offset = self.positions.len() / 3;
        self.meshes.push(json!({ "vertexOffset": vertex_offset, "vertexCount": mesh.positions.len(),
                                 "indexOffset": self.indices.len(), "indexCount": mesh.indices.len() }));
        self.positions.extend(mesh.positions.iter().flatten());
        self.normals.extend(mesh.normals.iter().flatten());
        self.uvs.extend(mesh.uvs.iter().flatten());
        self.indices.extend(&mesh.indices);
        (self.meshes.len() - 1) as u32
    }

    pub fn add_instance(&mut self, mesh: u32, material: u32, affine: [f64; 12]) {
        self.instances.push(f64::from(mesh));
        self.instances.push(f64::from(material));
        self.instances.extend(affine);
    }

    pub fn add_texture(&mut self, format: &str, extension: &str, color_space: &str, bytes: Vec<u8>) -> u32 {
        let i = self.textures.len();
        self.textures.push((json!({ "file": format!("tex-{i}.{extension}"), "format": format, "colorSpace": color_space }), bytes));
        i as u32
    }

    pub fn job_json(&self) -> Value {
        let mut job = Value::Object(self.settings.clone());
        job["camera"] = self.camera.clone();
        job["meshes"] = Value::Array(self.meshes.clone());
        job["materials"] = Value::Array(self.materials.clone());
        job["instanceCount"] = json!(self.instances.len() / 14);
        job["textures"] = Value::Array(self.textures.iter().map(|t| t.0.clone()).collect());
        job["lights"] = Value::Array(self.lights.clone());
        job["environment"] = self.environment.clone();
        job
    }

    /// Writes the folder (fresh) and returns it.
    pub fn write(&self, name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("pathtrace-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("job.json"), serde_json::to_vec(&self.job_json()).unwrap()).unwrap();
        let f32s = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
        std::fs::write(dir.join("positions.f32"), f32s(&self.positions)).unwrap();
        std::fs::write(dir.join("normals.f32"), f32s(&self.normals)).unwrap();
        std::fs::write(dir.join("uvs.f32"), f32s(&self.uvs)).unwrap();
        std::fs::write(dir.join("indices.u32"), self.indices.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
        std::fs::write(dir.join("instances.f64"), self.instances.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
        for (t, bytes) in &self.textures {
            std::fs::write(dir.join(t["file"].as_str().unwrap()), bytes).unwrap();
        }
        dir
    }

    pub fn load(&self, name: &str) -> Job {
        load(&self.write(name)).unwrap()
    }
}

/// Unwelded mesh with face normals from triangles (positions per corner).
pub fn flat(triangles: &[[[f32; 3]; 3]]) -> MeshData {
    let mut mesh = MeshData { positions: Vec::new(), normals: Vec::new(), uvs: Vec::new(), indices: Vec::new() };
    for t in triangles {
        let e1 = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
        let e2 = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        for (k, p) in t.iter().enumerate() {
            mesh.indices.push(mesh.positions.len() as u32);
            mesh.positions.push(*p);
            mesh.normals.push([n[0] / l, n[1] / l, n[2] / l]);
            mesh.uvs.push([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]][k]);
        }
    }
    mesh
}

/// Flat-shaded icosphere (subdivided `levels` times) of `radius` at the origin.
pub fn icosphere(radius: f32, levels: u32) -> MeshData {
    let t = (1.0 + 5.0f32.sqrt()) / 2.0;
    let mut v: Vec<[f32; 3]> = vec![
        [-1.0, t, 0.0],
        [1.0, t, 0.0],
        [-1.0, -t, 0.0],
        [1.0, -t, 0.0],
        [0.0, -1.0, t],
        [0.0, 1.0, t],
        [0.0, -1.0, -t],
        [0.0, 1.0, -t],
        [t, 0.0, -1.0],
        [t, 0.0, 1.0],
        [-t, 0.0, -1.0],
        [-t, 0.0, 1.0],
    ];
    let mut faces: Vec<[usize; 3]> = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    let unit = |p: [f32; 3]| {
        let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        [p[0] / l, p[1] / l, p[2] / l]
    };
    v = v.into_iter().map(unit).collect();
    for _ in 0..levels {
        let mut next = Vec::new();
        for f in &faces {
            let mid = |a: usize, b: usize, v: &mut Vec<[f32; 3]>| {
                v.push(unit([(v[a][0] + v[b][0]) / 2.0, (v[a][1] + v[b][1]) / 2.0, (v[a][2] + v[b][2]) / 2.0]));
                v.len() - 1
            };
            let (ab, bc, ca) = (mid(f[0], f[1], &mut v), mid(f[1], f[2], &mut v), mid(f[2], f[0], &mut v));
            next.extend([[f[0], ab, ca], [f[1], bc, ab], [f[2], ca, bc], [ab, bc, ca]]);
        }
        faces = next;
    }
    let scaled = |i: usize| [v[i][0] * radius, v[i][1] * radius, v[i][2] * radius];
    let triangles: Vec<[[f32; 3]; 3]> = faces.iter().map(|f| [scaled(f[0]), scaled(f[1]), scaled(f[2])]).collect();
    flat(&triangles)
}

/// Square in the z = `z` plane, side `size`, centred, normal +Z.
pub fn quad(size: f32, z: f32) -> MeshData {
    let h = size / 2.0;
    flat(&[[[-h, -h, z], [h, -h, z], [h, h, z]], [[-h, -h, z], [h, h, z], [-h, h, z]]])
}

/// The six faces of an axis-aligned cube of half side `h` (normals outward; the opaque lobes are two-sided).
pub fn cube(h: f32) -> MeshData {
    let c = |x: f32, y: f32, z: f32| [x * h, y * h, z * h];
    let mut triangles = Vec::new();
    let faces = [
        [c(-1.0, -1.0, -1.0), c(-1.0, 1.0, -1.0), c(1.0, 1.0, -1.0), c(1.0, -1.0, -1.0)],
        [c(-1.0, -1.0, 1.0), c(1.0, -1.0, 1.0), c(1.0, 1.0, 1.0), c(-1.0, 1.0, 1.0)],
        [c(-1.0, -1.0, -1.0), c(1.0, -1.0, -1.0), c(1.0, -1.0, 1.0), c(-1.0, -1.0, 1.0)],
        [c(-1.0, 1.0, -1.0), c(-1.0, 1.0, 1.0), c(1.0, 1.0, 1.0), c(1.0, 1.0, -1.0)],
        [c(-1.0, -1.0, -1.0), c(-1.0, -1.0, 1.0), c(-1.0, 1.0, 1.0), c(-1.0, 1.0, -1.0)],
        [c(1.0, -1.0, -1.0), c(1.0, 1.0, -1.0), c(1.0, 1.0, 1.0), c(1.0, -1.0, 1.0)],
    ];
    for f in faces {
        triangles.push([f[0], f[1], f[2]]);
        triangles.push([f[0], f[2], f[3]]);
    }
    flat(&triangles)
}

pub fn rgb(image: &Image, index: usize) -> [f32; 3] {
    let p = image.beauty[index];
    [p[0].to_f32(), p[1].to_f32(), p[2].to_f32()]
}

pub fn mean(image: &Image) -> [f64; 3] {
    let mut sum = [0.0f64; 3];
    for i in 0..image.beauty.len() {
        let p = rgb(image, i);
        for k in 0..3 {
            sum[k] += f64::from(p[k]);
        }
    }
    sum.map(|s| s / image.beauty.len() as f64)
}
