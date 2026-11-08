//! The `llull-compute flow-query` job contract (12 CFD M3a, VC-CFD-40..43): world-frame probes / slices / streamlines on a
//! recorded field, the field hash check, the half-model mirror, the caps, and CPU determinism.

use llull_flow_core::field::FlowField;
use llull_flow_core::grid::Grid;
use llull_flow_core::query::run;
use llull_protocol::sha256_hex;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

struct Folder(PathBuf);

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// u = (1 + x, 0.5, 0) m/s, p = 10 z Pa on a 2 × 1 × 1 m box at h = 0.05 (linear: trilinear sampling is exact), with an
/// optional solid block and symmetry plane y = 0.
fn field(solid: bool, mirrors: Vec<(usize, f64, bool)>) -> FlowField {
    let grid = Grid::covering([0.0, 0.0, 0.0], [2.0, 1.0, 1.0], 0.05);
    let n = grid.cells();
    let centre = |cell: usize| {
        let (i, j, k) = grid.coords(cell);
        grid.centre(i, j, k)
    };
    let blocked = |c: [f64; 3]| solid && (1.0..1.2).contains(&c[0]) && (0.3..0.7).contains(&c[1]) && (0.3..0.7).contains(&c[2]);
    FlowField {
        ux: (0..n).map(|c| (1.0 + centre(c)[0]) as f32).collect(),
        uy: vec![0.5; n],
        uz: vec![0.0; n],
        p: (0..n).map(|c| (10.0 * centre(c)[2]) as f32).collect(),
        valid: (0..n).map(|c| !blocked(centre(c))).collect(),
        grid,
        mirrors,
    }
}

const IDENTITY: &str = r#"{ "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1] }"#;
/// The case frame rotated 90° about z: case x = world y, case y = -world x.
const TURNED: &str = r#"{ "x": [0, 1, 0], "y": [-1, 0, 0], "z": [0, 0, 1] }"#;

fn job(name: &str, field: &FlowField, frame: &str, op: &str, section: &str) -> Folder {
    let dir = std::env::temp_dir().join(format!("llull-flow-query-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let bytes = field.to_bytes();
    fs::write(dir.join("field.bin"), &bytes).unwrap();
    let sha = sha256_hex(&bytes);
    let text = format!(r#"{{ "version": 1, "field": "field.bin", "fieldSha256": "{sha}", "frame": {frame}, "op": "{op}", {section} }}"#);
    fs::write(dir.join("job.json"), text).unwrap();
    Folder(dir)
}

fn answer(folder: &Folder) -> Result<(Value, Vec<u8>), (String, String)> {
    let mut events = Vec::new();
    let outputs = run(&folder.0, &mut events).map_err(|e| (e.code.to_string(), e.message))?;
    let json: Value = serde_json::from_slice(&fs::read(folder.0.join("query.json")).unwrap()).unwrap();
    for output in &outputs {
        assert_eq!(sha256_hex(&fs::read(folder.0.join(&output.path)).unwrap()), output.sha256);
    }
    let file = outputs.iter().find(|o| o.path != "query.json").map(|o| fs::read(folder.0.join(&o.path)).unwrap()).unwrap_or_default();
    Ok((json, file))
}

fn close(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() <= tolerance
}

#[test]
fn probes_are_world_frame_values_and_misses_are_named() {
    let f = field(true, vec![]);
    // world point (-0.5, 1.4, 0.6) is case (1.4, 0.5, 0.6); case u = (2.4, 0.5, 0) is world (-0.5, 2.4, 0).
    let folder =
        job("probe", &f, TURNED, "probe", r#""probe": { "pointsM": [[-0.5, 1.4, 0.6], [-0.5, 1.01, 0.5], [5, 5, 5], [-0.5, 0.99, 0.5]] }"#);
    let (json, _) = answer(&folder).unwrap();
    let probe = &json["probes"][0];
    let v: Vec<f64> = probe["velocityMS"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
    assert!(close(v[0], -0.5, 1e-6) && close(v[1], 2.4, 1e-6) && close(v[2], 0.0, 1e-12), "{v:?}");
    assert!(close(probe["pressurePa"].as_f64().unwrap(), 6.0, 1e-5));
    assert!(close(probe["speedMS"].as_f64().unwrap(), (0.25f64 + 2.4 * 2.4).sqrt(), 1e-6));
    assert_eq!(probe["miss"], Value::Null);
    // case (1.01, 0.5, 0.5) lies in a cell of the block: a miss, never the interpolated values of its fluid neighbours.
    assert_eq!(json["probes"][1]["miss"], "solid");
    assert_eq!(json["probes"][1]["pressurePa"], Value::Null);
    assert!(json["probes"][3]["pressurePa"].is_number(), "a fluid cell next to the block still interpolates");
    assert_eq!(json["probes"][2]["miss"], "outside");
    assert_eq!(json["probes"][2]["velocityMS"], Value::Null);
}

#[test]
fn a_slice_samples_the_plane_in_world_components_with_nan_outside() {
    let f = field(false, vec![]);
    let folder = job(
        "slice",
        &f,
        IDENTITY,
        "slice",
        r#""slice": { "originM": [1, 0.5, 0.5], "normal": [0, 0, 1], "field": "ux", "spacingM": 0.1, "extentM": 2.0, "dynamicPressurePa": 1 }"#,
    );
    let (json, bytes) = answer(&folder).unwrap();
    let slice = &json["slice"];
    assert_eq!(slice["samples"], 21);
    assert_eq!(slice["field"], "ux");
    assert_eq!(&bytes[..4], b"LLSL");
    assert_eq!(bytes.len(), 72 + 4 * 21 * 21);
    let valid = slice["validSamples"].as_u64().unwrap();
    assert!(valid > 100 && valid < 441, "the 2 m patch overhangs the 1 m wide box (face layers excluded): {valid}");
    assert!(close(slice["min"].as_f64().unwrap(), 1.1, 1e-5) && close(slice["max"].as_f64().unwrap(), 2.9, 1e-5), "{slice}");
    let cp = job(
        "slice-cp",
        &f,
        IDENTITY,
        "slice",
        r#""slice": { "originM": [1, 0.5, 0.5], "normal": [1, 0, 0], "field": "cp", "spacingM": 0.25, "extentM": 0.5, "dynamicPressurePa": 5 }"#,
    );
    let (json, _) = answer(&cp).unwrap();
    assert!(close(json["slice"]["max"].as_f64().unwrap(), 1.5, 1e-5), "cp = p / q = 10 z / 5");
}

fn streamline_job(name: &str, f: &FlowField, seeds: &str, device: &str) -> Folder {
    let section = format!(
        r#""streamlines": {{ "seedsM": {seeds}, "stepM": 0.02, "maxLengthM": 10, "maxSteps": 2000, "minSpeedMS": 1e-6, "direction": "both", "toleranceM": 0.0125, "device": "{device}" }}"#
    );
    job(name, f, IDENTITY, "streamlines", &section)
}

#[test]
fn streamlines_leave_the_domain_stop_at_walls_and_are_deterministic() {
    let f = field(true, vec![]);
    let folder = streamline_job("lines", &f, "[[0.5, 0.5, 0.5], [0.5, 0.2, 0.2], [1.1, 0.5, 0.5]]", "cpu");
    let (json, bytes) = answer(&folder).unwrap();
    let lines = &json["streamlines"]["lines"];
    assert_eq!(json["streamlines"]["device"], "cpu");
    assert_eq!(json["streamlines"]["deterministic"], true);
    assert_eq!(lines[0]["stopForward"], "wall", "the centre line runs into the block");
    assert_eq!(lines[0]["stopBackward"], "left_domain");
    assert_eq!(lines[1]["stopForward"], "left_domain");
    assert_eq!(lines[2]["points"], 0, "a seed inside the block has no line");
    assert_eq!(lines[2]["stopForward"], "wall");
    assert_eq!(&bytes[..4], b"LLST");
    let count = |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
    assert_eq!(count(8), 3);
    let total = count(12);
    assert_eq!(total, json["streamlines"]["points"].as_u64().unwrap() as usize);
    assert_eq!(bytes.len(), 16 + 4 * 4 + 16 * total);
    let again = streamline_job("lines-again", &f, "[[0.5, 0.5, 0.5], [0.5, 0.2, 0.2], [1.1, 0.5, 0.5]]", "cpu");
    assert_eq!(answer(&again).unwrap().1, bytes, "the CPU path is bit-reproducible");
}

#[test]
fn a_half_model_traces_the_dropped_half_as_the_mirror_image() {
    // The field above is only symmetric about y = 0 when uy is antisymmetric: zero it, then a line seeded at -y is the mirror
    // of the line seeded at +y.
    let mut f = field(false, vec![(1, 0.0, false)]);
    f.uy = vec![0.0; f.grid.cells()];
    let folder = streamline_job("half", &f, "[[0.3, 0.4, 0.5], [0.3, -0.4, 0.5]]", "cpu");
    let (_, bytes) = answer(&folder).unwrap();
    let total = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    let floats: Vec<f32> =
        bytes[16 + 12..16 + 12 + 12 * total].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let half = total / 2;
    for k in 0..half {
        let (a, b) = (&floats[3 * k..3 * k + 3], &floats[3 * (half + k)..3 * (half + k) + 3]);
        assert_eq!((a[0], a[2]), (b[0], b[2]));
        assert_eq!(a[1], -b[1]);
    }
}

#[test]
fn refusals_name_the_input_problem() {
    let f = field(false, vec![]);
    let mut folder = job("sha", &f, IDENTITY, "probe", r#""probe": { "pointsM": [] }"#);
    fs::write(folder.0.join("field.bin"), b"LLFD tampered").unwrap();
    let (code, message) = answer(&folder).unwrap_err();
    assert_eq!(code, "CFD_RESULT_HASH_MISMATCH");
    assert!(message.contains("fieldSha256"), "{message}");
    folder = job("name", &f, IDENTITY, "probe", r#""probe": { "pointsM": [] }"#);
    let text = fs::read_to_string(folder.0.join("job.json")).unwrap().replace(r#""field": "field.bin""#, r#""field": "../field.bin""#);
    fs::write(folder.0.join("job.json"), text).unwrap();
    assert!(answer(&folder).unwrap_err().1.contains("must be \"field.bin\""));
    folder = job("mirrored", &f, r#"{ "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, -1] }"#, "probe", r#""probe": { "pointsM": [] }"#);
    assert!(answer(&folder).unwrap_err().1.contains("right-handed"));
    folder = job("section", &f, IDENTITY, "slice", r#""probe": { "pointsM": [] }"#);
    assert!(answer(&folder).unwrap_err().1.contains("'slice' section"));
    folder = job("frame", &f, r#"{ "x": [1, 0, 0], "y": [1, 0, 0], "z": [0, 0, 1] }"#, "probe", r#""probe": { "pointsM": [] }"#);
    assert!(answer(&folder).unwrap_err().1.contains("orthonormal"));
    let seeds = format!("[{}]", vec!["[0.5, 0.5, 0.5]"; 4097].join(","));
    folder = streamline_job("cap", &f, &seeds, "cpu");
    assert!(answer(&folder).unwrap_err().1.contains("4096"));
    folder = job("unknown", &f, IDENTITY, "probe", r#""probe": { "pointsM": [] }, "bogus": 1"#);
    assert_eq!(answer(&folder).unwrap_err().0, "NATIVE_JOB_INPUT");
}

#[test]
fn auto_falls_back_to_the_cpu_or_traces_on_the_gpu() {
    let f = field(true, vec![]);
    let folder = streamline_job("auto", &f, "[[0.5, 0.5, 0.5]]", "auto");
    let (json, _) = answer(&folder).unwrap();
    let device = json["streamlines"]["device"].as_str().unwrap();
    assert!(device == "cpu" || device == "gpu", "{device}");
    assert_eq!(json["streamlines"]["lines"][0]["stopForward"], "wall");
    if device == "cpu" {
        assert!(json["streamlines"]["gpuFallback"].is_string());
    } else {
        assert_eq!(json["streamlines"]["deterministic"], false);
        assert!(json["streamlines"]["adapter"].is_string());
    }
}
