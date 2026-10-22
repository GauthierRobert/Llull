#![allow(dead_code)]
//! Shared fixtures: a sphere job folder (case.json + surface.stl) for the sphere-drag and job-contract tests.

use llull_flow_core::stl::{box_triangles, sphere_triangles, write_binary_stl, Triangle};
use std::fs;
use std::path::{Path, PathBuf};

pub struct SphereJob {
    pub dir: PathBuf,
}

impl Drop for SphereJob {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A unit-diameter sphere at the origin, U = 1 m/s, ρ = 1 kg/m³, ν = 1 / re m²/s, in a box of `extents` diameters
/// `[upstream, downstream, half-width]`, `cells_per_d` cells per diameter; `settings` is spliced into `case.json`.
pub fn sphere_job(name: &str, cells_per_d: usize, re: f64, extents: [f64; 3], settings: &str, outputs: &str) -> SphereJob {
    let [upstream, downstream, half] = extents;
    sphere_job_in(name, cells_per_d, re, [-upstream, -half, -half], [downstream, half, half], settings, outputs, "{}")
}

/// [`sphere_job`] with an explicit fluid box and `faces` JSON.
#[allow(clippy::too_many_arguments)]
pub fn sphere_job_in(
    name: &str,
    cells_per_d: usize,
    re: f64,
    min: [f64; 3],
    max: [f64; 3],
    settings: &str,
    outputs: &str,
    faces: &str,
) -> SphereJob {
    body_job_in(name, sphere_triangles([0.0; 3], 0.5, 24, 48), cells_per_d, re, min, max, settings, outputs, faces)
}

/// A unit cube at the origin (faces on cell boundaries at 8 cells per unit: an exactly mirror-symmetric voxelisation).
#[allow(clippy::too_many_arguments)]
pub fn cube_job_in(
    name: &str,
    cells_per_d: usize,
    re: f64,
    min: [f64; 3],
    max: [f64; 3],
    settings: &str,
    outputs: &str,
    faces: &str,
) -> SphereJob {
    body_job_in(name, box_triangles([-0.5; 3], [0.5; 3]), cells_per_d, re, min, max, settings, outputs, faces)
}

#[allow(clippy::too_many_arguments)]
fn body_job_in(
    name: &str,
    triangles: Vec<Triangle>,
    cells_per_d: usize,
    re: f64,
    min: [f64; 3],
    max: [f64; 3],
    settings: &str,
    outputs: &str,
    faces: &str,
) -> SphereJob {
    let dir = std::env::temp_dir().join(format!("llull-flow-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("surface.stl"), write_binary_stl(&triangles, "llull sphere")).unwrap();
    let case = format!(
        r#"{{
  "version": 1, "caseId": "sphere",
  "grid": {{ "cellM": {h}, "minM": [{x0}, {y0}, {z0}], "maxM": [{x1}, {y1}, {z1}] }},
  "flow": {{ "speedMS": 1.0, "direction": [1, 0, 0], "densityKgM3": 1.0, "viscosityPaS": {nu} }},
  "reference": {{ "areaM2": 0.7853981633974483, "lengthM": 1.0, "momentPointM": [0, 0, 0] }},
  "faces": {faces},
  "bodies": [{{ "entityId": "ball", "triangles": [0, {count}] }}],
  "settings": {settings},
  "outputs": {outputs}
}}"#,
        h = 1.0 / cells_per_d as f64,
        x0 = min[0],
        y0 = min[1],
        z0 = min[2],
        x1 = max[0],
        y1 = max[1],
        z1 = max[2],
        nu = 1.0 / re,
        count = triangles.len(),
    );
    fs::write(dir.join("case.json"), case).unwrap();
    SphereJob { dir }
}

/// Runs the job and returns the events printed and the outcome.
pub fn run_job(folder: &Path) -> (Vec<serde_json::Value>, Result<Vec<llull_protocol::Output>, llull_flow_lbm::job::JobError>) {
    let mut out = Vec::new();
    let result = llull_flow_lbm::job::run(folder, &mut out);
    let events = String::from_utf8(out).unwrap().lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
    (events, result)
}

pub fn result_json(folder: &Path) -> serde_json::Value {
    serde_json::from_str(&fs::read_to_string(folder.join("result.json")).unwrap()).unwrap()
}
