//! A decoded cloud in memory: what every reader produces and the octree builder consumes (TECHNICAL_SPEC §3).

use serde::{Deserialize, Serialize};

pub type Vec3 = [f64; 3];

/// Source format (`CloudFormat` of the TypeScript model, plus `csv`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    E57,
    Las,
    Laz,
    Xyz,
    Pts,
    Csv,
}

/// Point attributes kept in the asset, in their column order in `nodes.bin`.
pub const ATTRIBUTE_ORDER: [&str; 7] = ["intensity", "rgb", "classification", "returnNumber", "numberOfReturns", "gpsTime", "normal"];

/// Optional per-point columns (all present columns have one value per point).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Attributes {
    pub intensity: Option<Vec<u16>>,
    pub rgb: Option<Vec<[u8; 3]>>,
    pub classification: Option<Vec<u8>>,
    pub return_number: Option<Vec<u8>>,
    pub number_of_returns: Option<Vec<u8>>,
    pub gps_time: Option<Vec<f64>>,
    pub normal: Option<Vec<[f32; 3]>>,
}

impl Attributes {
    /// Names of the present columns in [`ATTRIBUTE_ORDER`].
    pub fn names(&self) -> Vec<String> {
        let present = [
            self.intensity.is_some(),
            self.rgb.is_some(),
            self.classification.is_some(),
            self.return_number.is_some(),
            self.number_of_returns.is_some(),
            self.gps_time.is_some(),
            self.normal.is_some(),
        ];
        ATTRIBUTE_ORDER.iter().zip(present).filter(|(_, on)| *on).map(|(name, _)| (*name).to_string()).collect()
    }

    /// Bytes per point of the present columns.
    pub fn stride(&self) -> usize {
        attribute_stride(&self.names())
    }
}

/// Bytes per point of the named columns (`nodes.bin` layout).
pub fn attribute_stride(names: &[String]) -> usize {
    names
        .iter()
        .map(|name| match name.as_str() {
            "intensity" => 2,
            "rgb" => 3,
            "gpsTime" => 8,
            "normal" => 12,
            _ => 1,
        })
        .sum()
}

/// One E57 `data3D` (or the single scan of a LAS / ASCII file).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub guid: Option<String>,
    pub name: Option<String>,
    /// Points kept (invalid records dropped).
    pub point_count: u64,
    /// Records in the source, kept or not.
    pub record_count: u64,
    pub pose: Pose,
    /// Pose translation in the file frame when the scan has a pose (station position).
    pub station_origin: Option<Vec3>,
    /// Prototype field names of the source (E57) or the LAS dimensions.
    pub fields: Vec<String>,
}

/// Rigid pose: p_file = R(q)·p_local + t, q = (w, x, y, z) unit quaternion.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pose {
    pub rotation_wxyz: [f64; 4],
    pub translation: Vec3,
}

impl Pose {
    pub const IDENTITY: Pose = Pose { rotation_wxyz: [1.0, 0.0, 0.0, 0.0], translation: [0.0; 3] };

    pub fn is_identity(&self) -> bool {
        *self == Pose::IDENTITY
    }

    /// Row-major rotation matrix of the quaternion (assumed unit).
    pub fn matrix(&self) -> [[f64; 3]; 3] {
        let [w, x, y, z] = self.rotation_wxyz;
        [
            [w * w + x * x - y * y - z * z, 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
            [2.0 * (x * y + w * z), w * w - x * x + y * y - z * z, 2.0 * (y * z - w * x)],
            [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), w * w - x * x - y * y + z * z],
        ]
    }

    pub fn apply(&self, m: &[[f64; 3]; 3], p: &Vec3) -> Vec3 {
        let t = self.translation;
        [
            m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + t[0],
            m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + t[1],
            m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + t[2],
        ]
    }
}

/// The integer grid of a source whose coordinates are integer coded (LAS / LAZ): x = code·quantum + offset.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceGrid {
    pub quantum: Vec3,
    pub offset: Vec3,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Warning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Crs {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wkt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epsg: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub min: Vec3,
    pub max: Vec3,
}

impl Bounds {
    /// Bounds of `points` (None when empty).
    pub fn of(points: &[Vec3]) -> Option<Bounds> {
        let first = points.first()?;
        let mut bounds = Bounds { min: *first, max: *first };
        for p in points {
            for (axis, value) in p.iter().enumerate() {
                bounds.min[axis] = bounds.min[axis].min(*value);
                bounds.max[axis] = bounds.max[axis].max(*value);
            }
        }
        Some(bounds)
    }
}

/// Header inventory of the source file (VC-SCN-01, 06); fields that do not apply to a format are absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub version_major: Option<u32>,
    pub version_minor: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_format: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_record_length: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlr_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evlr_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<Vec3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<Vec3>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generating_software: Option<String>,
}

/// A decoded cloud: positions in metres in the file frame (station poses applied unless the import said otherwise).
#[derive(Debug, Clone, PartialEq)]
pub struct RawCloud {
    pub format: Format,
    pub source: SourceInfo,
    pub positions: Vec<Vec3>,
    /// Exact integer codes on `grid` (LAS / LAZ), one per position.
    pub codes: Option<Vec<[i64; 3]>>,
    pub grid: Option<SourceGrid>,
    /// Record index of each kept point in the source (all scans counted in order, dropped records included).
    pub record_index: Vec<u64>,
    pub attributes: Attributes,
    pub scans: Vec<ScanInfo>,
    pub header_bounds: Option<Bounds>,
    pub crs: Option<Crs>,
    pub warnings: Vec<Warning>,
    /// Records dropped because they had no position (E57 invalid state 1 or 2).
    pub dropped: u64,
}

impl RawCloud {
    pub fn len(&self) -> usize {
        self.positions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    pub fn centroid(&self) -> Option<Vec3> {
        if self.positions.is_empty() {
            return None;
        }
        let mut sum = [0.0; 3];
        for p in &self.positions {
            for (total, value) in sum.iter_mut().zip(p) {
                *total += value;
            }
        }
        let n = self.positions.len() as f64;
        Some([sum[0] / n, sum[1] / n, sum[2] / n])
    }
}
