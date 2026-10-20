//! Host tables of the GPU path (RS-8): the shells and the contact set flattened for `explicit_shell.wgsl` / `explicit_contact.wgsl`, the
//! per-node gather lists in the CPU accumulation order, and the shell states read back into `Shells`.

use crate::contact::Contacts;
use crate::material::PointState;
use crate::shell::ShellState;
use crate::shells::Shells;

/// Values per thickness point in the shell state buffer: stress (6), plastic strain, damage, failed, temperature.
const POINT: usize = 10;

pub(crate) struct ShellTables {
    pub(crate) nodes: Vec<u32>,
    /// Per shell: thickness, material.
    pub(crate) info: Vec<f64>,
    pub(crate) state: Vec<f64>,
    /// Node -> shell slots `4 s + k`, in shell order.
    pub(crate) start: Vec<u32>,
    pub(crate) incidence: Vec<u32>,
}

pub(crate) fn shell_tables(shells: &Shells, nodes: usize) -> ShellTables {
    let mut lists: Vec<Vec<u32>> = vec![Vec::new(); nodes];
    for (s, corners) in shells.corners.iter().enumerate() {
        for (k, &node) in corners.iter().enumerate() {
            lists[node].push((4 * s + k) as u32);
        }
    }
    let (start, incidence) = flatten(&lists);
    ShellTables {
        nodes: shells.corners.iter().flat_map(|corners| corners.map(|node| node as u32)).collect(),
        info: (0..shells.corners.len()).flat_map(|s| [shells.thickness[s], shells.material[s] as f64]).collect(),
        state: shells.states.iter().flat_map(state_row).collect(),
        start,
        incidence,
    }
}

fn state_row(state: &ShellState) -> Vec<f64> {
    let mut row = Vec::with_capacity(POINT * state.points.len() + 5);
    for point in &state.points {
        row.extend_from_slice(&point.stress);
        row.extend_from_slice(&[point.plastic_strain, point.damage, if point.failed { 1.0 } else { 0.0 }, point.temperature]);
    }
    row.extend_from_slice(&state.hourglass);
    row
}

/// Loads the shell states read back from the GPU into `shells` (for the fields of the outcome).
pub(crate) fn load_shell_states(shells: &mut Shells, data: &[f64]) {
    for (s, state) in shells.states.iter_mut().enumerate() {
        let points = state.points.len();
        let base = (POINT * points + 5) * s;
        for (q, point) in state.points.iter_mut().enumerate() {
            let at = base + POINT * q;
            *point = PointState {
                stress: std::array::from_fn(|k| data[at + k]),
                plastic_strain: data[at + 6],
                damage: data[at + 7],
                failed: data[at + 8] > 0.5,
                temperature: data[at + 9],
            };
        }
        state.hourglass = std::array::from_fn(|k| data[base + POINT * points + k]);
    }
}

fn flatten(lists: &[Vec<u32>]) -> (Vec<u32>, Vec<u32>) {
    let mut start = vec![0u32; lists.len() + 1];
    let mut flat = Vec::new();
    for (node, list) in lists.iter().enumerate() {
        flat.extend_from_slice(list);
        start[node + 1] = flat.len() as u32;
    }
    (start, flat)
}

/// Per-cycle-search contact tables: slaves with their candidate ranges, the candidates, and per node the gather entries (slave, segment,
/// local index; 4 = the node is the slave) sorted by slave, which is the order `Contacts::forces` adds into a node.
pub(crate) struct ContactSearch {
    pub(crate) slaves: Vec<u32>,
    pub(crate) candidates: Vec<u32>,
    pub(crate) gather_start: Vec<u32>,
    pub(crate) gather: Vec<u32>,
}

pub(crate) fn contact_search(contacts: &Contacts, slaves: &[[u32; 2]], segment_nodes: &[u32], x: &[f64], extra: f64) -> ContactSearch {
    let lists = contacts.candidates(x, extra);
    let nodes = x.len() / 3;
    let mut table = Vec::with_capacity(4 * slaves.len());
    let mut candidates = Vec::new();
    let mut entries: Vec<Vec<u32>> = vec![Vec::new(); nodes];
    for (g, (slave, list)) in slaves.iter().zip(&lists).enumerate() {
        table.extend_from_slice(&[slave[0], slave[1], candidates.len() as u32, list.len() as u32]);
        candidates.extend_from_slice(list);
        entries[slave[0] as usize].extend_from_slice(&[g as u32, u32::MAX, 4]);
        for &s in list {
            for k in 0..4 {
                let node = segment_nodes[4 * s as usize + k];
                if node != u32::MAX {
                    entries[node as usize].extend_from_slice(&[g as u32, s, k as u32]);
                }
            }
        }
    }
    let (gather_start, gather) = flatten(&entries);
    let gather_start = gather_start.into_iter().map(|index| index / 3).collect();
    ContactSearch { slaves: table, candidates, gather_start, gather }
}
