//! Shared model builders of the benchmark tests (N-mm-t-s units: mm, s, t, MPa, mJ).
#![allow(dead_code)]

use llull_explicit::model::{Controls, JohnsonCook, Material, Model, Wall};

/// Test material (NOT a material claim): E 200 GPa, 7850 kg/m³, `poisson` as given.
pub fn steel(poisson: f64, johnson_cook: Option<JohnsonCook>) -> Material {
    Material { density: 7.85e-9, youngs_modulus: 200_000.0, poisson, johnson_cook, failure: None, heating: None }
}

pub fn controls(end_time: f64, history_interval: f64) -> Controls {
    Controls {
        end_time,
        history_interval,
        time_step_scale: 0.9,
        min_time_step: None,
        hourglass_coefficient: 0.1,
        bulk_linear: 0.06,
        bulk_quadratic: 1.5,
        mass_scaling: None,
        max_cycles: 10_000_000,
    }
}

/// Structured grid of `n[0] × n[1] × n[2]` hexahedra over the box `[min, min + size]`, node order as the llull job builder.
pub fn hex_grid(min: [f64; 3], size: [f64; 3], n: [usize; 3]) -> (Vec<f64>, Vec<u32>) {
    let node = |i: usize, j: usize, k: usize| (i + (n[0] + 1) * (j + (n[1] + 1) * k)) as u32;
    let mut coordinates = Vec::new();
    for k in 0..=n[2] {
        for j in 0..=n[1] {
            for i in 0..=n[0] {
                coordinates.extend_from_slice(&[
                    min[0] + size[0] * i as f64 / n[0] as f64,
                    min[1] + size[1] * j as f64 / n[1] as f64,
                    min[2] + size[2] * k as f64 / n[2] as f64,
                ]);
            }
        }
    }
    let mut hex8 = Vec::new();
    for k in 0..n[2] {
        for j in 0..n[1] {
            for i in 0..n[0] {
                for [di, dj, dk] in [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] {
                    hex8.push(node(i + di, j + dj, k + dk));
                }
            }
        }
    }
    (coordinates, hex8)
}

/// Six positive tetrahedra per hexahedron (the Kuhn split along the 1–7 diagonal).
pub fn tets_of(hex8: &[u32]) -> Vec<u32> {
    const SPLIT: [[usize; 4]; 6] = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
    hex8.chunks_exact(8).flat_map(|h| SPLIT.iter().flat_map(move |t| t.map(|k| h[k]))).collect()
}

/// A model of one material over `hex8` / `tet4`, every node at `velocity`.
pub fn model(coordinates: Vec<f64>, hex8: Vec<u32>, tet4: Vec<u32>, material: Material, velocity: [f64; 3], controls: Controls) -> Model {
    let nodes = coordinates.len() / 3;
    let elements = hex8.len() / 8 + tet4.len() / 4;
    Model {
        coordinates,
        hex8,
        tet4,
        element_material: vec![0; elements],
        materials: vec![material],
        initial_velocity: (0..nodes).flat_map(|_| velocity).collect(),
        gravity: [0.0; 3],
        walls: vec![],
        controls,
        element_part: vec![],
        contacts: vec![],
        fixed: vec![],
        shell4: vec![],
        shell_thickness: vec![],
        shell_points: 2,
        fixed_rotation: vec![],
        initial_temperature: None,
        shell_warping: true,
    }
}

pub fn floor(name: &str) -> Wall {
    Wall { name: name.to_string(), point: [0.0, 0.0, 0.0], normal: [0.0, 0.0, 1.0] }
}

/// The 10 x 10 x 200 mm bar of the validation plan at 10 m/s onto a wall at z = 0, `elements_along` hexahedra along the bar.
pub fn bar(poisson: f64, elements_along: usize, end_time: f64) -> Model {
    let (coordinates, hex8) = hex_grid([0.0, 0.0, 0.0], [10.0, 10.0, 200.0], [2, 2, elements_along]);
    let mut bar = model(coordinates, hex8, vec![], steel(poisson, None), [0.0, 0.0, -10_000.0], controls(end_time, 1e-6));
    bar.walls.push(floor("anvil"));
    bar
}
