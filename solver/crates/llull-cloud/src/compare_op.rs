//! The `deviation` and `clash` ops of `llull-compute cloud op` with their `device` (RS-4, TECHNICAL_SPEC §2.A M7):
//!
//! - `deviation`, device "gpu": the numbers are the Rust-CPU statistics as always; the GPU adds a picture (per-point nearest entity and
//!   signed distance in f32) summarised as quick statistics, with ε_gpu and the measured largest |d_gpu − d_cpu|; `deterministic: false`.
//! - `clash`, device "gpu": the GPU drops the points farther than reach + ε_gpu from an entity; the survivors are re-evaluated in f64 on
//!   the CPU, so statuses, clusters and gaps equal the CPU-only result (`deterministic: true`).
//!
//! Without the `gpu` feature or an adapter the CPU twin answers and a `SCN_GPU_FALLBACK` warning says why.

use crate::cloud::Vec3;
use crate::compare::{clash_candidates, deviation, ClashSettings, DeviationSettings};
use crate::distance::{Entity, EntitySpec};
use crate::error::{CloudError, CloudResult};
use crate::ops::{optional, param, PlacedCloud, Region};
use serde_json::{json, Value};

/// Runs `deviation` or `clash` on one cloud; GPU fallbacks are pushed to `warnings` as (code, message).
pub fn run(kind: &str, cloud: &PlacedCloud, p: &Value, max_points: usize, warnings: &mut Vec<(String, String)>) -> CloudResult<Value> {
    let specs: Vec<EntitySpec> = param(p, "entities")?;
    let entities: Vec<Entity> = specs.iter().map(Entity::prepare).collect();
    if entities.is_empty() || entities.iter().any(|e| !e.low.iter().all(|v| v.is_finite())) {
        return Err(CloudError::input("params.entities needs at least one entity with a primitive"));
    }
    let device: String = optional(p, "device", "cpu".to_string())?;
    let reach: f64 = if kind == "deviation" {
        param(p, "maxDistance")?
    } else {
        let clearance: f64 = param(p, "clearance")?;
        clearance.max(optional(p, "searchDistance", 1.0)?)
    };
    let (mut low, mut high) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for e in &entities {
        for a in 0..3 {
            low[a] = low[a].min(e.low[a] - reach);
            high[a] = high[a].max(e.high[a] + reach);
        }
    }
    let points = cloud.points(&Region::Box { min: low, max: high }, max_points)?;
    if kind == "deviation" {
        let settings = DeviationSettings {
            max_distance: reach,
            threshold: param(p, "threshold")?,
            signed: optional(p, "signed", true)?,
            bins: optional(p, "histogramBins", 20)?,
        };
        let stats = deviation(&points, &entities, &settings);
        let mut result = json!({ "entities": stats, "pointsInRange": points.len() });
        if device == "gpu" {
            match gpu_picture(&points, &specs, &entities, reach) {
                Ok(picture) => {
                    result["gpu"] = picture;
                    result["device"] = json!("gpu");
                    result["deterministic"] = json!(false);
                }
                Err(reason) => warnings.push(("SCN_GPU_FALLBACK".into(), format!("deviation picture not drawn on the GPU ({reason})"))),
            }
        }
        return Ok(result);
    }
    let settings = ClashSettings {
        clearance: param(p, "clearance")?,
        min_points: optional(p, "minPointsInVolume", 10)?,
        search_distance: optional(p, "searchDistance", 1.0)?,
    };
    let exclude: Vec<Option<f64>> = optional(p, "exclude", vec![None; entities.len()])?;
    let mut gpu_block = Value::Null;
    let candidates = if device == "gpu" {
        match gpu_prune(&points, &specs, reach) {
            Ok((kept, block)) => {
                gpu_block = block;
                Some(kept)
            }
            Err(reason) => {
                warnings.push(("SCN_GPU_FALLBACK".into(), format!("clash prune not run on the GPU ({reason}); CPU only")));
                None
            }
        }
    } else {
        None
    };
    let (results, spacing) = clash_candidates(&points, &entities, &exclude, &settings, candidates.as_deref());
    let mut result = json!({ "results": results, "spacing": spacing, "samplingBound": spacing / 2.0, "pointsInRange": points.len() });
    if !gpu_block.is_null() {
        result["gpu"] = gpu_block;
        result["device"] = json!("gpu");
    }
    Ok(result)
}

#[cfg(feature = "gpu")]
fn gpu_picture(points: &[Vec3], specs: &[EntitySpec], entities: &[Entity], reach: f64) -> Result<Value, String> {
    let gpu = crate::gpu::nearest(points, specs, reach)?;
    let cpu = crate::compare::assignments(points, entities, reach);
    let (mut max_difference, mut mismatches) = (0.0f64, 0usize);
    let mut quick: Vec<(u64, f64, f64, f64)> = vec![(0, f64::INFINITY, f64::NEG_INFINITY, 0.0); entities.len()];
    for (g, c) in gpu.nearest.iter().zip(&cpu) {
        match (g, c) {
            (Some((ge, gd)), Some((ce, cd))) if ge == ce => max_difference = max_difference.max((gd - cd).abs()),
            (None, None) => {}
            _ => mismatches += 1,
        }
        if let Some((e, d)) = g {
            let q = &mut quick[*e];
            q.0 += 1;
            q.1 = q.1.min(*d);
            q.2 = q.2.max(*d);
            q.3 += d;
        }
    }
    let stats: Vec<Value> = entities
        .iter()
        .zip(&quick)
        .map(|(e, q)| json!({ "id": e.id, "points": q.0, "min": (q.0 > 0).then_some(q.1), "max": (q.0 > 0).then_some(q.2), "mean": (q.0 > 0).then(|| q.3 / q.0 as f64) }))
        .collect();
    Ok(json!({
        "adapter": gpu.adapter,
        "precision": "f32 relative to the entities' centre",
        "deterministic": false,
        "epsilon": gpu.epsilon,
        "maxDifferenceFromCpu": max_difference,
        "assignmentMismatches": mismatches,
        "quickStats": stats,
    }))
}

#[cfg(not(feature = "gpu"))]
fn gpu_picture(_: &[Vec3], _: &[EntitySpec], _: &[Entity], _: f64) -> Result<Value, String> {
    Err("llull-compute built without the gpu feature".into())
}

#[cfg(feature = "gpu")]
fn gpu_prune(points: &[Vec3], specs: &[EntitySpec], reach: f64) -> Result<(Vec<Vec<usize>>, Value), String> {
    let (kept, adapter, epsilon) = crate::gpu::prune(points, specs, reach)?;
    let counts: Vec<usize> = kept.iter().map(Vec::len).collect();
    Ok((kept, json!({ "adapter": adapter, "epsilon": epsilon, "keptPoints": counts, "points": points.len(), "deterministic": true })))
}

#[cfg(not(feature = "gpu"))]
fn gpu_prune(_: &[Vec3], _: &[EntitySpec], _: f64) -> Result<(Vec<Vec<usize>>, Value), String> {
    Err("llull-compute built without the gpu feature".into())
}
