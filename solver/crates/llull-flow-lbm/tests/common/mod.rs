//! Shared fixtures: a sphere job folder (case.json + surface.stl) for the sphere-drag and job-contract tests.

use llull_flow_core::stl::{sphere_triangles, write_binary_stl};
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
    let dir = std::env::temp_dir().join(format!("llull-flow-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let triangles = sphere_triangles([0.0; 3], 0.5, 24, 48);
    fs::write(dir.join("surface.stl"), write_binary_stl(&triangles, "llull sphere")).unwrap();
    let [upstream, downstream, half] = extents;
    let case = format!(
        r#"{{
  "version": 1, "caseId": "sphere",
  "grid": {{ "cellM": {h}, "minM": [{xmin}, {ymin}, {ymin}], "maxM": [{xmax}, {ymax}, {ymax}] }},
  "flow": {{ "speedMS": 1.0, "direction": [1, 0, 0], "densityKgM3": 1.0, "viscosityPaS": {nu} }},
  "reference": {{ "areaM2": 0.7853981633974483, "lengthM": 1.0, "momentPointM": [0, 0, 0] }},
  "bodies": [{{ "entityId": "ball", "triangles": [0, {count}] }}],
  "settings": {settings},
  "outputs": {outputs}
}}"#,
        h = 1.0 / cells_per_d as f64,
        xmin = -upstream,
        xmax = downstream,
        ymin = -half,
        ymax = half,
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
