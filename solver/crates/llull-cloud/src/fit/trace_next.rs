//! The search for the straight after a bend (TECHNICAL_SPEC §5.6): a seeded, radius-constrained RANSAC on the points a leg does not explain.

use super::cylinder::{self, Cylinder};
use super::ransac_iterations;
use super::trace::{Tracer, MIN_WINDOW_POINTS};
use crate::cloud::Vec3;
use crate::kdtree::{KdTree, Rng};
use crate::linalg::{dot, mean, norm, scale, sub};
use crate::normals::pca_normals_within;

/// Normals of the next-leg search: neighbours needed inside r / 2, points scored per RANSAC iteration (stride beyond), inlier fraction.
const MIN_NORMAL_NEIGHBOURS: usize = 10;
const MAX_SCORED_POINTS: usize = 20_000;
const MIN_LEG_FRACTION: f64 = 0.15;

impl Tracer<'_> {
    /// The best radius-constrained cylinder in `candidates`: seeded RANSAC on two oriented points (normals from the neighbours within 0.6 r,
    /// so they do not depend on the point density), radius within ±15 % of `r`, then an LM refit on its inliers. None below 15 % inliers
    /// (and 3 windows' worth of points).
    pub(super) fn next_axis(&self, candidates: &[Vec3], r: f64, seed: u64) -> Option<Cylinder> {
        let tree = KdTree::build(candidates);
        let normals = pca_normals_within(&tree, 0.6 * r, MIN_NORMAL_NEIGHBOURS, &mean(candidates));
        let stride = (candidates.len() / MAX_SCORED_POINTS).max(1);
        let usable: Vec<usize> = (0..candidates.len()).filter(|&i| normals[i].is_some()).collect();
        if usable.len() < 2 * MIN_WINDOW_POINTS {
            return None;
        }
        let scored: Vec<usize> = usable.iter().copied().step_by(stride).collect();
        let cos_alpha = libm::cos(self.settings.fit.normal_threshold_deg.to_radians());
        let mut rng = Rng::new(seed);
        let (mut best, mut budget, mut iterations) = (None::<(usize, Cylinder)>, ransac_iterations(0.0, 2), 0);
        while iterations < budget {
            iterations += 1;
            let (i, j) = (usable[rng.below(usable.len())], usable[rng.below(usable.len())]);
            let (Some(n1), Some(n2)) = (normals[i], normals[j]) else { continue };
            let Some(model) = cylinder::from_two(&candidates[i], &n1, &candidates[j], &n2) else { continue };
            if !(model.radius > 0.85 * r && model.radius < 1.15 * r) {
                continue;
            }
            let count = scored
                .iter()
                .filter(|&&k| {
                    let p = &candidates[k];
                    let radial = sub(&sub(p, &model.point), &scale(&model.axis, dot(&sub(p, &model.point), &model.axis)));
                    model.distance(p).abs() < self.band && normals[k].is_some_and(|n| dot(&radial, &n).abs() > cos_alpha * norm(&radial))
                })
                .count();
            if best.is_none_or(|(c, _)| count > c) {
                best = Some((count, model));
                budget = ransac_iterations(count as f64 / scored.len() as f64, 2);
            }
        }
        let (count, model) = best?;
        if count < 3 * MIN_WINDOW_POINTS / stride.max(1) || (count as f64) < MIN_LEG_FRACTION * scored.len() as f64 {
            return None;
        }
        let inliers: Vec<Vec3> = candidates.iter().filter(|p| model.distance(p).abs() < self.band).copied().collect();
        Some(cylinder::refine_cylinder(&inliers, &model))
    }
}
