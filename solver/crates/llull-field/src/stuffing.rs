//! Isosurface stuffing of a field (FLL-M1, FR-FLL-05; the algorithm class of Labelle & Shewchuk 2007 [R9]): a body-centred cubic (BCC)
//! lattice over the grid (corners at the grid nodes, centres at the cell centres), the iso-surface cut point of every lattice edge whose ends
//! differ in sign (a root search on the field itself, not a linear interpolation), lattice vertices warped onto a cut point closer than
//! ALPHA_LONG / ALPHA_SHORT of the edge length (so no cut point lies near a vertex, the source of slivers), then each BCC tetrahedron filled
//! by the stencil of its signs (inside < 0, on the surface = warped, outside > 0).
//!
//! Differences from [R9] (decided in docs/aerospace/14-flight-loads-aeroelasticity/TECHNICAL_SPEC.md FLL-D1): a quadrilateral on a lattice face
//! is split by its shorter diagonal (exact tie -> the diagonal through the smaller vertex key), a rule both tetrahedra sharing the face evaluate
//! on the same numbers, so the mesh is conforming; a prism whose three quadrilateral diagonals turn the same way (no 3-tetrahedron split) gets a
//! Steiner vertex at its centroid. The outermost lattice layer is held outside, so the volume is always closed.
//! @invariant deterministic: evaluation and root searches run in parallel into ordered vectors, warping and stencils run in one fixed scan
//!   (cells x fastest, axes x y z, face edges in ring order), output vertices are numbered by first use: same field + grid -> same mesh, bit for bit
//! @invariant the warp scan visits vertices in ascending id; a vertex is warped to its nearest violating cut point (ties: the lower edge index)

use crate::eval::Evaluator;
use crate::sampling::{fill_plane, Grid, Tiles, OUTSIDE, ZERO_SNAP};
use crate::tetra::KeyBuild;
use rayon::prelude::*;
use std::collections::HashMap;

/// [R9] warp thresholds (fractions of the edge length) of the long (axis-aligned, length h) and short (corner-centre, sqrt(3)/2 h) edges.
pub const ALPHA_LONG: f64 = 0.24999;
pub const ALPHA_SHORT: f64 = 0.41189;
/// Named guard of one edge root search; it stops earlier when the bracket stops shrinking or the value is exactly zero.
const ROOT_ITERATIONS: usize = 80;
/// Keys of Steiner vertices start here (lattice ids and cut points stay below).
const STEINER_BASE: u64 = 1 << 62;

pub struct Lattice {
    pub grid: Grid,
    nodes: [usize; 3],
    cells: [usize; 3],
    corners: usize,
    pub total: usize,
}

impl Lattice {
    pub fn new(grid: Grid) -> Lattice {
        let nodes = grid.nodes();
        let corners = nodes[0] * nodes[1] * nodes[2];
        let cells = grid.cells;
        Lattice { grid, nodes, cells, corners, total: corners + cells[0] * cells[1] * cells[2] }
    }

    /// Lattice vertices (grid nodes + cell centres) of `grid`, the budgeted quantity, without building the lattice.
    pub fn vertex_count(grid: &Grid) -> u64 {
        grid.node_count() + grid.cell_count()
    }

    fn corner(&self, i: usize, j: usize, k: usize) -> u32 {
        (i + self.nodes[0] * (j + self.nodes[1] * k)) as u32
    }

    fn centre(&self, i: usize, j: usize, k: usize) -> u32 {
        (self.corners + i + self.cells[0] * (j + self.cells[1] * k)) as u32
    }

    pub fn position(&self, id: u32) -> [f64; 3] {
        let (g, id) = (&self.grid, id as usize);
        if id < self.corners {
            let (i, j, k) = (id % self.nodes[0], (id / self.nodes[0]) % self.nodes[1], id / (self.nodes[0] * self.nodes[1]));
            [g.min[0] + i as f64 * g.voxel, g.min[1] + j as f64 * g.voxel, g.min[2] + k as f64 * g.voxel]
        } else {
            let c = id - self.corners;
            let (i, j, k) = (c % self.cells[0], (c / self.cells[0]) % self.cells[1], c / (self.cells[0] * self.cells[1]));
            [0, 1, 2].map(|a| g.min[a] + ([i, j, k][a] as f64 + 0.5) * g.voxel)
        }
    }

    fn on_border(&self, id: u32) -> bool {
        let id = id as usize;
        if id >= self.corners {
            return false;
        }
        let (i, j, k) = (id % self.nodes[0], (id / self.nodes[0]) % self.nodes[1], id / (self.nodes[0] * self.nodes[1]));
        i == 0 || j == 0 || k == 0 || i + 1 == self.nodes[0] || j + 1 == self.nodes[1] || k + 1 == self.nodes[2]
    }
}

/// Signs of every lattice vertex (-1 inside, +1 outside) from the interval-pruned planes of the corner and centre grids; `layer` is called
/// after each plane with (planes done, planes in all). Returns the signs and how many border corners were inside (held outside).
pub fn lattice_signs(evaluator: &Evaluator, lattice: &Lattice, layer: &mut impl FnMut(usize, usize)) -> (Vec<i8>, usize) {
    let g = &lattice.grid;
    let centres = Grid {
        min: [0, 1, 2].map(|a| g.min[a] + 0.5 * g.voxel),
        max: [0, 1, 2].map(|a| g.min[a] + (g.cells[a] as f64 - 0.5) * g.voxel),
        voxel: g.voxel,
        cells: [0, 1, 2].map(|a| g.cells[a].saturating_sub(1).max(1)),
    };
    let mut signs = vec![1i8; lattice.total];
    let planes = lattice.nodes[2] + lattice.cells[2];
    let mut done = 0;
    for (sub, offset, count) in [(*g, 0, lattice.nodes), (centres, lattice.corners, lattice.cells)] {
        let tiles = Tiles::classify(evaluator, &sub);
        let size = count[0] * count[1];
        let mut plane = vec![0.0; sub.nodes()[0] * sub.nodes()[1]];
        for k in 0..count[2] {
            fill_plane(evaluator, &tiles, &sub, k, &mut plane);
            let row = sub.nodes()[0];
            let target = &mut signs[offset + k * size..offset + (k + 1) * size];
            target.par_iter_mut().enumerate().for_each(|(n, sign)| {
                let (i, j) = (n % count[0], n / count[0]);
                *sign = if plane[i + row * j] < 0.0 { -1 } else { 1 };
            });
            done += 1;
            layer(done, planes);
        }
    }
    let mut clipped = 0;
    for id in 0..lattice.corners as u32 {
        if signs[id as usize] < 0 && lattice.on_border(id) {
            signs[id as usize] = 1;
            clipped += 1;
        }
    }
    (signs, clipped)
}

/// A lattice edge whose ends differ in sign: `lo < hi`, long (axis-aligned) or short (corner-centre).
#[derive(Clone, Copy, Debug)]
pub struct Crossing {
    pub lo: u32,
    pub hi: u32,
    pub long: bool,
}

/// Every lattice edge with a sign change, sorted by (lo, hi).
pub fn crossings(lattice: &Lattice, signs: &[i8]) -> Vec<Crossing> {
    let (n, c) = (lattice.nodes, lattice.cells);
    let differ = |a: u32, b: u32| signs[a as usize] != signs[b as usize];
    let edge = |a: u32, b: u32, long: bool| Crossing { lo: a.min(b), hi: a.max(b), long };
    let corner_slabs: Vec<Vec<Crossing>> = (0..n[2])
        .into_par_iter()
        .map(|k| {
            let mut out = Vec::new();
            for j in 0..n[1] {
                for i in 0..n[0] {
                    let a = lattice.corner(i, j, k);
                    for (di, dj, dk) in [(1, 0, 0), (0, 1, 0), (0, 0, 1)] {
                        if i + di < n[0] && j + dj < n[1] && k + dk < n[2] {
                            let b = lattice.corner(i + di, j + dj, k + dk);
                            if differ(a, b) {
                                out.push(edge(a, b, true));
                            }
                        }
                    }
                }
            }
            out
        })
        .collect();
    let centre_slabs: Vec<Vec<Crossing>> = (0..c[2])
        .into_par_iter()
        .map(|k| {
            let mut out = Vec::new();
            for j in 0..c[1] {
                for i in 0..c[0] {
                    let a = lattice.centre(i, j, k);
                    for (di, dj, dk) in [(1, 0, 0), (0, 1, 0), (0, 0, 1)] {
                        if i + di < c[0] && j + dj < c[1] && k + dk < c[2] {
                            let b = lattice.centre(i + di, j + dj, k + dk);
                            if differ(a, b) {
                                out.push(edge(a, b, true));
                            }
                        }
                    }
                    for corner in 0..8 {
                        let b = lattice.corner(i + (corner & 1), j + ((corner >> 1) & 1), k + (corner >> 2));
                        if differ(a, b) {
                            out.push(edge(a, b, false));
                        }
                    }
                }
            }
            out
        })
        .collect();
    let mut all: Vec<Crossing> = corner_slabs.into_iter().chain(centre_slabs).flatten().collect();
    all.par_sort_unstable_by_key(|e| (e.lo, e.hi));
    all
}

/// The field value `f` as the lattice signs see it: |f| below the zero snap is outside, a non-finite value is outside.
fn snapped(value: f64, snap: f64) -> f64 {
    if !value.is_finite() {
        OUTSIDE
    } else if value.abs() < snap {
        snap
    } else {
        value
    }
}

fn lerp(a: &[f64; 3], b: &[f64; 3], t: f64) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t)
}

/// Fraction along a -> b of the iso-surface: Illinois regula falsi on the field, bracket kept, stopped when it no longer shrinks.
fn edge_root(evaluator: &Evaluator, registers: &mut [f64], a: &[f64; 3], b: &[f64; 3], snap: f64) -> f64 {
    let value = |registers: &mut [f64], p: [f64; 3]| evaluator.value_at(registers, p[0], p[1], p[2]);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let mut g0 = snapped(value(registers, *a), snap);
    let mut g1 = snapped(value(registers, *b), snap);
    if (g0 < 0.0) == (g1 < 0.0) {
        return 0.5;
    }
    let mut side = 0i8;
    let mut best = (f64::INFINITY, 0.5);
    for _ in 0..ROOT_ITERATIONS {
        let mut t = (t0 * g1 - t1 * g0) / (g1 - g0);
        if !(t > t0 && t < t1) {
            t = 0.5 * (t0 + t1);
            if !(t > t0 && t < t1) {
                break;
            }
        }
        let raw = value(registers, lerp(a, b, t));
        let g = if raw.is_finite() { raw } else { OUTSIDE };
        if g.abs() < best.0 {
            best = (g.abs(), t);
        }
        if g == 0.0 {
            break;
        }
        if (g < 0.0) == (g0 < 0.0) {
            t0 = t;
            g0 = g;
            if side == -1 {
                g1 *= 0.5;
            }
            side = -1;
        } else {
            t1 = t;
            g1 = g;
            if side == 1 {
                g0 *= 0.5;
            }
            side = 1;
        }
    }
    best.1
}

/// Cut point of every crossing: (fraction from `lo`, position).
pub fn cut_points(evaluator: &Evaluator, lattice: &Lattice, edges: &[Crossing]) -> Vec<(f64, [f64; 3])> {
    let snap = ZERO_SNAP * lattice.grid.voxel;
    edges
        .par_iter()
        .map_init(
            || vec![0.0; evaluator.instrs.len()],
            |registers, e| {
                let (a, b) = (lattice.position(e.lo), lattice.position(e.hi));
                let t = edge_root(evaluator, registers, &a, &b, snap);
                (t, lerp(&a, &b, t))
            },
        )
        .collect()
}

/// Length of a short (corner-centre) lattice edge in voxels.
const SHORT_EDGE: f64 = 0.866_025_403_784_438_6;

/// Warps vertices onto violating cut points (signs set to 0); returns the moved positions by lattice id.
pub fn warp(signs: &mut [i8], edges: &[Crossing], cuts: &[(f64, [f64; 3])]) -> HashMap<u32, [f64; 3], KeyBuild> {
    let mut incident: Vec<(u32, u32)> = edges.iter().enumerate().flat_map(|(e, c)| [(c.lo, e as u32), (c.hi, e as u32)]).collect();
    incident.par_sort_unstable();
    let mut warped: HashMap<u32, [f64; 3], KeyBuild> = HashMap::default();
    let mut start = 0;
    while start < incident.len() {
        let vertex = incident[start].0;
        let mut end = start;
        while end < incident.len() && incident[end].0 == vertex {
            end += 1;
        }
        let mut best: Option<(f64, u32)> = None;
        for &(_, e) in &incident[start..end] {
            let edge = edges[e as usize];
            if signs[edge.lo as usize] == 0 || signs[edge.hi as usize] == 0 {
                continue;
            }
            let t = cuts[e as usize].0;
            let fraction = if edge.lo == vertex { t } else { 1.0 - t };
            let (alpha, length) = if edge.long { (ALPHA_LONG, 1.0) } else { (ALPHA_SHORT, SHORT_EDGE) };
            if fraction < alpha && best.is_none_or(|(d, _)| fraction * length < d) {
                best = Some((fraction * length, e));
            }
        }
        if let Some((_, e)) = best {
            signs[vertex as usize] = 0;
            warped.insert(vertex, cuts[e as usize].1);
        }
        start = end;
    }
    warped
}

/// The stuffed mesh: linear tetrahedra (positive volume) over first-use numbered vertices.
pub struct Stuffed {
    pub positions: Vec<[f64; 3]>,
    pub tets: Vec<[u32; 4]>,
    /// Vertex lies on the iso-surface (a warped lattice vertex or a cut point).
    pub surface: Vec<bool>,
    pub steiner: usize,
}

/// More tetrahedra than the budget; carries the count reached when stuffing stopped.
#[derive(Debug, PartialEq, Eq)]
pub struct TetBudget(pub u64);

pub struct Stuffer<'a> {
    pub lattice: &'a Lattice,
    pub signs: &'a [i8],
    pub edges: &'a [Crossing],
    pub cuts: &'a [(f64, [f64; 3])],
    pub warped: &'a HashMap<u32, [f64; 3], KeyBuild>,
    /// Inside test of a point (for a tetrahedron whose four vertices were all warped onto the surface).
    pub inside: &'a dyn Fn([f64; 3]) -> bool,
}

struct Builder<'a> {
    s: &'a Stuffer<'a>,
    index: HashMap<u64, u32, KeyBuild>,
    out: Stuffed,
    max_tets: u64,
}

fn dist2(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

pub fn orient(p: &[[f64; 3]; 4]) -> f64 {
    let (a, b, c) = ([0, 1, 2].map(|i| p[1][i] - p[0][i]), [0, 1, 2].map(|i| p[2][i] - p[0][i]), [0, 1, 2].map(|i| p[3][i] - p[0][i]));
    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
}

impl Builder<'_> {
    fn position(&self, key: u64) -> [f64; 3] {
        let total = self.s.lattice.total as u64;
        if key < total {
            self.s.warped.get(&(key as u32)).copied().unwrap_or_else(|| self.s.lattice.position(key as u32))
        } else if key < STEINER_BASE {
            self.s.cuts[(key - total) as usize].1
        } else {
            self.out.positions[self.index[&key] as usize]
        }
    }

    fn cut(&self, a: u32, b: u32) -> u64 {
        let (lo, hi) = (a.min(b), a.max(b));
        // an edge whose ends are both unwarped and differ in sign was a crossing before the warp, so it is always found
        match self.s.edges.binary_search_by_key(&(lo, hi), |e| (e.lo, e.hi)) {
            Ok(found) => self.s.lattice.total as u64 + found as u64,
            Err(_) => unreachable!("lattice edge {lo}-{hi} changes sign but has no cut point"),
        }
    }

    fn vertex(&mut self, key: u64) -> u32 {
        if let Some(&known) = self.index.get(&key) {
            return known;
        }
        let index = self.out.positions.len() as u32;
        let position = self.position(key);
        self.out.positions.push(position);
        self.out.surface.push(key >= self.s.lattice.total as u64 || self.s.signs[key as usize] == 0);
        self.index.insert(key, index);
        index
    }

    fn emit(&mut self, keys: [u64; 4]) -> Result<(), TetBudget> {
        if self.out.tets.len() as u64 >= self.max_tets {
            return Err(TetBudget(self.out.tets.len() as u64 + 1));
        }
        let mut tet = keys.map(|k| self.vertex(k));
        let p = tet.map(|v| self.out.positions[v as usize]);
        if orient(&p) < 0.0 {
            tet.swap(1, 2);
        }
        self.out.tets.push(tet);
        Ok(())
    }

    /// True when quad q0 q1 q2 q3 (in ring order) is split by q0-q2: the shorter diagonal, exact ties by the smaller key.
    fn diagonal02(&self, q: [u64; 4]) -> bool {
        let p = q.map(|k| self.position(k));
        let (d02, d13) = (dist2(&p[0], &p[2]), dist2(&p[1], &p[3]));
        if d02 != d13 {
            d02 < d13
        } else {
            q[0].min(q[2]) < q[1].min(q[3])
        }
    }

    fn pyramid(&mut self, apex: u64, q: [u64; 4], d02: bool) -> Result<(), TetBudget> {
        if d02 {
            self.emit([apex, q[0], q[1], q[2]])?;
            self.emit([apex, q[0], q[2], q[3]])
        } else {
            self.emit([apex, q[0], q[1], q[3]])?;
            self.emit([apex, q[1], q[2], q[3]])
        }
    }

    /// Prism a0 a1 a2 / b0 b1 b2 (a_i above b_i); quad i = a_i a_{i+1} b_{i+1} b_i; `free` = the quad on the iso-surface (no neighbour).
    fn prism(&mut self, a: [u64; 3], b: [u64; 3], free: Option<usize>) -> Result<(), TetBudget> {
        let quad = |i: usize| [a[i], a[(i + 1) % 3], b[(i + 1) % 3], b[i]];
        let mut rising = [false; 3];
        for (i, r) in rising.iter_mut().enumerate() {
            *r = self.diagonal02(quad(i));
        }
        if let Some(f) = free {
            let (x, y) = (rising[(f + 1) % 3], rising[(f + 2) % 3]);
            if x == y {
                rising[f] = !x;
            }
        }
        let Some(i) = (0..3).find(|&i| rising[(i + 2) % 3] != rising[i]) else {
            let key = STEINER_BASE + self.out.steiner as u64;
            let corners = [a[0], a[1], a[2], b[0], b[1], b[2]].map(|k| self.position(k));
            let centre = [0, 1, 2].map(|axis| corners.iter().map(|p| p[axis]).sum::<f64>() / 6.0);
            self.index.insert(key, self.out.positions.len() as u32);
            self.out.positions.push(centre);
            self.out.surface.push(false);
            self.out.steiner += 1;
            self.emit([key, a[0], a[1], a[2]])?;
            self.emit([key, b[0], b[1], b[2]])?;
            for (j, &r) in rising.iter().enumerate() {
                self.pyramid(key, quad(j), r)?;
            }
            return Ok(());
        };
        let (prev, next) = ((i + 2) % 3, (i + 1) % 3);
        let apex = if rising[i] { a[i] } else { b[i] };
        if rising[i] {
            self.emit([a[i], b[prev], b[i], b[next]])?;
        } else {
            self.emit([b[i], a[prev], a[i], a[next]])?;
        }
        self.pyramid(apex, quad(next), rising[next])
    }

    fn stuff(&mut self, v: [u32; 4]) -> Result<(), TetBudget> {
        let sign = v.map(|id| self.s.signs[id as usize]);
        if sign.iter().all(|&s| s > 0) {
            return Ok(());
        }
        let pick = |want: i8| -> Vec<u32> { (0..4).filter(|&i| sign[i] == want).map(|i| v[i]).collect() };
        let (ins, zeros, outs) = (pick(-1), pick(0), pick(1));
        let key = |id: u32| u64::from(id);
        match (ins.len(), zeros.len(), outs.len()) {
            (0, 4, 0) => {
                let p = v.map(|id| self.position(key(id)));
                let centre = [0, 1, 2].map(|a| (p[0][a] + p[1][a] + p[2][a] + p[3][a]) / 4.0);
                if (self.s.inside)(centre) {
                    self.emit(v.map(key))?;
                }
                Ok(())
            }
            (0, _, _) => Ok(()),
            (_, _, 0) => self.emit(v.map(key)),
            (1, 0, 3) => {
                let i = ins[0];
                let (c1, c2, c3) = (self.cut(i, outs[0]), self.cut(i, outs[1]), self.cut(i, outs[2]));
                self.emit([key(i), c1, c2, c3])
            }
            (1, 1, 2) => {
                let i = ins[0];
                let (c1, c2) = (self.cut(i, outs[0]), self.cut(i, outs[1]));
                self.emit([key(i), key(zeros[0]), c1, c2])
            }
            (1, 2, 1) => {
                let i = ins[0];
                let c = self.cut(i, outs[0]);
                self.emit([key(i), key(zeros[0]), key(zeros[1]), c])
            }
            (2, 1, 1) => {
                let (i1, i2, o) = (ins[0], ins[1], outs[0]);
                let q = [key(i1), key(i2), self.cut(i2, o), self.cut(i1, o)];
                let d = self.diagonal02(q);
                self.pyramid(key(zeros[0]), q, d)
            }
            (2, 0, 2) => {
                let (i1, i2, o1, o2) = (ins[0], ins[1], outs[0], outs[1]);
                let a = [key(i1), self.cut(i1, o1), self.cut(i1, o2)];
                let b = [key(i2), self.cut(i2, o1), self.cut(i2, o2)];
                self.prism(a, b, Some(1))
            }
            _ => {
                let o = outs[0];
                let a = [key(ins[0]), key(ins[1]), key(ins[2])];
                let b = [self.cut(ins[0], o), self.cut(ins[1], o), self.cut(ins[2], o)];
                self.prism(a, b, None)
            }
        }
    }
}

impl Stuffer<'_> {
    /// Fills every BCC tetrahedron (two neighbouring centres + one edge of their shared face) by its stencil; `layer` hears (z layers done, all).
    pub fn run(&self, max_tets: u64, layer: &mut impl FnMut(usize, usize)) -> Result<Stuffed, TetBudget> {
        let mut builder = Builder {
            s: self,
            index: HashMap::default(),
            out: Stuffed { positions: Vec::new(), tets: Vec::new(), surface: Vec::new(), steiner: 0 },
            max_tets,
        };
        let (l, c) = (self.lattice, self.lattice.cells);
        for k in 0..c[2] {
            for j in 0..c[1] {
                for i in 0..c[0] {
                    let here = l.centre(i, j, k);
                    for axis in 0..3 {
                        let step = [usize::from(axis == 0), usize::from(axis == 1), usize::from(axis == 2)];
                        let (ni, nj, nk) = (i + step[0], j + step[1], k + step[2]);
                        if ni >= c[0] || nj >= c[1] || nk >= c[2] {
                            continue;
                        }
                        let there = l.centre(ni, nj, nk);
                        let (u, w) = ((axis + 1) % 3, (axis + 2) % 3);
                        let ring = [(0, 0), (1, 0), (1, 1), (0, 1)].map(|(du, dw)| {
                            let mut at = [i + step[0], j + step[1], k + step[2]];
                            at[u] = [i, j, k][u] + du;
                            at[w] = [i, j, k][w] + dw;
                            l.corner(at[0], at[1], at[2])
                        });
                        for e in 0..4 {
                            builder.stuff([here, there, ring[e], ring[(e + 1) % 4]])?;
                        }
                    }
                }
            }
            layer(k + 1, c[2]);
        }
        Ok(builder.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tet_quality::analyse;

    /// A builder whose cut points 0..6 sit at `points` (lattice of one cell; no lattice vertex is used).
    fn prism_of(points: [[f64; 3]; 6]) -> Stuffed {
        let lattice = Lattice::new(Grid::new([0.0; 3], [1.0; 3], 1.0).unwrap());
        let signs = vec![1i8; lattice.total];
        let edges: Vec<Crossing> = (0..6).map(|i| Crossing { lo: i, hi: 8, long: true }).collect();
        let cuts: Vec<(f64, [f64; 3])> = points.iter().map(|p| (0.5, *p)).collect();
        let warped = HashMap::default();
        let inside = |_: [f64; 3]| false;
        let stuffer = Stuffer { lattice: &lattice, signs: &signs, edges: &edges, cuts: &cuts, warped: &warped, inside: &inside };
        let mut builder = Builder {
            s: &stuffer,
            index: HashMap::default(),
            out: Stuffed { positions: Vec::new(), tets: Vec::new(), surface: Vec::new(), steiner: 0 },
            max_tets: 100,
        };
        let total = lattice.total as u64;
        builder.prism([total, total + 1, total + 2], [total + 3, total + 4, total + 5], None).unwrap();
        builder.out
    }

    fn ring(twist_deg: f64) -> [[f64; 3]; 6] {
        let at = |deg: f64, z: f64| [deg.to_radians().cos(), deg.to_radians().sin(), z];
        [at(0.0, 1.0), at(120.0, 1.0), at(240.0, 1.0), at(twist_deg, 0.0), at(120.0 + twist_deg, 0.0), at(240.0 + twist_deg, 0.0)]
    }

    #[test]
    fn a_straight_prism_splits_into_three_tetrahedra() {
        let out = prism_of(ring(0.0));
        assert_eq!((out.tets.len(), out.steiner), (3, 0));
        let (q, boundary) = analyse(&out.positions, &out.tets);
        assert_eq!((q.folded, q.degenerate, boundary.len()), (0, 0, 8), "2 end triangles + 3 quads split in 2");
        let volume: f64 = out.tets.iter().map(|t| orient(&t.map(|v| out.positions[v as usize])) / 6.0).sum();
        assert!((volume - 3.0 * 3f64.sqrt() / 4.0).abs() < 1e-12, "the triangle of circumradius 1 times height 1: {volume}");
    }

    #[test]
    fn a_twisted_prism_whose_diagonals_turn_one_way_gets_a_steiner_vertex() {
        let out = prism_of(ring(30.0));
        assert_eq!((out.tets.len(), out.steiner), (8, 1), "every shorter diagonal falls: no 3-tetrahedron split exists");
        let interior: Vec<usize> = (0..out.positions.len()).filter(|&v| !out.surface[v]).collect();
        assert_eq!(interior.len(), 1, "one Steiner vertex, off the surface");
        let centre = out.positions[interior[0]];
        assert!(centre[0].abs() < 1e-12 && centre[1].abs() < 1e-12 && (centre[2] - 0.5).abs() < 1e-12, "at the centroid: {centre:?}");
        let (q, boundary) = analyse(&out.positions, &out.tets);
        assert_eq!((q.folded, q.degenerate, boundary.len()), (0, 0, 8));
    }
}
