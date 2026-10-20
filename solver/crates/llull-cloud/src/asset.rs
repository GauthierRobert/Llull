//! The cloud asset on disk (TECHNICAL_SPEC §3.1): `manifest.json`, `hierarchy.bin`, `nodes.bin`, `source.sha256`.
//!
//! `hierarchy.bin`: one 48-byte little-endian record per node in (level, Morton key) order: u32 level, u32 ix, u32 iy, u32 iz,
//! u32 pointCount, u32 childMask, u64 byteOffset, u64 byteSize, u32 crc32 (IEEE, of the block), u32 firstChild (index of the
//! first child record, u32::MAX for a leaf; the children of a node are contiguous).
//!
//! `nodes.bin`: the node blocks in the same order. A block holds, column after column: pointCount × 3 u32 offsets from the node origin
//! (x y z interleaved), pointCount × u32 record index, then each attribute column of the manifest (`intensity` u16, `rgb` 3 × u8,
//! `classification` / `returnNumber` / `numberOfReturns` u8, `gpsTime` f64, `normal` 3 × f32). Position = (origin + offset)·quantum + offset.

use crate::cloud::{Attributes, Bounds, RawCloud, Vec3};
use crate::error::{CloudError, CloudResult};
use crate::manifest::{importer_version, Manifest, OctreeInfo, ASSET_VERSION};
use crate::octree::{self, Node};
use crate::read::ImportOptions;
use std::fs;
use std::path::Path;

pub const RECORD_BYTES: usize = 48;
const NO_CHILD: u32 = u32::MAX;

/// CRC-32 (IEEE 802.3, reflected 0xEDB88320), the node block checksum.
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *entry = c;
    }
    let mut crc = !0u32;
    for &b in bytes {
        crc = table[((crc ^ u32::from(b)) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// Quantum and offset of the asset codes: the source grid when there is one, else 1e-7 m ×10 until the extent fits in 2^30 codes.
fn asset_grid(cloud: &RawCloud, bounds: &Bounds) -> (Vec3, Vec3) {
    if let Some(grid) = cloud.grid {
        return (grid.quantum, grid.offset);
    }
    let extent = (0..3).map(|a| bounds.max[a].abs().max(bounds.min[a].abs()).max(bounds.max[a] - bounds.min[a])).fold(0.0, f64::max);
    let mut quantum = 1e-7;
    while extent / quantum >= f64::from(1u32 << 30) {
        quantum *= 10.0;
    }
    ([quantum; 3], [0.0; 3])
}

/// Global integer codes of the cloud on the asset grid.
fn codes(cloud: &RawCloud, quantum: &Vec3, offset: &Vec3) -> Vec<[i64; 3]> {
    match &cloud.codes {
        Some(codes) => codes.clone(),
        None => cloud.positions.iter().map(|p| std::array::from_fn(|a| libm::round((p[a] - offset[a]) / quantum[a]) as i64)).collect(),
    }
}

/// A built asset in memory (written by [`write`]).
pub struct BuiltAsset {
    pub manifest: Manifest,
    pub hierarchy: Vec<u8>,
    pub nodes: Vec<u8>,
}

/// Builds the octree asset of `cloud`.
/// @failure an extent above 2^32 codes on the source grid -> SCN_IMPORT_TOO_LARGE
pub fn build(
    cloud: &RawCloud,
    asset_key: &str,
    source_sha256: &str,
    source_name: &str,
    options: &ImportOptions,
) -> CloudResult<BuiltAsset> {
    let bounds = Bounds::of(&cloud.positions).ok_or_else(|| CloudError::new("SCN_CLOUD_EMPTY", "no point to index"))?;
    let (quantum, offset) = asset_grid(cloud, &bounds);
    let codes = codes(cloud, &quantum, &offset);
    let mut root_min = [i64::MAX; 3];
    let mut root_max = [i64::MIN; 3];
    for c in &codes {
        for a in 0..3 {
            root_min[a] = root_min[a].min(c[a]);
            root_max[a] = root_max[a].max(c[a]);
        }
    }
    let extent = (0..3).map(|a| (root_max[a] - root_min[a]) as u64 + 1).max().unwrap_or(1);
    let root_bits = 64 - (extent - 1).leading_zeros();
    if root_bits > 32 {
        return Err(CloudError::new("SCN_IMPORT_TOO_LARGE", format!("the cloud spans {extent} codes on one axis (limit 2^32)")));
    }
    let relative: Vec<[u64; 3]> = codes.iter().map(|c| std::array::from_fn(|a| (c[a] - root_min[a]) as u64)).collect();
    let max_points = options.max_points_per_node.max(1) as usize;
    let nodes = octree::build(&relative, &cloud.record_index, root_bits, max_points);
    let (hierarchy, blob) = encode(&nodes, &relative, cloud, root_bits);
    let root_edge_m = (0..3).map(|a| (1u64 << root_bits) as f64 * quantum[a]).fold(0.0, f64::max);
    let manifest = Manifest {
        asset_version: ASSET_VERSION,
        asset_key: asset_key.to_string(),
        source_sha256: source_sha256.to_string(),
        source_name: source_name.to_string(),
        format: cloud.format,
        importer_version: importer_version(),
        import_options: options.clone(),
        unit: "m".to_string(),
        point_count: cloud.len() as u64,
        dropped: cloud.dropped,
        scans: cloud.scans.clone(),
        bounds,
        centroid: cloud.centroid().unwrap_or([0.0; 3]),
        header_bounds: cloud.header_bounds,
        quantum,
        offset,
        attributes: cloud.attributes.names(),
        crs: cloud.crs.clone(),
        octree: OctreeInfo {
            depth: nodes.iter().map(|n| n.level + 1).max().unwrap_or(1),
            root_bits,
            root_min,
            root_spacing: root_edge_m / f64::from(1u32 << octree::SAMPLING_LEVELS),
            max_points_per_node: options.max_points_per_node,
            node_count: nodes.len() as u32,
        },
        source: cloud.source.clone(),
        warnings: cloud.warnings.clone(),
    };
    Ok(BuiltAsset { manifest, hierarchy, nodes: blob })
}

fn encode(nodes: &[Node], relative: &[[u64; 3]], cloud: &RawCloud, root_bits: u32) -> (Vec<u8>, Vec<u8>) {
    // First child of each node: the children of node n are the contiguous records at level + 1 whose key / 2 is n's key.
    let mut position = std::collections::HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        position.insert((n.level, n.key), i as u32);
    }
    let mut hierarchy = Vec::with_capacity(nodes.len() * RECORD_BYTES);
    let mut blob = Vec::new();
    for node in nodes {
        let edge_bits = root_bits - node.level;
        let origin: [u64; 3] = std::array::from_fn(|a| u64::from(node.key[a]) << edge_bits);
        let start = blob.len();
        for &i in &node.points {
            for a in 0..3 {
                blob.extend_from_slice(&((relative[i as usize][a] - origin[a]) as u32).to_le_bytes());
            }
        }
        for &i in &node.points {
            blob.extend_from_slice(&(cloud.record_index[i as usize] as u32).to_le_bytes());
        }
        write_attributes(&mut blob, &cloud.attributes, &node.points);
        let block = &blob[start..];
        let first_child = (0..8u32)
            .find(|o| node.child_mask & (1 << o) != 0)
            .and_then(|o| {
                position
                    .get(&(node.level + 1, [node.key[0] * 2 + (o & 1), node.key[1] * 2 + ((o >> 1) & 1), node.key[2] * 2 + ((o >> 2) & 1)]))
            })
            .copied()
            .unwrap_or(NO_CHILD);
        for value in [node.level, node.key[0], node.key[1], node.key[2], node.points.len() as u32, u32::from(node.child_mask)] {
            hierarchy.extend_from_slice(&value.to_le_bytes());
        }
        hierarchy.extend_from_slice(&(start as u64).to_le_bytes());
        hierarchy.extend_from_slice(&(block.len() as u64).to_le_bytes());
        hierarchy.extend_from_slice(&crc32(block).to_le_bytes());
        hierarchy.extend_from_slice(&first_child.to_le_bytes());
    }
    (hierarchy, blob)
}

fn write_attributes(blob: &mut Vec<u8>, attributes: &Attributes, points: &[u32]) {
    let at = |i: &u32| *i as usize;
    if let Some(v) = &attributes.intensity {
        points.iter().for_each(|i| blob.extend_from_slice(&v[at(i)].to_le_bytes()));
    }
    if let Some(v) = &attributes.rgb {
        points.iter().for_each(|i| blob.extend_from_slice(&v[at(i)]));
    }
    for column in [&attributes.classification, &attributes.return_number, &attributes.number_of_returns].into_iter().flatten() {
        points.iter().for_each(|i| blob.push(column[at(i)]));
    }
    if let Some(v) = &attributes.gps_time {
        points.iter().for_each(|i| blob.extend_from_slice(&v[at(i)].to_le_bytes()));
    }
    if let Some(v) = &attributes.normal {
        points.iter().for_each(|i| v[at(i)].iter().for_each(|c| blob.extend_from_slice(&c.to_le_bytes())));
    }
}

/// Writes the asset files into `dir` (created; the host renames it into the store).
pub fn write(asset: &BuiltAsset, dir: &Path) -> CloudResult<Vec<llull_protocol::Output>> {
    fs::create_dir_all(dir).map_err(|error| CloudError::io(dir, &error))?;
    let files: [(&str, Vec<u8>); 4] = [
        ("manifest.json", asset.manifest.canonical_json().into_bytes()),
        ("hierarchy.bin", asset.hierarchy.clone()),
        ("nodes.bin", asset.nodes.clone()),
        ("source.sha256", asset.manifest.source_sha256.clone().into_bytes()),
    ];
    let mut outputs = Vec::new();
    for (name, bytes) in files {
        let path = dir.join(name);
        fs::write(&path, &bytes).map_err(|error| CloudError::io(&path, &error))?;
        outputs.push(llull_protocol::Output { path: name.to_string(), sha256: llull_protocol::sha256_hex(&bytes) });
    }
    Ok(outputs)
}

#[cfg(test)]
mod tests {
    use super::crc32;

    #[test]
    fn crc32_matches_the_ieee_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }
}
