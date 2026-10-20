//! Octree index (TECHNICAL_SPEC §5.3, Potree-2 style) built in integer code space, so it is exact and deterministic.
//!
//! - Every point has a global integer code `c` per axis on the asset grid (x = c·quantum + offset): the LAS record integers, or
//!   `round(x / quantum)` for float sources (quantum 1e-7 m, ×10 until the extent fits in 2^30 codes).
//! - The root is the cube `[rootMin, rootMin + E)` with E the next power of two above the extent in codes; a node at level l with key
//!   (ix, iy, iz) covers `rootMin + i·(E >> l)`; its origin is on the source grid, so stored offsets `c − origin` are exact u32.
//! - Points are sorted by their full-depth Morton code, then record index (canonical order, AF-13). A node keeps at most
//!   `maxPointsPerNode` points: when it holds more, it keeps the first point of every occupied sampling cell (128 per axis, i.e. the
//!   octree cell 7 levels down: contiguous runs in Morton order), thinned evenly when still above the cap, and the rest go to its
//!   children. Leaves keep all their points, so the node sets partition the cloud (VC-SCN-10). No RNG anywhere.

use rayon::prelude::*;

/// Sampling cells per axis of one node (2^7).
pub const SAMPLING_LEVELS: u32 = 7;

/// One node of the built tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub level: u32,
    pub key: [u32; 3],
    /// Point indices (into the cloud arrays) in canonical order.
    pub points: Vec<u32>,
    pub child_mask: u8,
}

/// Interleaves the low `bits` bits of x, y, z (x lowest) into a Morton code.
pub fn morton(c: [u64; 3], bits: u32) -> u128 {
    let mut code = 0u128;
    for bit in 0..bits {
        for (axis, value) in c.iter().enumerate() {
            code |= u128::from((value >> bit) & 1) << (3 * bit + axis as u32);
        }
    }
    code
}

/// The tree over `relative` codes (code − rootMin, each < 2^depth) with record indices for the tie-break; nodes sorted by
/// (level, Morton key), so the children of a node are contiguous at the next level.
pub fn build(relative: &[[u64; 3]], record_index: &[u64], depth: u32, max_points: usize) -> Vec<Node> {
    let mut order: Vec<(u128, u64, u32)> =
        relative.par_iter().zip(record_index.par_iter()).enumerate().map(|(i, (c, r))| (morton(*c, depth), *r, i as u32)).collect();
    order.par_sort_unstable();
    let codes: Vec<u128> = order.iter().map(|o| o.0).collect();
    let indices: Vec<u32> = order.iter().map(|o| o.2).collect();
    let mut nodes = split(&codes, &indices, 0, [0, 0, 0], depth, max_points.max(1));
    nodes.par_sort_unstable_by_key(|n| (n.level, morton([u64::from(n.key[0]), u64::from(n.key[1]), u64::from(n.key[2])], n.level)));
    nodes
}

/// Bits of the Morton code below the cells of `level` (3 per level not yet descended).
fn shift(depth: u32, level: u32) -> u32 {
    3 * (depth - level)
}

fn split(codes: &[u128], indices: &[u32], level: u32, key: [u32; 3], depth: u32, max_points: usize) -> Vec<Node> {
    if codes.len() <= max_points || level >= depth {
        return vec![Node { level, key, points: indices.to_vec(), child_mask: 0 }];
    }
    // Sampling: the first point of each run of equal cell ids (level + 7, capped at full depth).
    let cell_shift = shift(depth, (level + SAMPLING_LEVELS).min(depth));
    let mut sampled = Vec::new();
    let mut keep = vec![false; codes.len()];
    let mut previous: Option<u128> = None;
    for (i, code) in codes.iter().enumerate() {
        let cell = code >> cell_shift;
        if previous != Some(cell) {
            sampled.push(i);
            previous = Some(cell);
        }
    }
    if sampled.len() > max_points {
        let n = sampled.len();
        sampled = (0..max_points).map(|i| sampled[i * n / max_points]).collect();
    }
    for &i in &sampled {
        keep[i] = true;
    }
    let mut remaining_codes = Vec::with_capacity(codes.len() - sampled.len());
    let mut remaining_indices = Vec::with_capacity(codes.len() - sampled.len());
    for i in 0..codes.len() {
        if !keep[i] {
            remaining_codes.push(codes[i]);
            remaining_indices.push(indices[i]);
        }
    }
    // Children: runs of equal octant bits at level + 1 (contiguous in Morton order).
    let child_shift = shift(depth, level + 1);
    let mut runs: Vec<(u8, usize, usize)> = Vec::new();
    let mut start = 0;
    while start < remaining_codes.len() {
        let octant = ((remaining_codes[start] >> child_shift) & 7) as u8;
        let mut end = start;
        while end < remaining_codes.len() && ((remaining_codes[end] >> child_shift) & 7) as u8 == octant {
            end += 1;
        }
        runs.push((octant, start, end));
        start = end;
    }
    let child_mask = runs.iter().fold(0u8, |mask, (octant, _, _)| mask | (1 << octant));
    let mut nodes = vec![Node { level, key, points: sampled.iter().map(|&i| indices[i]).collect(), child_mask }];
    let children: Vec<Vec<Node>> = runs
        .par_iter()
        .map(|&(octant, a, b)| {
            let child_key =
                [key[0] * 2 + u32::from(octant & 1), key[1] * 2 + u32::from((octant >> 1) & 1), key[2] * 2 + u32::from((octant >> 2) & 1)];
            split(&remaining_codes[a..b], &remaining_indices[a..b], level + 1, child_key, depth, max_points)
        })
        .collect();
    for child in children {
        nodes.extend(child);
    }
    nodes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn morton_interleaves_x_lowest() {
        assert_eq!(morton([1, 0, 0], 1), 1);
        assert_eq!(morton([0, 1, 0], 1), 2);
        assert_eq!(morton([0, 0, 1], 1), 4);
        assert_eq!(morton([3, 0, 0], 2), 0b1001);
    }

    #[test]
    fn nodes_partition_the_points_and_respect_the_cap() {
        let relative: Vec<[u64; 3]> = (0..5000u64).map(|i| [(i * 37) % 1024, (i * 101) % 1024, (i * 7) % 1024]).collect();
        let records: Vec<u64> = (0..5000).collect();
        let nodes = build(&relative, &records, 10, 300);
        let mut seen: Vec<u32> = nodes.iter().flat_map(|n| n.points.clone()).collect();
        seen.sort_unstable();
        assert_eq!(seen, (0..5000).collect::<Vec<u32>>());
        assert!(nodes.iter().all(|n| n.points.len() <= 300));
        assert_eq!(nodes[0].level, 0);
        assert_eq!(build(&relative, &records, 10, 300), nodes);
    }
}
