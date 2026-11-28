//! `job.json` of `llull-compute pathtrace` as written by the host (RV1 §5b): the serde shape, parsed with the failing field's path in
//! the error message. Range checks and the buffers are in `load`.

use crate::PathTraceError;
use serde::Deserialize;

pub type V3 = [f64; 3];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFile {
    pub kind: String,
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub samples: u32,
    pub target_noise: Option<f64>,
    pub max_bounces: u32,
    pub seed: u32,
    pub denoise: bool,
    pub engine: Engine,
    pub exr: bool,
    pub png: bool,
    pub exposure: f64,
    /// Wall-clock budget in seconds; null or absent = none.
    #[serde(default)]
    pub max_seconds: Option<f64>,
    pub unit_metres: f64,
    pub camera: CameraJson,
    pub meshes: Vec<MeshJson>,
    pub materials: Vec<MaterialJson>,
    pub instance_count: u64,
    pub textures: Vec<TextureJson>,
    pub lights: Vec<LightJson>,
    pub environment: EnvironmentJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Projection {
    Perspective,
    Orthographic,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraJson {
    pub position: V3,
    pub forward: V3,
    pub up: V3,
    pub projection: Projection,
    pub fov_y: f64,
    pub ortho_height: f64,
    pub aperture_radius: f64,
    pub focus_distance: f64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshJson {
    pub vertex_offset: u64,
    pub vertex_count: u64,
    pub index_offset: u64,
    pub index_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialJson {
    pub base_color: V3,
    pub base_color_texture: Option<u32>,
    pub metalness: f64,
    pub metalness_texture: Option<u32>,
    pub roughness: f64,
    pub roughness_texture: Option<u32>,
    pub normal_texture: Option<u32>,
    pub normal_scale: f64,
    pub emission: V3,
    pub emission_texture: Option<u32>,
    pub transmission: f64,
    pub transmission_texture: Option<u32>,
    pub ior: f64,
    pub coat: f64,
    pub coat_texture: Option<u32>,
    pub coat_roughness: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextureFormat {
    Png,
    Jpeg,
    Hdr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorSpace {
    Srgb,
    Linear,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureJson {
    pub file: String,
    pub format: TextureFormat,
    pub color_space: ColorSpace,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum LightJson {
    Sun { direction: V3, irradiance: V3, angular_radius: f64, cast_shadows: bool },
    Point { position: V3, power: V3, radius: f64, cast_shadows: bool },
    Spot { position: V3, direction: V3, power: V3, radius: f64, cone_angle: f64, blend: f64, cast_shadows: bool },
    Area { position: V3, u_axis: V3, v_axis: V3, normal: V3, power: V3, cast_shadows: bool },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum EnvironmentJson {
    Sky { turbidity: f64, intensity: f64, sun_direction: V3 },
    Hdr { texture: u32, rotation: f64, intensity: f64 },
    Color { color: V3, intensity: f64 },
    Default {},
}

pub fn invalid(message: String) -> PathTraceError {
    PathTraceError { code: "PATHTRACE_JOB_INVALID", message }
}

/// Parses `job.json`; a malformed or mistyped field is `PATHTRACE_JOB_INVALID` naming its path (e.g. `camera.fovY`).
pub fn parse(text: &str) -> Result<JobFile, PathTraceError> {
    let deserializer = &mut serde_json::Deserializer::from_str(text);
    serde_path_to_error::deserialize(deserializer).map_err(|error| {
        let path = error.path().to_string();
        let inner = error.into_inner();
        if path == "." || path.is_empty() {
            invalid(format!("job.json: {inner}"))
        } else {
            invalid(format!("job.json field {path}: {inner}"))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrong_field_type_names_the_field() {
        let error = parse(r#"{"kind":"pathtrace","version":1,"width":"wide"}"#).unwrap_err();
        assert_eq!(error.code, "PATHTRACE_JOB_INVALID");
        assert!(error.message.contains("width"), "{}", error.message);
    }

    #[test]
    fn lights_and_environment_parse_by_type() {
        let light: LightJson = serde_json::from_str(
            r#"{"type":"area","position":[0,0,1],"uAxis":[1,0,0],"vAxis":[0,1,0],"normal":[0,0,-1],"power":[1,1,1],"castShadows":true}"#,
        )
        .unwrap();
        assert!(matches!(light, LightJson::Area { .. }));
        let env: EnvironmentJson = serde_json::from_str(r#"{"type":"default"}"#).unwrap();
        assert!(matches!(env, EnvironmentJson::Default {}));
    }
}
