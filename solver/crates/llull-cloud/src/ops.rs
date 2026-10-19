//! `llull-compute cloud op <job-folder>`: the heavy queries behind `PointCloudPort.compute` (TECHNICAL_SPEC §2.A).
//!
//! # `job.json`
//!
//! ```json
//! { "version": 1, "kind": "icp", "clouds": [{ "assetKey": "<hex>", "dir": "/store/<hex>", "toDocument": [16 numbers] }], "params": { … } }
//! ```
//!
//! Every coordinate is metres in the DOCUMENT frame: each cloud's points are mapped by its `toDocument` affine transform before the op,
//! so results need only a unit conversion. `result.json` holds the op's fields plus `device` and `deterministic`. Kinds: `register_targets`
//! (clouds = [fixed, moving]), `icp` ([fixed, moving]), `fit`, `slice`, `extract_pipes` ([cloud]), `deviation`, `clash` ([cloud]).
//! Errors: `SCN_*` codes of the op, `SCN_ASSET_MISSING`, `SCN_QUERY_LIMIT` (a region above `maxPoints`), `NATIVE_JOB_INPUT`.

use crate::cloud::Vec3;
use crate::error::{CloudError, CloudResult};
use crate::job::read_json;
use crate::kdtree::KdTree;
use crate::linalg::{self, Mat4};
use crate::register::{icp, register_targets, IcpMethod, TargetPair};
use crate::store::Asset;
use llull_protocol::{sha256_hex, Output};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpCloud {
    asset_key: String,
    dir: PathBuf,
    to_document: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpJob {
    version: u32,
    kind: String,
    clouds: Vec<OpCloud>,
    #[serde(default)]
    params: Value,
}

/// A region in the document frame (metres).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Region {
    #[default]
    All,
    Box {
        min: Vec3,
        max: Vec3,
    },
    Seed {
        point: Vec3,
        radius: f64,
    },
}

impl Region {
    pub fn contains(&self, p: &Vec3) -> bool {
        match self {
            Region::All => true,
            Region::Box { min, max } => (0..3).all(|a| p[a] >= min[a] && p[a] <= max[a]),
            Region::Seed { point, radius } => linalg::distance(p, point) <= *radius,
        }
    }

    /// Document-frame box around the region (None = unbounded).
    fn bounds(&self) -> Option<(Vec3, Vec3)> {
        match self {
            Region::All => None,
            Region::Box { min, max } => Some((*min, *max)),
            Region::Seed { point, radius } => Some((point.map(|v| v - radius), point.map(|v| v + radius))),
        }
    }
}

/// An opened cloud with its asset → document transform.
pub struct PlacedCloud {
    pub asset: Asset,
    pub to_document: Mat4,
}

/// Default cap on the points an op loads (a larger region is refused with SCN_QUERY_LIMIT).
pub const DEFAULT_OP_MAX_POINTS: usize = 5_000_000;

impl PlacedCloud {
    /// Points of the region in the document frame (metres), canonical order; refused above `max_points`.
    pub fn points(&self, region: &Region, max_points: usize) -> CloudResult<Vec<Vec3>> {
        let inverse = linalg::invert_affine(&self.to_document).ok_or_else(|| CloudError::input("toDocument is not invertible"))?;
        let (low, high) = match region.bounds() {
            None => (self.asset.manifest.bounds.min, self.asset.manifest.bounds.max),
            Some((a, b)) => {
                let mut low = [f64::INFINITY; 3];
                let mut high = [f64::NEG_INFINITY; 3];
                for corner in 0..8 {
                    let c = [
                        if corner & 1 != 0 { b[0] } else { a[0] },
                        if corner & 2 != 0 { b[1] } else { a[1] },
                        if corner & 4 != 0 { b[2] } else { a[2] },
                    ];
                    let p = linalg::apply(&inverse, &c);
                    for k in 0..3 {
                        low[k] = low[k].min(p[k]);
                        high[k] = high[k].max(p[k]);
                    }
                }
                (low, high)
            }
        };
        let raw = self.asset.points_in_box(&low, &high)?;
        let mut out = Vec::new();
        for p in &raw.positions {
            let q = linalg::apply(&self.to_document, p);
            if region.contains(&q) {
                if out.len() >= max_points {
                    return Err(CloudError::new("SCN_QUERY_LIMIT", format!("the region holds more than {max_points} points; narrow it")));
                }
                out.push(q);
            }
        }
        Ok(out)
    }
}

fn mat4(values: &[f64]) -> CloudResult<Mat4> {
    <[f64; 16]>::try_from(values).map_err(|_| CloudError::input("a transform needs 16 numbers"))
}

fn open(clouds: &[OpCloud], count: usize) -> CloudResult<Vec<PlacedCloud>> {
    if clouds.len() != count {
        return Err(CloudError::input(format!("this op takes {count} cloud(s), got {}", clouds.len())));
    }
    clouds.iter().map(|c| Ok(PlacedCloud { asset: Asset::open(&c.dir, Some(&c.asset_key))?, to_document: mat4(&c.to_document)? })).collect()
}

fn param<T: for<'de> Deserialize<'de>>(params: &Value, name: &str) -> CloudResult<T> {
    serde_json::from_value(params.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| CloudError::input(format!("params.{name}: {e}")))
}

fn optional<T: for<'de> Deserialize<'de>>(params: &Value, name: &str, default: T) -> CloudResult<T> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(_) => param(params, name),
    }
}

fn run_kind(job: &OpJob) -> CloudResult<Value> {
    let p = &job.params;
    let max_points: usize = optional(p, "maxPoints", DEFAULT_OP_MAX_POINTS)?;
    match job.kind.as_str() {
        "register_targets" => {
            let clouds = open(&job.clouds, 2)?;
            let pairs: Vec<TargetPair> = param(p, "targets")?;
            let fixed = KdTree::build(&clouds[0].points(&Region::All, max_points)?);
            let moving = KdTree::build(&clouds[1].points(&Region::All, max_points)?);
            let result = register_targets(&fixed, &moving, &pairs)?;
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        "icp" => {
            let clouds = open(&job.clouds, 2)?;
            let region: Region = optional(p, "region", Region::All)?;
            let initial: Vec<f64> = optional(p, "initial", linalg::IDENTITY.to_vec())?;
            let method: IcpMethod = optional(p, "method", IcpMethod::PointToPoint)?;
            let max_iterations: u32 = optional(p, "maxIterations", 100)?;
            let trim_ratio: f64 = optional(p, "trimRatio", 0.9)?;
            let fixed_points = clouds[0].points(&region, max_points)?;
            let moving = clouds[1].points(&region, max_points)?;
            if fixed_points.len() < 10 || moving.len() < 10 {
                return Err(CloudError::new(
                    "SCN_FIT_TOO_FEW_POINTS",
                    format!("ICP needs points in both clouds ({} fixed, {} moving)", fixed_points.len(), moving.len()),
                ));
            }
            let result = icp(&KdTree::build(&fixed_points), &moving, &mat4(&initial)?, method, max_iterations, trim_ratio);
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        other => Err(CloudError::input(format!("unknown op kind '{other}'"))),
    }
}

/// Runs one op job and writes `result.json`.
pub fn run(folder: &Path, _out: &mut impl Write) -> CloudResult<Vec<Output>> {
    let job: OpJob = read_json(&folder.join("job.json"))?;
    if job.version != 1 {
        return Err(CloudError::input(format!("job version {} is not 1", job.version)));
    }
    let mut result = run_kind(&job)?;
    if let Value::Object(map) = &mut result {
        map.entry("device").or_insert(json!("cpu"));
        map.entry("deterministic").or_insert(json!(true));
    }
    let bytes = result.to_string().into_bytes();
    let path = folder.join("result.json");
    std::fs::write(&path, &bytes).map_err(|error| CloudError::io(&path, &error))?;
    Ok(vec![Output { path: "result.json".to_string(), sha256: sha256_hex(&bytes) }])
}
