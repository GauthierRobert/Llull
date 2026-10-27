//! Symmetric deviation of two meshes (twin of `deviation.ts`): closest-surface distance from sample points of each mesh (the used vertices,
//! then the triangle centroids, evenly strided down to `max_samples`) to the other. Bit-identical to the TypeScript engine, on any thread count.

use crate::geom::Vec3;
use crate::surface::SurfaceIndex;
use rayon::prelude::*;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Worst {
    pub point: Vec3,
    pub mesh: &'static str,
    pub distance: f64,
}

#[derive(Debug, Serialize)]
pub struct Deviation {
    #[serde(rename = "forwardMax")]
    pub forward_max: f64,
    #[serde(rename = "backwardMax")]
    pub backward_max: f64,
    pub hausdorff: f64,
    pub mean: f64,
    pub rms: f64,
    pub samples: usize,
    pub histogram: [u64; 10],
    pub worst: Worst,
}

fn sample_points(positions: &[f64], triangles: &[u32], max_samples: usize) -> Vec<Vec3> {
    let vertices = positions.len() / 3;
    let mut used = vec![false; vertices];
    for &v in triangles {
        used[v as usize] = true;
    }
    let mut points: Vec<Vec3> = Vec::new();
    for (v, &is_used) in used.iter().enumerate() {
        if is_used {
            points.push([positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
        }
    }
    for t in triangles.chunks_exact(3) {
        let centre = |axis: usize| {
            (positions[t[0] as usize * 3 + axis] + positions[t[1] as usize * 3 + axis] + positions[t[2] as usize * 3 + axis]) / 3.0
        };
        points.push([centre(0), centre(1), centre(2)]);
    }
    if points.len() <= max_samples {
        return points;
    }
    let stride = points.len() as f64 / max_samples as f64;
    (0..max_samples).map(|i| points[(i as f64 * stride).floor() as usize]).collect()
}

/// Both-way deviation of mesh `a` and mesh `b`; `None` when either has no triangle.
pub fn deviation(a: (&[f64], &[u32]), b: (&[f64], &[u32]), max_samples: usize) -> Option<Deviation> {
    if a.1.len() < 3 || b.1.len() < 3 {
        return None;
    }
    let (index_a, index_b) = rayon::join(|| SurfaceIndex::new(a.0, a.1), || SurfaceIndex::new(b.0, b.1));
    let (points_a, points_b) = (sample_points(a.0, a.1, max_samples), sample_points(b.0, b.1, max_samples));
    // each distance depends on its point alone, so the order and the number of threads do not matter
    let forward: Vec<f64> = points_a.par_iter().map(|&p| index_b.closest_distance(p)).collect();
    let backward: Vec<f64> = points_b.par_iter().map(|&p| index_a.closest_distance(p)).collect();
    let all: Vec<f64> = forward.iter().chain(backward.iter()).copied().collect();
    let forward_max = forward.iter().fold(0.0f64, |m, &d| m.max(d));
    let backward_max = backward.iter().fold(0.0f64, |m, &d| m.max(d));
    let hausdorff = forward_max.max(backward_max);
    let mut histogram = [0u64; 10];
    for &d in &all {
        let bin = if hausdorff > 0.0 { (((d / hausdorff) * 10.0).floor() as usize).min(9) } else { 0 };
        histogram[bin] += 1;
    }
    let from_a = forward_max >= backward_max;
    let (distances, points) = if from_a { (&forward, &points_a) } else { (&backward, &points_b) };
    let target = if from_a { forward_max } else { backward_max };
    let worst_index = distances.iter().position(|&d| d == target).unwrap_or(0);
    Some(Deviation {
        forward_max,
        backward_max,
        hausdorff,
        mean: all.iter().fold(0.0, |s, &d| s + d) / all.len() as f64,
        rms: (all.iter().fold(0.0, |s, &d| s + d * d) / all.len() as f64).sqrt(),
        samples: all.len(),
        histogram,
        worst: Worst { point: points[worst_index], mesh: if from_a { "a" } else { "b" }, distance: hausdorff },
    })
}
