//! Negative layer: bad jobs refuse with a named code and a message naming the field or file, never a panic.

mod common;

use common::{icosphere, lambert, SceneBuilder, IDENTITY};
use llull_pathtrace::load::load;
use llull_pathtrace::PathTraceError;
use serde_json::json;
use std::path::Path;

fn valid() -> SceneBuilder {
    let mut b = SceneBuilder::new(8, 8, 2);
    let m = b.add_material(lambert(0.5));
    let mesh = b.add_mesh(&icosphere(1.0, 0));
    b.add_instance(mesh, m, IDENTITY);
    b
}

fn refusal(folder: &Path) -> PathTraceError {
    match load(folder) {
        Ok(_) => panic!("{} loaded", folder.display()),
        Err(error) => error,
    }
}

fn expect(folder: &Path, code: &str, mentions: &str) {
    let error = refusal(folder);
    assert_eq!(error.code, code, "{}", error.message);
    assert!(error.message.contains(mentions), "{code}: '{}' should mention '{mentions}'", error.message);
}

#[test]
fn a_valid_job_loads() {
    assert!(load(&valid().write("err-valid")).is_ok());
}

#[test]
fn missing_and_malformed_files() {
    let folder = valid().write("err-missing");
    std::fs::remove_file(folder.join("normals.f32")).unwrap();
    expect(&folder, "PATHTRACE_BUFFER_MISSING", "normals.f32");
    let folder = valid().write("err-nojob");
    std::fs::remove_file(folder.join("job.json")).unwrap();
    expect(&folder, "PATHTRACE_JOB_IO", "job.json");
    let folder = valid().write("err-json");
    std::fs::write(folder.join("job.json"), b"{ not json").unwrap();
    expect(&folder, "PATHTRACE_JOB_INVALID", "job.json");
}

#[test]
fn wrong_buffer_sizes_and_indices() {
    let folder = valid().write("err-size");
    let mut uvs = std::fs::read(folder.join("uvs.f32")).unwrap();
    uvs.truncate(uvs.len() - 8);
    std::fs::write(folder.join("uvs.f32"), uvs).unwrap();
    expect(&folder, "PATHTRACE_BUFFER_INVALID", "uvs.f32");
    let folder = valid().write("err-ragged");
    std::fs::write(folder.join("positions.f32"), [0u8; 7]).unwrap();
    expect(&folder, "PATHTRACE_BUFFER_INVALID", "positions.f32");
    let folder = valid().write("err-instances");
    std::fs::write(folder.join("instances.f64"), [0u8; 8 * 13]).unwrap();
    expect(&folder, "PATHTRACE_BUFFER_INVALID", "instanceCount");
    let mut b = valid();
    b.add_instance(5, 0, IDENTITY);
    expect(&b.write("err-meshindex"), "PATHTRACE_BUFFER_INVALID", "meshIndex");
    let mut b = valid();
    b.add_instance(0, 0, [0.0; 12]);
    expect(&b.write("err-singular"), "PATHTRACE_BUFFER_INVALID", "invertible");
    let folder = valid().write("err-index");
    let mut indices = std::fs::read(folder.join("indices.u32")).unwrap();
    indices[0..4].copy_from_slice(&1000u32.to_le_bytes());
    std::fs::write(folder.join("indices.u32"), indices).unwrap();
    expect(&folder, "PATHTRACE_BUFFER_INVALID", "vertexCount");
    let folder = valid().write("err-nan");
    let mut positions = std::fs::read(folder.join("positions.f32")).unwrap();
    positions[0..4].copy_from_slice(&f32::NAN.to_le_bytes());
    std::fs::write(folder.join("positions.f32"), positions).unwrap();
    expect(&folder, "PATHTRACE_BUFFER_INVALID", "not finite");
}

#[test]
fn non_finite_or_degenerate_cameras() {
    let mut b = valid();
    b.camera["forward"] = json!([0.0, 0.0, 0.0]);
    expect(&b.write("err-cam-forward"), "PATHTRACE_CAMERA_INVALID", "camera.forward");
    let mut b = valid();
    b.camera["up"] = json!([0.0, 1.0, 0.0]);
    expect(&b.write("err-cam-parallel"), "PATHTRACE_CAMERA_INVALID", "parallel");
    let mut b = valid();
    b.camera["fovY"] = json!(4.0);
    expect(&b.write("err-cam-fov"), "PATHTRACE_CAMERA_INVALID", "camera.fovY");
    // JSON cannot carry NaN: a non-finite number arrives as a huge literal that overflows to infinity, or as null.
    let folder = valid().write("err-cam-inf");
    let text = std::fs::read_to_string(folder.join("job.json")).unwrap().replacen(
        "\"position\":[0.0,-5.0,0.0]",
        "\"position\":[0.0,-5.0,1e999]",
        1,
    );
    std::fs::write(folder.join("job.json"), text).unwrap();
    let error = refusal(&folder);
    assert!(error.code == "PATHTRACE_CAMERA_INVALID" || error.code == "PATHTRACE_JOB_INVALID", "{error:?}");
    assert!(error.message.contains("camera"), "{error:?}");
    let mut b = valid();
    b.camera["position"] = json!([0.0, null, 0.0]);
    expect(&b.write("err-cam-null"), "PATHTRACE_JOB_INVALID", "camera.position");
}

#[test]
fn bad_textures() {
    let mut b = valid();
    let t = b.add_texture("png", "png", "srgb", b"definitely not a png".to_vec());
    b.materials[0]["baseColorTexture"] = json!(t);
    expect(&b.write("err-tex-garbage"), "PATHTRACE_TEXTURE_INVALID", "tex-0.png");
    let folder = b.write("err-tex-missing");
    std::fs::remove_file(folder.join("tex-0.png")).unwrap();
    expect(&folder, "PATHTRACE_TEXTURE_MISSING", "tex-0.png");
    let mut b = valid();
    b.materials[0]["baseColorTexture"] = json!(3);
    expect(&b.write("err-tex-ref"), "PATHTRACE_JOB_INVALID", "materials[0].baseColorTexture");
}

#[test]
fn out_of_range_settings_name_the_field() {
    for (key, value, mentions) in [
        ("width", json!(0), "width"),
        ("height", json!(9000), "height"),
        ("samples", json!(70000), "samples"),
        ("maxBounces", json!(65), "maxBounces"),
        ("seed", json!(-1), "seed"),
        ("engine", json!("tpu"), "engine"),
        ("unitMetres", json!(0.0), "unitMetres"),
        ("targetNoise", json!(-0.1), "targetNoise"),
        ("maxSeconds", json!(0), "maxSeconds"),
        ("version", json!(2), "version"),
    ] {
        let mut b = valid();
        b.set(key, value);
        expect(&b.write(&format!("err-{key}")), "PATHTRACE_JOB_INVALID", mentions);
    }
    let mut b = valid();
    b.materials[0]["roughness"] = json!(1.5);
    expect(&b.write("err-roughness"), "PATHTRACE_JOB_INVALID", "materials[0].roughness");
    let mut b = valid();
    b.lights.push(
        json!({ "type": "sun", "direction": [0.0, 0.0, 2.0], "irradiance": [1.0, 1.0, 1.0], "angularRadius": 0.0, "castShadows": true }),
    );
    expect(&b.write("err-sun"), "PATHTRACE_JOB_INVALID", "lights[0].direction");
    let mut b = valid();
    b.lights.push(json!({ "type": "laser", "castShadows": true }));
    expect(&b.write("err-light-type"), "PATHTRACE_JOB_INVALID", "lights[0]");
    let mut b = valid();
    b.environment = json!({ "type": "hdr", "texture": 0, "rotation": 0.0, "intensity": 1.0 });
    expect(&b.write("err-env-tex"), "PATHTRACE_JOB_INVALID", "environment.texture");
}
