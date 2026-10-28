//! Mesh repair modes of increasing intrusiveness (twin of `repair.ts`, 07 MSH FR-MSH-05): weld, clean, orient, stitch, close_holes, plus the removal of small
//! shells. Every step reports what it changed. Exact doubles, deterministic (lowest index wins every tie). Edges are keyed `low * vertexCount + high` as in the
//! TypeScript code, held in `u64`; the sums run in the TypeScript order (faces ascending, the shell's breadth-first order for the volume of `orient`).

use crate::analyze::shell_volumes;
use crate::geom::{diagonal, dist, length, normal_of};
use crate::hole_fair::Fairing;
use crate::hole_fill::{fill_holes, FillOptions, Select};
use crate::topology::{build_topology, NO_SHELL};
use crate::weld::weld;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Weld,
    Clean,
    Orient,
    Stitch,
    CloseHoles,
}

/// Remove shells with at most `max_faces` faces or (closed shells) |volume| at most `max_volume`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmallRule {
    pub max_faces: Option<f64>,
    pub max_volume: Option<f64>,
}

pub struct RepairParams {
    pub mode: Mode,
    pub weld_tolerance: f64,
    pub max_gap: f64,
    pub small: Option<SmallRule>,
    pub max_boundary_edges: f64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub welded: usize,
    pub duplicates_removed: usize,
    pub degenerate_removed: usize,
    pub flipped: usize,
    pub stitched: usize,
    pub holes_filled: usize,
    pub components_removed: usize,
    pub faces_removed_with_components: usize,
}

pub struct Repaired {
    pub positions: Vec<f64>,
    pub triangles: Vec<u32>,
    pub changes: Changes,
    pub notes: Vec<String>,
    pub skipped_holes: usize,
}

/// First-use canonical renumbering; unreferenced vertices disappear.
fn compact(positions: &[f64], triangles: &[u32]) -> (Vec<f64>, Vec<u32>) {
    let mut remap = vec![u32::MAX; positions.len() / 3];
    let mut out = Vec::new();
    let indices = triangles
        .iter()
        .map(|&v| {
            if remap[v as usize] == u32::MAX {
                remap[v as usize] = (out.len() / 3) as u32;
                out.extend_from_slice(&positions[v as usize * 3..v as usize * 3 + 3]);
            }
            remap[v as usize]
        })
        .collect();
    (out, indices)
}

struct Cleaned {
    triangles: Vec<u32>,
    degenerate: usize,
    duplicates: usize,
}

/// Remove faces with a repeated vertex or area at most `area_floor`, and (with `drop_duplicates`) later copies of a face with the same vertex set.
fn clean_faces(positions: &[f64], triangles: &[u32], area_floor: f64, drop_duplicates: bool) -> Cleaned {
    let corner = |v: u32| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]];
    // the areas are independent: computed in parallel, consumed in face order
    let areas: Vec<f64> = triangles
        .par_chunks_exact(3)
        .map(|t| {
            if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                0.0
            } else {
                length(normal_of(corner(t[0]), corner(t[1]), corner(t[2]))) / 2.0
            }
        })
        .collect();
    let mut kept = Vec::with_capacity(triangles.len());
    let mut seen: HashSet<[u32; 3]> = HashSet::new();
    let (mut degenerate, mut duplicates) = (0, 0);
    for (f, t) in triangles.chunks_exact(3).enumerate() {
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] || areas[f] <= area_floor {
            degenerate += 1;
            continue;
        }
        let mut key = [t[0], t[1], t[2]];
        key.sort_unstable();
        if drop_duplicates && seen.contains(&key) {
            duplicates += 1;
            continue;
        }
        seen.insert(key);
        kept.extend_from_slice(t);
    }
    Cleaned { triangles: kept, degenerate, duplicates }
}

fn edge_key(a: u32, b: u32, vertex_count: usize) -> u64 {
    u64::from(a.min(b)) * vertex_count as u64 + u64::from(a.max(b))
}

/// Make every shell's winding consistent (breadth-first from its lowest face), then outward when the shell is closed. Returns the faces flipped.
fn orient_faces(positions: &[f64], triangles: &mut [u32]) -> usize {
    let face_count = triangles.len() / 3;
    let vertex_count = positions.len() / 3;
    // every corner use as (edge key, slot = face * 3 + k); sorted, a group is the list of uses of one edge in face order, as the TypeScript map keeps them
    let mut uses: Vec<(u64, u32)> = (0..face_count * 3)
        .map(|slot| {
            let (f, k) = (slot / 3, slot % 3);
            (edge_key(triangles[f * 3 + k], triangles[f * 3 + (k + 1) % 3], vertex_count), slot as u32)
        })
        .collect();
    uses.par_sort_unstable();
    let mut group_of_slot = vec![0u32; face_count * 3];
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut start = 0;
    while start < uses.len() {
        let end = start + uses[start..].iter().take_while(|u| u.0 == uses[start].0).count();
        for u in &uses[start..end] {
            group_of_slot[u.1 as usize] = groups.len() as u32;
        }
        groups.push((start, end));
        start = end;
    }
    let forward = |slot: u32| {
        let (f, k) = (slot as usize / 3, slot as usize % 3);
        triangles[f * 3 + k] < triangles[f * 3 + (k + 1) % 3]
    };
    // -1 = not reached, 0 = keep, 1 = flip
    let mut flipped = vec![-1i8; face_count];
    let mut components: Vec<Vec<u32>> = Vec::new();
    for seed in 0..face_count {
        if flipped[seed] >= 0 {
            continue;
        }
        let mut component = vec![seed as u32];
        flipped[seed] = 0;
        let mut head = 0;
        while head < component.len() {
            let f = component[head] as usize;
            head += 1;
            for k in 0..3 {
                let slot = (f * 3 + k) as u32;
                let (from, to) = (slot as usize, f * 3 + (k + 1) % 3);
                let group = groups[group_of_slot[slot as usize] as usize];
                if group.1 - group.0 != 2 {
                    continue;
                }
                let effective = (triangles[from] < triangles[to]) != (flipped[f] == 1);
                for u in &uses[group.0..group.1] {
                    let other = u.1 as usize / 3;
                    if other == f || flipped[other] >= 0 {
                        continue;
                    }
                    flipped[other] = i8::from(forward(u.1) == effective);
                    component.push(other as u32);
                }
            }
        }
        components.push(component);
    }
    for component in &components {
        let closed = component.iter().all(|&f| {
            (0..3).all(|k| groups[group_of_slot[f as usize * 3 + k] as usize].1 - groups[group_of_slot[f as usize * 3 + k] as usize].0 == 2)
        });
        if !closed {
            continue;
        }
        let mut volume = 0.0;
        for &f in component {
            let f = f as usize;
            let mut corner = [triangles[f * 3], triangles[f * 3 + 1], triangles[f * 3 + 2]];
            if flipped[f] == 1 {
                corner.swap(1, 2);
            }
            let [a, b, c] = corner.map(|v| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]]);
            volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
        }
        if volume < 0.0 {
            for &f in component {
                flipped[f as usize] = if flipped[f as usize] == 1 { 0 } else { 1 };
            }
        }
    }
    let mut count = 0;
    for (f, &state) in flipped.iter().enumerate() {
        if state == 1 {
            triangles.swap(f * 3 + 1, f * 3 + 2);
            count += 1;
        }
    }
    count
}

struct Stitched {
    triangles: Vec<u32>,
    merged: usize,
    reverted: bool,
}

/// A cell index of the stitch grid as a hash key: the bits of the floor (a double, because `floor(x / gap)` is unbounded); -0 is 0 as in its text form.
fn cell_key(cell: [f64; 3]) -> [u64; 3] {
    cell.map(|c| (c + 0.0).to_bits())
}

/// Merge boundary vertices closer than `max_gap` (lowest index wins) when that does not create non-manifold edges or more boundary edges.
fn stitch_vertices(positions: &[f64], triangles: &[u32], max_gap: f64) -> Stitched {
    let vertex_count = positions.len() / 3;
    let topology = build_topology(vertex_count, triangles);
    let mut on_boundary = vec![false; vertex_count];
    for &(a, b) in &topology.boundary_edges {
        on_boundary[a as usize] = true;
        on_boundary[b as usize] = true;
    }
    let cell_size = if max_gap > 1e-300 { max_gap } else { 1e-300 };
    let mut keys: Vec<u64> =
        triangles.chunks_exact(3).flat_map(|t| (0..3).map(move |k| edge_key(t[k], t[(k + 1) % 3], vertex_count))).collect();
    keys.par_sort_unstable();
    let mut interior: Vec<u64> = keys.windows(2).filter(|pair| pair[0] == pair[1]).map(|pair| pair[0]).collect();
    interior.dedup();
    let point = |v: u32| [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]];
    let cell_of = |v: u32| point(v).map(|x| (x / cell_size).floor());
    let mut grid: std::collections::HashMap<[u64; 3], Vec<u32>> = std::collections::HashMap::new();
    let mut target: Vec<u32> = (0..vertex_count as u32).collect();
    let mut merged = 0;
    for v in (0..vertex_count as u32).filter(|&v| on_boundary[v as usize]) {
        let cell = cell_of(v);
        let mut best: Option<u32> = None;
        for di in -1..=1 {
            for dj in -1..=1 {
                for dk in -1..=1 {
                    let key = cell_key([cell[0] + f64::from(di), cell[1] + f64::from(dj), cell[2] + f64::from(dk)]);
                    for &u in grid.get(&key).map(Vec::as_slice).unwrap_or_default() {
                        if interior.binary_search(&edge_key(u, v, vertex_count)).is_ok() {
                            continue;
                        }
                        if dist(point(u), point(v)) <= max_gap && best.is_none_or(|b| u < b) {
                            best = Some(u);
                        }
                    }
                }
            }
        }
        match best {
            Some(u) => {
                target[v as usize] = u;
                merged += 1;
            }
            None => grid.entry(cell_key(cell)).or_default().push(v),
        }
    }
    if merged == 0 {
        return Stitched { triangles: triangles.to_vec(), merged: 0, reverted: false };
    }
    let remapped: Vec<u32> = triangles.iter().map(|&v| target[v as usize]).collect();
    let cleaned = clean_faces(positions, &remapped, 0.0, true).triangles;
    let after = build_topology(vertex_count, &cleaned);
    let worse =
        after.non_manifold_edges.len() > topology.non_manifold_edges.len() || after.boundary_edges.len() > topology.boundary_edges.len();
    if worse {
        Stitched { triangles: triangles.to_vec(), merged: 0, reverted: true }
    } else {
        Stitched { triangles: cleaned, merged, reverted: false }
    }
}

/// Remove shells with at most `max_faces` faces or (closed shells) |volume| at most `max_volume`; the largest shell always stays. Returns the triangles kept,
/// the shells removed and the faces removed with them.
fn remove_small_shells(positions: &[f64], triangles: &[u32], rule: &SmallRule) -> (Vec<u32>, usize, usize) {
    let topology = build_topology(positions.len() / 3, triangles);
    let shells = shell_volumes(positions, triangles, &topology);
    let mut small: Vec<bool> = shells
        .iter()
        .map(|&(faces, volume)| {
            rule.max_faces.is_some_and(|m| faces as f64 <= m) || rule.max_volume.is_some_and(|m| volume.is_some_and(|v| v.abs() <= m))
        })
        .collect();
    if !small.is_empty() && small.iter().all(|&s| s) {
        let mut largest = 0;
        for (k, shell) in shells.iter().enumerate() {
            if shell.0 > shells[largest].0 {
                largest = k;
            }
        }
        small[largest] = false;
    }
    let mut kept = Vec::with_capacity(triangles.len());
    let mut faces = 0;
    for (f, t) in triangles.chunks_exact(3).enumerate() {
        let shell = topology.face_shell[f];
        if shell != NO_SHELL && small[shell as usize] {
            faces += 1;
        } else {
            kept.extend_from_slice(t);
        }
    }
    (kept, small.iter().filter(|&&s| s).count(), faces)
}

/// Run one repair mode on `positions` / `triangles` (any indexed mesh; vertices are welded first at the weld tolerance); `tick` gets the share done.
pub fn repair(positions: &[f64], triangles: &[u32], params: &RepairParams, tick: &mut dyn FnMut(f64)) -> Repaired {
    let mut changes = Changes::default();
    let mut notes = Vec::new();
    let welded = weld(positions, triangles, params.weld_tolerance);
    changes.welded = welded.merged;
    let positions = welded.positions;
    let mut triangles = welded.triangles;
    tick(0.1);
    let diag = diagonal(&positions);
    let area_floor = 1e-12 * llull_jsmath::pow(diag, 2.0);
    let clean = |triangles: &mut Vec<u32>, changes: &mut Changes| {
        let result = clean_faces(&positions, triangles, area_floor, true);
        changes.degenerate_removed += result.degenerate;
        changes.duplicates_removed += result.duplicates;
        *triangles = result.triangles;
    };
    if params.mode == Mode::Weld {
        let result = clean_faces(&positions, &triangles, -1.0, false);
        changes.degenerate_removed += result.degenerate;
        triangles = result.triangles;
    } else if params.mode != Mode::Orient {
        clean(&mut triangles, &mut changes);
    }
    tick(0.3);
    if matches!(params.mode, Mode::Stitch | Mode::CloseHoles) {
        let result = stitch_vertices(&positions, &triangles, params.max_gap);
        triangles = result.triangles;
        changes.stitched = result.merged;
        if result.reverted {
            notes.push("stitch reverted: merging the close boundary vertices would create non-manifold edges or more boundary".to_string());
        }
        clean(&mut triangles, &mut changes);
    }
    tick(0.5);
    if let Some(rule) = &params.small {
        let (kept, shells, faces) = remove_small_shells(&positions, &triangles, rule);
        triangles = kept;
        changes.components_removed = shells;
        changes.faces_removed_with_components = faces;
    }
    tick(0.6);
    let (mut positions, mut triangles, mut skipped_holes) = (positions, triangles, 0);
    if params.mode == Mode::CloseHoles {
        let (compacted, indices) = compact(&positions, &triangles);
        let options = FillOptions {
            select: &Select::All,
            max_boundary_edges: params.max_boundary_edges,
            fairing: Fairing::None,
            refine: false,
            alpha: std::f64::consts::SQRT_2,
        };
        let filled = fill_holes(&compacted, &indices, &options, &mut |done| tick(0.6 + 0.35 * done));
        changes.holes_filled = filled.filled.len();
        skipped_holes = filled.skipped.len();
        positions = filled.positions;
        triangles = filled.triangles;
    }
    if params.mode == Mode::Orient {
        changes.flipped = orient_faces(&positions, &mut triangles);
    }
    let (positions, triangles) = compact(&positions, &triangles);
    Repaired { positions, triangles, changes, notes, skipped_holes }
}
