//! The `sculpt` job of `llull-compute meshops` (DES-7c step 7, slice 3): parameters, checks and the report of the TypeScript engine.
//!
//! `{ brush, stamps: [[x, y, z], ..], radius, strength, falloff, direction: "normal" | "area_normal" | [x, y, z], symmetry?: "yz" | "xz" | "xy", taubin, maxHeight?,
//! refineEdge?, mask?: { center, radius }, planePoint?, maxTriangles? }` on a welded mesh (the stamps are projected onto it). The result is the sculpted mesh (compacted
//! when `refineEdge` is given, as the TypeScript engine does) and `report` = `{ movedVertices, maxDisplacement, displacedVolume, volumeBasis, symmetryError, refinedEdges,
//! stampsApplied }`. Failures: `SCULPT_OFF_SURFACE` (message: the index of the first stamp farther than `radius` from the surface), `SCULPT_TOO_LARGE` (the refined mesh passed
//! `maxTriangles`, default 4 000 000), and `NATIVE_JOB_INPUT` for a parameter the job does not take (a radius, strength, height or edge that is not a finite positive
//! number, a coordinate above 1e100 whose sums would overflow) or a result that is not finite (JSON cannot carry it): the host then falls through to the TypeScript engine.

use crate::geom::{Sphere, Vec3};
use crate::sculpt::{sculpt, Params, Sculpted, MAX_TRIANGLES};
use crate::sculpt_brush::{Brush, Direction, Falloff, Plane, Settings};
use crate::{input_error, JobError, Region};
use serde::Deserialize;
use serde_json::Value;

/// Largest coordinate the job takes: above it the products and sums of the brushes and of the volume overflow.
const MAX_COORDINATE: f64 = 1e100;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DirectionJob {
    Word(String),
    Vector([f64; 3]),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SculptJob {
    brush: Brush,
    stamps: Vec<[f64; 3]>,
    radius: f64,
    strength: f64,
    falloff: Falloff,
    direction: DirectionJob,
    symmetry: Option<Plane>,
    taubin: bool,
    max_height: Option<f64>,
    refine_edge: Option<f64>,
    mask: Option<Region>,
    plane_point: Option<[f64; 3]>,
    max_triangles: Option<usize>,
}

type Done = (Vec<f64>, Vec<u32>, Value);

fn positive(name: &str, value: f64) -> Result<f64, JobError> {
    if value.is_finite() && value > 0.0 && value <= MAX_COORDINATE {
        Ok(value)
    } else {
        Err(input_error(format!("sculpt {name} must be a positive number up to {MAX_COORDINATE:e}, got {value}")))
    }
}

fn point(name: &str, value: Vec3) -> Result<Vec3, JobError> {
    if value.iter().all(|c| c.is_finite() && c.abs() <= MAX_COORDINATE) {
        Ok(value)
    } else {
        Err(input_error(format!("sculpt {name} must be finite coordinates up to {MAX_COORDINATE:e}, got {value:?}")))
    }
}

fn settings_of(job: &SculptJob) -> Result<Settings, JobError> {
    let direction = match &job.direction {
        DirectionJob::Word(word) if word == "normal" => Direction::Normal,
        DirectionJob::Word(word) if word == "area_normal" => Direction::AreaNormal,
        DirectionJob::Word(word) => {
            return Err(input_error(format!("sculpt direction must be \"normal\", \"area_normal\" or a vector, got \"{word}\"")))
        }
        DirectionJob::Vector(vector) => Direction::Vector(point("direction", *vector)?),
    };
    if !job.strength.is_finite() {
        return Err(input_error(format!("sculpt strength must be a finite number, got {}", job.strength)));
    }
    let mask = job
        .mask
        .as_ref()
        .map(|region| {
            let center = point("mask center", region.center)?;
            Ok::<Sphere, JobError>(Sphere { center, radius: positive("mask radius", region.radius)? })
        })
        .transpose()?;
    Ok(Settings {
        brush: job.brush,
        radius: positive("radius", job.radius)?,
        strength: job.strength,
        falloff: job.falloff,
        direction,
        taubin: job.taubin,
        max_height: job.max_height.map(|height| positive("maxHeight", height)).transpose()?,
        mask,
        plane_point: job.plane_point.map(|p| point("planePoint", p)).transpose()?,
    })
}

/// Run a `sculpt` job on the mesh; `tick` gets the share done.
pub fn run_sculpt(positions: &[f64], triangles: &[u32], params: Value, tick: &mut dyn FnMut(f64)) -> Result<Done, JobError> {
    let job: SculptJob = serde_json::from_value(params).map_err(|error| input_error(format!("sculpt params: {error}")))?;
    if positions.iter().any(|c| c.abs() > MAX_COORDINATE) {
        return Err(input_error(format!(
            "sculpt needs coordinates below {MAX_COORDINATE:e}: the sums of the brushes and of the volume would overflow"
        )));
    }
    let settings = settings_of(&job)?;
    let params = Params {
        settings,
        stamps: job.stamps.iter().map(|&stamp| point("stamp", stamp)).collect::<Result<_, _>>()?,
        symmetry: job.symmetry,
        refine_edge: job.refine_edge.map(|edge| positive("refineEdge", edge)).transpose()?,
        max_triangles: job.max_triangles.unwrap_or(MAX_TRIANGLES),
    };
    match sculpt(positions, triangles, &params, tick) {
        Sculpted::OffSurface(index) => Err(JobError { code: "SCULPT_OFF_SURFACE", message: index.to_string() }),
        Sculpted::TooLarge(count) => Err(JobError {
            code: "SCULPT_TOO_LARGE",
            message: format!(
                "the refined surface passed {count} triangles (limit {}): use a longer refineEdge, or sculpt a smaller region",
                params.max_triangles
            ),
        }),
        Sculpted::Done { positions, indices, report } => {
            let numbers = [report.max_displacement, report.displaced_volume, report.symmetry_error.unwrap_or(0.0)];
            if !positions.iter().all(|c| c.is_finite()) || !numbers.iter().all(|n| n.is_finite()) {
                return Err(input_error("sculpt: the result is not finite (the strokes overflow); the TypeScript engine answers it"));
            }
            let report = serde_json::to_value(report).map_err(|error| input_error(error.to_string()))?;
            Ok((positions, indices, report))
        }
    }
}
