//! Reading an asset written by [`crate::asset`]: the node table, node blocks (CRC-checked) and region / nearest queries in the asset
//! frame. Used by the compute ops (`llull-compute cloud op`) and the tests; the Node host has its own reader of the same layout.

use crate::asset::{crc32, RECORD_BYTES};
use crate::cloud::Vec3;
use crate::error::{CloudError, CloudResult};
use crate::manifest::Manifest;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NodeRecord {
    pub level: u32,
    pub key: [u32; 3],
    pub point_count: u32,
    pub child_mask: u32,
    pub byte_offset: u64,
    pub byte_size: u64,
    pub crc: u32,
    pub first_child: u32,
}

/// Points read from an asset: positions in metres (asset frame) and their source record index, in canonical order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Points {
    pub positions: Vec<Vec3>,
    pub record_index: Vec<u32>,
}

/// An opened asset directory.
pub struct Asset {
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub nodes: Vec<NodeRecord>,
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from(u32_at(bytes, at)) | (u64::from(u32_at(bytes, at + 4)) << 32)
}

impl Asset {
    /// Opens `dir` and checks that its manifest names `expected_key` (when given).
    /// @failure missing / unreadable files or another key -> SCN_ASSET_MISSING
    pub fn open(dir: &Path, expected_key: Option<&str>) -> CloudResult<Asset> {
        let missing = |why: String| CloudError::new("SCN_ASSET_MISSING", format!("{}: {why}", dir.display()));
        let text = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| missing(e.to_string()))?;
        let manifest: Manifest = serde_json::from_str(&text).map_err(|e| missing(format!("manifest.json: {e}")))?;
        if let Some(key) = expected_key {
            if manifest.asset_key != key {
                return Err(missing(format!("the manifest names asset {} not {key}", manifest.asset_key)));
            }
        }
        let hierarchy = std::fs::read(dir.join("hierarchy.bin")).map_err(|e| missing(e.to_string()))?;
        if hierarchy.len() % RECORD_BYTES != 0 || hierarchy.len() / RECORD_BYTES != manifest.octree.node_count as usize {
            return Err(missing("hierarchy.bin does not hold one record per node".into()));
        }
        let nodes = hierarchy
            .chunks_exact(RECORD_BYTES)
            .map(|r| NodeRecord {
                level: u32_at(r, 0),
                key: [u32_at(r, 4), u32_at(r, 8), u32_at(r, 12)],
                point_count: u32_at(r, 16),
                child_mask: u32_at(r, 20),
                byte_offset: u64_at(r, 24),
                byte_size: u64_at(r, 32),
                crc: u32_at(r, 40),
                first_child: u32_at(r, 44),
            })
            .collect();
        Ok(Asset { dir: dir.to_path_buf(), manifest, nodes })
    }

    /// Axis-aligned bounds of node `i` in metres (asset frame).
    pub fn node_bounds(&self, i: usize) -> (Vec3, Vec3) {
        let node = &self.nodes[i];
        let m = &self.manifest;
        let edge_bits = m.octree.root_bits - node.level;
        let edge = (1u64 << edge_bits) as f64;
        let low: Vec3 = std::array::from_fn(|a| (m.octree.root_min[a] as f64 + f64::from(node.key[a]) * edge) * m.quantum[a] + m.offset[a]);
        let high: Vec3 = std::array::from_fn(|a| low[a] + edge * m.quantum[a]);
        (low, high)
    }

    /// Positions and record indices of node `i`, CRC-checked.
    /// @failure unreadable block or CRC mismatch -> SCN_ASSET_MISSING
    pub fn read_node(&self, i: usize) -> CloudResult<Points> {
        let node = self.nodes[i];
        let path = self.dir.join("nodes.bin");
        let mut file = File::open(&path).map_err(|e| CloudError::new("SCN_ASSET_MISSING", e.to_string()))?;
        let mut block = vec![0u8; node.byte_size as usize];
        file.seek(SeekFrom::Start(node.byte_offset))
            .and_then(|_| file.read_exact(&mut block))
            .map_err(|e| CloudError::new("SCN_ASSET_MISSING", e.to_string()))?;
        if crc32(&block) != node.crc {
            return Err(CloudError::new("SCN_ASSET_MISSING", format!("node {i} of {} fails its CRC", self.manifest.asset_key)));
        }
        let m = &self.manifest;
        let n = node.point_count as usize;
        let edge_bits = m.octree.root_bits - node.level;
        let origin: [i64; 3] = std::array::from_fn(|a| m.octree.root_min[a] + (i64::from(node.key[a]) << edge_bits));
        let positions = (0..n)
            .map(|p| std::array::from_fn(|a| (origin[a] + i64::from(u32_at(&block, (p * 3 + a) * 4))) as f64 * m.quantum[a] + m.offset[a]))
            .collect();
        let record_index = (0..n).map(|p| u32_at(&block, (n * 3 + p) * 4)).collect();
        Ok(Points { positions, record_index })
    }

    /// Every point whose node box meets the box [low, high] and that lies inside it, in canonical order (node order, then in-node).
    pub fn points_in_box(&self, low: &Vec3, high: &Vec3) -> CloudResult<Points> {
        let mut out = Points::default();
        for i in 0..self.nodes.len() {
            let (a, b) = self.node_bounds(i);
            if (0..3).any(|k| b[k] < low[k] || a[k] > high[k]) {
                continue;
            }
            let node = self.read_node(i)?;
            for (p, r) in node.positions.iter().zip(&node.record_index) {
                if (0..3).all(|k| p[k] >= low[k] && p[k] <= high[k]) {
                    out.positions.push(*p);
                    out.record_index.push(*r);
                }
            }
        }
        Ok(out)
    }

    /// Indices of the children of node `i` (contiguous records from `first_child`).
    pub fn children(&self, i: usize) -> std::ops::Range<usize> {
        let node = &self.nodes[i];
        if node.first_child == u32::MAX {
            return 0..0;
        }
        let start = node.first_child as usize;
        start..start + node.child_mask.count_ones() as usize
    }

    /// Nodes of a point-budget LOD (TECHNICAL_SPEC §5.3) seen from a virtual camera at `centre`: largest projected size first
    /// (node diagonal / distance to its box, infinite when inside; ties by node order), taken while the running point count stays
    /// within `budget`, children queued only after their parent, so no coarser level is skipped. Nodes outside `region` are culled.
    pub fn lod_budget(&self, centre: &Vec3, budget: u64, region: Option<(Vec3, Vec3)>) -> Vec<usize> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        let priority = |i: usize| -> u64 {
            let (a, b) = self.node_bounds(i);
            let diagonal = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2) + (b[2] - a[2]).powi(2)).sqrt();
            let gap: f64 = (0..3).map(|k| (a[k] - centre[k]).max(0.0).max(centre[k] - b[k]).powi(2)).sum::<f64>().sqrt();
            (if gap > 0.0 { diagonal / gap } else { f64::INFINITY }).to_bits()
        };
        let inside = |i: usize| -> bool {
            region.is_none_or(|(low, high)| {
                let (a, b) = self.node_bounds(i);
                (0..3).all(|k| b[k] >= low[k] && a[k] <= high[k])
            })
        };
        let mut selected = Vec::new();
        let mut total = 0u64;
        let mut heap = BinaryHeap::new();
        if !self.nodes.is_empty() && inside(0) {
            heap.push((priority(0), Reverse(0usize)));
        }
        while let Some((_, Reverse(i))) = heap.pop() {
            let count = u64::from(self.nodes[i].point_count);
            if total + count > budget {
                break;
            }
            total += count;
            selected.push(i);
            for child in self.children(i) {
                if inside(child) {
                    heap.push((priority(child), Reverse(child)));
                }
            }
        }
        selected.sort_unstable();
        selected
    }

    /// All points (canonical order).
    pub fn all_points(&self) -> CloudResult<Points> {
        let b = &self.manifest.bounds;
        self.points_in_box(&b.min, &b.max)
    }

    /// The nearest point to `p` within `max_distance`: (record index, position, distance, second-nearest distance); ties by node
    /// order then in-node order (the canonical order).
    pub fn nearest(&self, p: &Vec3, max_distance: f64) -> CloudResult<Option<(u32, Vec3, f64, f64)>> {
        let mut best: Option<(u32, Vec3, f64)> = None;
        let mut second = f64::INFINITY;
        for i in 0..self.nodes.len() {
            let (a, b) = self.node_bounds(i);
            let gap: f64 = (0..3).map(|k| (a[k] - p[k]).max(0.0).max(p[k] - b[k]).powi(2)).sum::<f64>().sqrt();
            if gap > max_distance || gap > second {
                continue;
            }
            let node = self.read_node(i)?;
            for (q, r) in node.positions.iter().zip(&node.record_index) {
                let d = ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2) + (q[2] - p[2]).powi(2)).sqrt();
                match best {
                    Some((_, _, bd)) if d >= bd => second = second.min(d),
                    _ => {
                        if let Some((_, _, bd)) = best {
                            second = second.min(bd);
                        }
                        best = Some((*r, *q, d));
                    }
                }
            }
        }
        Ok(best.filter(|b| b.2 <= max_distance).map(|(r, q, d)| (r, q, d, second)))
    }
}
