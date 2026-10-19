//! `manifest.json` of a cloud asset (TECHNICAL_SPEC §3 `CloudManifest`, §3.1): written once by the importer, canonical JSON (sorted
//! keys, compact), read by the host and by the compute ops.

use crate::cloud::{Bounds, Crs, Format, ScanInfo, SourceInfo, Vec3, Warning};
use crate::read::ImportOptions;
use serde::{Deserialize, Serialize};

/// Version of the asset layout; part of the importer version, so a layout change gives new asset keys.
pub const ASSET_VERSION: u32 = 1;

/// `llull-cloud@<crate version>/asset-<layout>`: the importer version hashed into the asset key.
pub fn importer_version() -> String {
    format!("llull-cloud@{}/asset-{ASSET_VERSION}", env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OctreeInfo {
    /// Deepest level + 1.
    pub depth: u32,
    /// Bits per axis of the root cube in codes (edge = 2^bits).
    pub root_bits: u32,
    /// Global code of the root cube's low corner.
    pub root_min: [i64; 3],
    /// Point spacing of the root sampling grid in metres (largest axis); level l has rootSpacing / 2^l.
    pub root_spacing: f64,
    pub max_points_per_node: u32,
    pub node_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub asset_version: u32,
    pub asset_key: String,
    pub source_sha256: String,
    pub source_name: String,
    pub format: Format,
    pub importer_version: String,
    pub import_options: ImportOptions,
    pub unit: String,
    pub point_count: u64,
    /// Records without a position dropped at import (E57 invalid states).
    pub dropped: u64,
    pub scans: Vec<ScanInfo>,
    /// Recomputed from the decoded points (never copied from a header).
    pub bounds: Bounds,
    pub centroid: Vec3,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_bounds: Option<Bounds>,
    /// Coordinate step of the stored codes per axis (metres) and the offset: x = code·quantum + offset.
    pub quantum: Vec3,
    pub offset: Vec3,
    /// Attribute columns in `nodes.bin` order (after positions and record indices).
    pub attributes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crs: Option<Crs>,
    pub octree: OctreeInfo,
    pub source: SourceInfo,
    pub warnings: Vec<Warning>,
}

impl Manifest {
    /// Canonical JSON: keys sorted (serde_json's map is ordered), no whitespace.
    pub fn canonical_json(&self) -> String {
        let value = serde_json::to_value(self).unwrap_or(serde_json::Value::Null);
        value.to_string()
    }

    /// Bytes per point in a node block: 3 × u32 offsets + u32 record index + attributes.
    pub fn point_stride(&self) -> usize {
        16 + crate::cloud::attribute_stride(&self.attributes)
    }
}
