//! Shared test helpers: the plant 10 validation pack (`docs/plant/10-pointcloud-brownfield/validation/data`, licences in `data/licenses/`).
#![allow(dead_code)]

use std::path::{Path, PathBuf};

pub fn data(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/plant/10-pointcloud-brownfield/validation/data").join(relative)
}

pub fn json(relative: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(data(relative)).unwrap()).unwrap()
}

pub fn vec3(value: &serde_json::Value) -> [f64; 3] {
    let a = value.as_array().unwrap();
    [a[0].as_f64().unwrap(), a[1].as_f64().unwrap(), a[2].as_f64().unwrap()]
}

pub fn close(a: [f64; 3], b: [f64; 3], tolerance: f64) -> bool {
    (0..3).all(|i| (a[i] - b[i]).abs() <= tolerance)
}

/// The synthetic CSVs of the pack (header `x_m,y_m,z_m`).
pub fn csv(relative: &str) -> Vec<[f64; 3]> {
    std::fs::read_to_string(data(relative))
        .unwrap()
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: Vec<f64> = l.split(',').map(|t| t.trim().parse().unwrap()).collect();
            [v[0], v[1], v[2]]
        })
        .collect()
}

/// A fresh temporary directory under the target folder (removed by the caller when wanted).
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
