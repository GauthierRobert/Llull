//! PCA normals (TECHNICAL_SPEC §5.4): the eigenvector of the smallest eigenvalue of the covariance of the k nearest neighbours (cyclic
//! Jacobi), oriented toward `viewpoint`; curvature λ_min / Σλ is returned as a planarity measure. rayon over fixed chunks, merged in order.

use crate::cloud::Vec3;
use crate::kdtree::KdTree;
use crate::linalg::{column, dot, jacobi_eigen, mean, scatter, sub};
use rayon::prelude::*;

/// Normals and curvatures of every point of `tree`, from `k` neighbours.
pub fn pca_normals(tree: &KdTree, k: usize, viewpoint: &Vec3) -> Vec<(Vec3, f64)> {
    (0..tree.len())
        .collect::<Vec<usize>>()
        .par_chunks(1024)
        .flat_map_iter(|chunk| {
            chunk.iter().map(|&i| {
                let neighbours: Vec<Vec3> = tree.knn(tree.point(i), k).iter().map(|(j, _)| *tree.point(*j)).collect();
                let centre = mean(&neighbours);
                let (values, vectors) = jacobi_eigen(scatter(&neighbours, &centre));
                let mut n = column(&vectors, 0);
                if dot(&n, &sub(viewpoint, tree.point(i))) < 0.0 {
                    n = [-n[0], -n[1], -n[2]];
                }
                let total = values.iter().map(|v| v.max(0.0)).sum::<f64>();
                (n, if total > 0.0 { values[0].max(0.0) / total } else { 0.0 })
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plane_has_vertical_normals_toward_the_viewpoint() {
        let points: Vec<Vec3> = (0..400).map(|i| [f64::from(i % 20) * 0.01, f64::from(i / 20) * 0.01, 0.0]).collect();
        let tree = KdTree::build(&points);
        for (n, curvature) in pca_normals(&tree, 12, &[0.1, 0.1, 5.0]) {
            assert!((n[2] - 1.0).abs() < 1e-9, "{n:?}");
            assert!(curvature < 1e-12);
        }
    }
}
