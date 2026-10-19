//! Cloud-to-model deviation (TECHNICAL_SPEC §5.9, FR-SCN-17, 18) and design-vs-scan clash (§5.10, FR-SCN-19), Rust CPU: the numbers that
//! reports and VCs use. Points are processed in fixed chunks of [`CHUNK`] (rayon) and the chunk partials merged in chunk order, so every
//! sum is identical for any thread count (RS1 §2 rule 3).

use crate::cloud::Vec3;
use crate::distance::{Entity, PipeAxis};
use crate::fit::cylinder::{refine_cylinder, Cylinder};
use crate::kdtree::{median_spacing, KdTree};
use crate::linalg::{dot, norm, scale, sub, unit};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::BTreeMap;

pub const CHUNK: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviationStats {
    pub id: String,
    pub points_used: u64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mean: Option<f64>,
    pub rms: Option<f64>,
    pub fraction_beyond_threshold: Option<f64>,
    /// Counts over `histogramBins` equal bins of [−maxDistance, maxDistance] (signed) or [0, maxDistance].
    pub histogram: Vec<u64>,
    /// Pipes: the cylinder refitted to the assigned points against the design axis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipe: Option<PipeDeviation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeDeviation {
    /// Distance from the design axis mid-point to the fitted axis.
    pub fitted_axis_offset: f64,
    /// Vector from the design mid-point to its foot on the fitted axis.
    pub offset_vector: Vec3,
    pub radius_delta: f64,
    pub fitted_radius: f64,
}

#[derive(Clone)]
struct Partial {
    count: u64,
    min: f64,
    max: f64,
    sum: f64,
    sum_squares: f64,
    beyond: u64,
    histogram: Vec<u64>,
}

impl Partial {
    fn new(bins: usize) -> Partial {
        Partial { count: 0, min: f64::INFINITY, max: f64::NEG_INFINITY, sum: 0.0, sum_squares: 0.0, beyond: 0, histogram: vec![0; bins] }
    }

    fn merge(&mut self, other: &Partial) {
        self.count += other.count;
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
        self.sum += other.sum;
        self.sum_squares += other.sum_squares;
        self.beyond += other.beyond;
        for (a, b) in self.histogram.iter_mut().zip(&other.histogram) {
            *a += b;
        }
    }
}

/// Deviation settings (metres).
#[derive(Debug, Clone, Copy)]
pub struct DeviationSettings {
    pub max_distance: f64,
    pub threshold: f64,
    pub signed: bool,
    pub bins: usize,
}

/// Index of the entity nearest to `p` within `max_distance` (by |d|, ties: lower index) and its distance.
pub fn assign(entities: &[Entity], p: &Vec3, max_distance: f64) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (i, entity) in entities.iter().enumerate() {
        if !entity.near(p, max_distance) {
            continue;
        }
        let d = entity.distance(p);
        if d.abs() <= max_distance && best.is_none_or(|(_, b)| d.abs() < b.abs()) {
            best = Some((i, d));
        }
    }
    best
}

fn axis_offset(design: &PipeAxis, fitted: &Cylinder) -> PipeDeviation {
    let mid = scale(&crate::linalg::add(&design.start, &design.end), 0.5);
    let v = sub(&mid, &fitted.point);
    let foot = crate::linalg::add(&fitted.point, &scale(&fitted.axis, dot(&v, &fitted.axis)));
    let offset = sub(&foot, &mid);
    PipeDeviation {
        fitted_axis_offset: norm(&offset),
        offset_vector: offset,
        radius_delta: fitted.radius - design.radius,
        fitted_radius: fitted.radius,
    }
}

/// Per-entity deviation of `points` (document frame, metres); `distances` (optional) overrides the per-point assignment with precomputed
/// (entity, distance) pairs (the GPU path's picture never feeds this: the numbers always come from here).
pub fn deviation(points: &[Vec3], entities: &[Entity], settings: &DeviationSettings) -> Vec<DeviationStats> {
    let bins = settings.bins.max(1);
    let low = if settings.signed { -settings.max_distance } else { 0.0 };
    let width = (settings.max_distance - low) / bins as f64;
    let assigned: Vec<Option<(usize, f64)>> =
        points.par_chunks(CHUNK).flat_map_iter(|chunk| chunk.iter().map(|p| assign(entities, p, settings.max_distance))).collect();
    let partials: Vec<Vec<Partial>> = assigned
        .par_chunks(CHUNK)
        .map(|chunk| {
            let mut partial = vec![Partial::new(bins); entities.len()];
            for (i, d) in chunk.iter().flatten() {
                let value = if settings.signed { *d } else { d.abs() };
                let s = &mut partial[*i];
                s.count += 1;
                s.min = s.min.min(value);
                s.max = s.max.max(value);
                s.sum += value;
                s.sum_squares += value * value;
                if value.abs() > settings.threshold {
                    s.beyond += 1;
                }
                let bin = (((value - low) / width).floor().max(0.0) as usize).min(bins - 1);
                s.histogram[bin] += 1;
            }
            partial
        })
        .collect();
    let mut totals = vec![Partial::new(bins); entities.len()];
    for chunk in &partials {
        for (total, part) in totals.iter_mut().zip(chunk) {
            total.merge(part);
        }
    }
    entities
        .iter()
        .enumerate()
        .map(|(i, entity)| {
            let t = &totals[i];
            let n = t.count as f64;
            let some = |v: f64| (t.count > 0).then_some(v);
            let pipe = entity.pipe.and_then(|design| {
                let mine: Vec<Vec3> =
                    points.iter().zip(&assigned).filter(|(_, a)| a.is_some_and(|(k, _)| k == i)).map(|(p, _)| *p).collect();
                let axis = unit(&sub(&design.end, &design.start))?;
                (mine.len() >= 30)
                    .then(|| axis_offset(&design, &refine_cylinder(&mine, &Cylinder { point: design.start, axis, radius: design.radius })))
            });
            DeviationStats {
                id: entity.id.clone(),
                points_used: t.count,
                min: some(t.min),
                max: some(t.max),
                mean: some(t.sum / n),
                rms: some((t.sum_squares / n).sqrt()),
                fraction_beyond_threshold: some(t.beyond as f64 / n),
                histogram: t.histogram.clone(),
                pipe,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cluster {
    pub points: usize,
    pub min_gap: f64,
    pub location: Vec3,
    pub bbox_min: Vec3,
    pub bbox_max: Vec3,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClashResult {
    pub id: String,
    /// `hard` (a cluster inside the entity), `clearance` (a cluster within the clearance) or `clear`.
    pub status: &'static str,
    /// Smallest signed gap of the kept clusters, else of every point searched (None when no scan point was within reach).
    pub min_gap: Option<f64>,
    pub location: Option<Vec3>,
    pub points: usize,
    pub clusters: Vec<Cluster>,
    /// Points ignored as noise (clusters below minPointsInVolume).
    pub noise_points: usize,
    /// Points excluded as the entity's own as-built surface.
    pub excluded_points: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct ClashSettings {
    pub clearance: f64,
    pub min_points: usize,
    /// Reach for the gap of a clear entity (named default 1 m).
    pub search_distance: f64,
}

/// Groups points by 26-connected voxels of edge `voxel` (deterministic: voxels visited in key order).
fn clusters_of(points: &[(Vec3, f64)], voxel: f64) -> Vec<Vec<usize>> {
    let key = |p: &Vec3| -> [i64; 3] { std::array::from_fn(|a| (p[a] / voxel).floor() as i64) };
    let mut cells: BTreeMap<[i64; 3], Vec<usize>> = BTreeMap::new();
    for (i, (p, _)) in points.iter().enumerate() {
        cells.entry(key(p)).or_default().push(i);
    }
    let mut seen: BTreeMap<[i64; 3], bool> = cells.keys().map(|k| (*k, false)).collect();
    let mut groups = Vec::new();
    for start in cells.keys() {
        if seen[start] {
            continue;
        }
        let mut stack = vec![*start];
        seen.insert(*start, true);
        let mut members = Vec::new();
        while let Some(cell) = stack.pop() {
            members.extend(&cells[&cell]);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let next = [cell[0] + dx, cell[1] + dy, cell[2] + dz];
                        if seen.get(&next) == Some(&false) {
                            seen.insert(next, true);
                            stack.push(next);
                        }
                    }
                }
            }
        }
        members.sort_unstable();
        groups.push(members);
    }
    groups
}

/// Design-vs-scan clash of each entity with `points`: d < 0 hard, d < clearance clearance; clusters (voxel 2 × spacing) below
/// `min_points` are noise. `exclude[i]` (metres): points with |d| below it are the entity's own as-built surface and are ignored.
pub fn clash(points: &[Vec3], entities: &[Entity], exclude: &[Option<f64>], settings: &ClashSettings) -> (Vec<ClashResult>, f64) {
    let spacing = if points.len() >= 2 { median_spacing(&KdTree::build(points), 2000) } else { 0.0 };
    let voxel = (2.0 * spacing).max(1e-6);
    let results = entities
        .iter()
        .enumerate()
        .map(|(i, entity)| {
            let reach = settings.search_distance.max(settings.clearance);
            let band = exclude.get(i).copied().flatten();
            let evaluated: Vec<(Vec3, f64)> = points
                .par_chunks(CHUNK)
                .flat_map_iter(|chunk| {
                    chunk
                        .iter()
                        .filter(|p| entity.near(p, reach))
                        .map(|p| (*p, entity.distance(p)))
                        .filter(|(_, d)| *d <= reach)
                        .collect::<Vec<_>>()
                })
                .collect();
            let excluded = band.map_or(0, |b| evaluated.iter().filter(|(_, d)| d.abs() < b).count());
            let kept: Vec<(Vec3, f64)> = evaluated.iter().filter(|(_, d)| band.is_none_or(|b| d.abs() >= b)).copied().collect();
            let violating: Vec<(Vec3, f64)> = kept.iter().filter(|(_, d)| *d < settings.clearance).copied().collect();
            let mut clusters = Vec::new();
            let mut noise = 0;
            for members in clusters_of(&violating, voxel) {
                if members.len() < settings.min_points {
                    noise += members.len();
                    continue;
                }
                let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
                let mut best = (f64::INFINITY, [0.0; 3]);
                for &m in &members {
                    let (p, d) = violating[m];
                    for a in 0..3 {
                        lo[a] = lo[a].min(p[a]);
                        hi[a] = hi[a].max(p[a]);
                    }
                    if d < best.0 {
                        best = (d, p);
                    }
                }
                clusters.push(Cluster {
                    points: members.len(),
                    min_gap: best.0,
                    location: best.1,
                    bbox_min: lo,
                    bbox_max: hi,
                    status: if best.0 < 0.0 { "hard" } else { "clearance" },
                });
            }
            let status = if clusters.iter().any(|c| c.status == "hard") {
                "hard"
            } else if clusters.is_empty() {
                "clear"
            } else {
                "clearance"
            };
            let gap_source: Vec<(f64, Vec3)> = if clusters.is_empty() {
                kept.iter().map(|(p, d)| (*d, *p)).collect()
            } else {
                clusters.iter().map(|c| (c.min_gap, c.location)).collect()
            };
            let nearest = gap_source
                .into_iter()
                .fold(None, |best: Option<(f64, Vec3)>, (d, p)| if best.is_none_or(|b| d < b.0) { Some((d, p)) } else { best });
            ClashResult {
                id: entity.id.clone(),
                status,
                min_gap: nearest.map(|n| n.0),
                location: nearest.map(|n| n.1),
                points: clusters.iter().map(|c| c.points).sum(),
                clusters,
                noise_points: noise,
                excluded_points: excluded,
            }
        })
        .collect();
    (results, spacing)
}
