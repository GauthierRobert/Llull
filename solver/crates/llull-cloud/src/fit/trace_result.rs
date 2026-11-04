//! The result of a centreline trace (TECHNICAL_SPEC §5.6): the legs the tracer found become straights, bends (one fit per pair of neighbours), the
//! centreline polyline through every PI, the diameter estimate and the stop reasons.

use super::bend::{fit_bend, Bend};
use super::trace::{Leg, Stop, Tracer};
use super::{FitWarning, Threshold};
use crate::cloud::Vec3;
use crate::linalg::{norm, sub};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Straight {
    pub start: Vec3,
    pub end: Vec3,
    pub direction: Vec3,
    pub radius: f64,
    pub length: f64,
    pub inliers: usize,
    pub rms: f64,
    pub coverage_deg: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reducer {
    pub position: Vec3,
    pub radius_before: f64,
    pub radius_after: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diameter {
    pub value: f64,
    /// Spread of the leg radii (several legs) or rms / sqrt(n) (one leg).
    pub std: f64,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ends {
    pub start: &'static str,
    pub end: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    /// Start, every PI, end: the polyline `add_pipe_run` takes (bends at the interior points).
    pub centreline: Vec<Vec3>,
    pub straights: Vec<Straight>,
    pub bends: Vec<Bend>,
    pub intersection_points: Vec<Vec3>,
    pub reducers: Vec<Reducer>,
    pub diameter: Diameter,
    pub radius: f64,
    pub inliers: usize,
    pub points_in_region: usize,
    /// RMS of the surface residuals over every leg's inliers.
    pub rms: f64,
    pub ends: Ends,
    pub step_length: f64,
    pub threshold: Threshold,
    pub warnings: Vec<FitWarning>,
}

pub(super) fn assemble(
    tracer: &Tracer,
    legs: &[Leg],
    points_in_region: usize,
    stops: (Stop, Stop),
    (step, threshold): (f64, Threshold),
    mut warnings: Vec<FitWarning>,
) -> TraceResult {
    let mut bends: Vec<Bend> = Vec::new();
    let (mut legs, mut stops) = (legs, stops);
    for (i, pair) in legs.windows(2).enumerate() {
        let tube = (pair[0].radius + pair[1].radius) / 2.0;
        let found = fit_bend(
            tracer.tree,
            (&pair[0].point, &pair[0].dir),
            (&pair[1].point, &pair[1].dir),
            tube,
            tracer.band,
            tracer.settings.max_bend_radius_factor,
        );
        let Some(bend) = found else {
            // Parallel axes have no intersection point: the trace ends after straight i (a later bend must not shift onto another pair).
            warnings.push(FitWarning {
                code: "SCN_TRACE_SKEW",
                message: format!("straights {i} and {} are parallel: no intersection point, the trace ends after straight {i}", i + 1),
            });
            legs = &legs[..=i];
            stops.1 = Stop::Bend;
            break;
        };
        if !bend.radius_measured {
            warnings.push(FitWarning {
                code: "SCN_TRACE_BEND_RADIUS_UNMEASURED",
                message: format!(
                    "bend at PI {:?}: radius {:.4} m sits on a search bound or has too few arc points",
                    bend.intersection_point, bend.radius
                ),
            });
        }
        bends.push(bend);
    }
    let (first, last) = (&legs[0], &legs[legs.len() - 1]);
    let mut straights = Vec::new();
    for (i, leg) in legs.iter().enumerate() {
        let start = if i == 0 { None } else { bends.get(i - 1).map(|b| b.tangent_end) }.unwrap_or_else(|| leg.at(leg.data_lo));
        let end = if i + 1 == legs.len() { None } else { bends.get(i).map(|b| b.tangent_start) }.unwrap_or_else(|| leg.at(leg.data_hi));
        straights.push(Straight {
            start,
            end,
            direction: leg.dir,
            radius: leg.radius,
            length: norm(&sub(&end, &start)),
            inliers: leg.inliers,
            rms: leg.rms,
            coverage_deg: leg.coverage,
        });
        if leg.coverage < super::LOW_COVERAGE_DEG {
            warnings.push(FitWarning {
                code: "SCN_FIT_LOW_COVERAGE",
                message: format!("straight {i}: angular coverage {:.1} deg below {} deg", leg.coverage, super::LOW_COVERAGE_DEG),
            });
        }
    }
    let pis: Vec<Vec3> = bends.iter().map(|b| b.intersection_point).collect();
    let mut centreline = vec![straights[0].start];
    centreline.extend(&pis);
    centreline.push(straights[straights.len() - 1].end);
    let total: f64 = straights.iter().map(|s| s.length).sum::<f64>().max(1e-12);
    let mean_radius = straights.iter().map(|s| s.radius * s.length).sum::<f64>() / total;
    let inliers: usize = legs.iter().map(|l| l.inliers).sum();
    let std = if legs.len() > 1 {
        (straights.iter().map(|s| s.length * (s.radius - mean_radius).powi(2)).sum::<f64>() / total).sqrt()
    } else {
        first.rms / (first.inliers.max(1) as f64).sqrt()
    };
    let mut reducers = Vec::new();
    for (stop, leg, t) in [(stops.0, first, first.data_lo), (stops.1, last, last.data_hi)] {
        if let Stop::Radius(after) = stop {
            reducers.push(Reducer { position: leg.at(t), radius_before: leg.radius, radius_after: after });
        }
    }
    TraceResult {
        centreline,
        straights,
        bends,
        intersection_points: pis,
        reducers,
        diameter: Diameter { value: 2.0 * mean_radius, std: 2.0 * std, source: "length-weighted mean of the straights' fitted radii" },
        radius: mean_radius,
        inliers,
        points_in_region,
        rms: (legs.iter().map(|l| l.inliers as f64 * l.rms * l.rms).sum::<f64>() / inliers.max(1) as f64).sqrt(),
        ends: Ends { start: stops.0.reason(), end: stops.1.reason() },
        step_length: step,
        threshold,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fit::trace::TraceSettings;
    use crate::kdtree::KdTree;

    fn leg(point: Vec3, dir: Vec3) -> Leg {
        Leg {
            point,
            dir,
            radius: 0.05,
            t_min: -0.5,
            t_max: 0.5,
            data_lo: -0.5,
            data_hi: 0.5,
            inliers: 100,
            rms: 0.001,
            coverage: 360.0,
            stop_min: Stop::NoPoints,
            stop_max: Stop::Bend,
        }
    }

    #[test]
    fn parallel_straights_end_the_trace_instead_of_shifting_later_bends() {
        let tree = KdTree::build(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]);
        let settings = TraceSettings::default();
        let tracer = Tracer { tree: &tree, settings: &settings, band: 0.003, max_windows: 8 };
        let threshold = Threshold { value: 0.003, source: "test", spacing: 0.01 };
        // x-axis, a parallel x-axis one metre aside, then a +y leg: the first pair has no PI.
        let legs = [leg([0.0; 3], [1.0, 0.0, 0.0]), leg([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]), leg([2.0, 1.0, 0.0], [0.0, 1.0, 0.0])];
        let result = assemble(&tracer, &legs, 2, (Stop::NoPoints, Stop::NoPoints), (0.1, threshold), Vec::new());
        assert!(result.bends.is_empty() && result.intersection_points.is_empty());
        assert_eq!(result.straights.len(), 1);
        assert_eq!(result.centreline.len(), 2);
        assert_eq!(result.ends.end, "bend_not_continued");
        assert!(result.warnings.iter().any(|w| w.code == "SCN_TRACE_SKEW" && w.message.contains("parallel")));
    }
}
