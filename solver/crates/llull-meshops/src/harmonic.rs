//! Harmonic-map parameterisation of a disk-topology triangle region (07 MSH FR-MSH-24, TECHNICAL_SPEC 13.23 / 13.26): the Rust twin of
//! `packages/core/src/geometry/mesh/harmonicMap.ts`, the oracle. Same operation order everywhere (face-order accumulation of the weights, the row order of the
//! matrix, the solvers of `lib/conjugateGradient.ts` and `lib/biCgStab.ts`), `Math.hypot` / `Math.atan2` by the V8 twins of `llull-jsmath`, so the parameters are
//! bit-identical to the TypeScript result and the refusals carry the same codes and texts.
//! The region is the whole input mesh (the host cuts the region out first and maps the vertex numbers back).

use llull_jsmath::{atan2, hypot};
use std::collections::{HashMap, HashSet};

/// Relative residual of the solves.
const HARMONIC_TOLERANCE: f64 = 1e-9;
/// A parameter triangle with a signed area below minus this (the square has area 1) is flipped.
const FLIP_AREA: f64 = -1e-12;
/// A boundary vertex that turns by more than this (radians) over a window of 1/32 of the boundary on each side is a corner candidate.
const CORNER_TURN: f64 = 0.35;
/// Corners are at least this share of the boundary length apart.
const CORNER_SEPARATION: f64 = 1.0 / 16.0;
/// Iterations between two stall checks.
const STALL_WINDOW: usize = 400;
/// Iterations per coordinate a solve may take at most.
const ITERATION_CAP: usize = 4000;
/// Boundary vertices a disk needs: one per corner of the square.
const MIN_BOUNDARY_VERTICES: usize = 4;

/// A refusal of the region, with the stable code of the command (`MESH_FIT_NOT_DISK`, `MESH_FIT_PARAM_FOLDED`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn not_disk(message: impl Into<String>) -> Refusal {
    Refusal { code: "MESH_FIT_NOT_DISK", message: message.into() }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Harmonic {
    /// The vertices of the region, ascending, and their parameters (u, v) in the same order.
    pub vertices: Vec<u32>,
    pub uv: Vec<[f64; 2]>,
    pub weights: &'static str,
    pub flipped_first: usize,
    pub collapsed_in_parameters: usize,
    pub interior_vertices: usize,
    pub boundary_vertices: usize,
    pub cg_iterations: usize,
    pub cg_residual: f64,
    pub corners: [u32; 4],
}

/// Iterations per coordinate a region of `n` interior vertices is given.
pub fn iteration_budget(n: usize) -> usize {
    (4 * n).min(ITERATION_CAP).min(400 + (12.0 * (n as f64).sqrt()).ceil() as usize)
}

type V3 = [f64; 3];
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(v: V3) -> f64 {
    hypot(&[v[0], v[1], v[2]])
}

struct Mesh<'a> {
    positions: &'a [f64],
    triangles: &'a [u32],
    vertex_count: u64,
}

impl Mesh<'_> {
    fn point(&self, v: u32) -> V3 {
        let i = 3 * v as usize;
        [self.positions[i], self.positions[i + 1], self.positions[i + 2]]
    }
    fn corner(&self, f: usize, k: usize) -> u32 {
        self.triangles[3 * f + k]
    }
}

struct Topology {
    vertices: Vec<u32>,
    loop_: Vec<u32>,
}

/// The vertices and the boundary loop of the region, or the reason it is not a disk.
fn disk_topology(mesh: &Mesh, faces: usize) -> Result<Topology, Refusal> {
    let vc = mesh.vertex_count;
    let mut directed: HashSet<u64> = HashSet::new();
    let mut order: Vec<u64> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    for f in 0..faces {
        for k in 0..3 {
            let (a, b) = (mesh.corner(f, k), mesh.corner(f, (k + 1) % 3));
            seen.insert(a);
            if a == b {
                return Err(not_disk(format!("triangle {f} has a repeated vertex")));
            }
            let key = a as u64 * vc + b as u64;
            if directed.contains(&key) {
                return Err(not_disk(format!(
                    "the region is not a consistently wound manifold: the edge {a}-{b} is used twice in the same direction (triangle {f}, a duplicate or a flipped neighbour)"
                )));
            }
            directed.insert(key);
            order.push(key);
        }
    }
    let mut vertices: Vec<u32> = seen.into_iter().collect();
    vertices.sort_unstable();
    let mut next: HashMap<u32, u32> = HashMap::new();
    let mut edges: i64 = 0;
    for &key in &order {
        let (a, b) = ((key / vc) as u32, (key % vc) as u32);
        let reversed = directed.contains(&(b as u64 * vc + a as u64));
        if a < b || !reversed {
            edges += 1;
        }
        if reversed {
            continue;
        }
        if next.contains_key(&a) {
            return Err(not_disk(format!("the boundary of the region touches itself at vertex {a} (a pinch): it is not a disk")));
        }
        next.insert(a, b);
    }
    if next.is_empty() {
        return Err(not_disk(
            "the region is closed (it has no boundary loop): cut it open or pick a region, e.g. with a sphere or faceGroups",
        ));
    }
    let mut starts: Vec<u32> = next.keys().copied().collect();
    starts.sort_unstable();
    let mut visited: HashSet<u32> = HashSet::new();
    let mut loops: Vec<Vec<u32>> = Vec::new();
    for start in starts {
        if visited.contains(&start) {
            continue;
        }
        let mut one = Vec::new();
        let mut v = start;
        while !visited.contains(&v) {
            visited.insert(v);
            one.push(v);
            v = match next.get(&v) {
                Some(&w) => w,
                None => return Err(not_disk(format!("the boundary of the region does not close at vertex {v}: it is not a disk"))),
            };
        }
        loops.push(one);
    }
    if loops.len() != 1 {
        return Err(not_disk(format!(
            "the region has {} boundary loops (holes): a disk has exactly one; fill_mesh_holes or pick a region without holes",
            loops.len()
        )));
    }
    // connected through shared edges
    let mut owner: HashMap<u64, Vec<usize>> = HashMap::new();
    for f in 0..faces {
        for k in 0..3 {
            let (a, b) = (mesh.corner(f, k) as u64, mesh.corner(f, (k + 1) % 3) as u64);
            owner.entry(a.min(b) * vc + a.max(b)).or_default().push(f);
        }
    }
    let mut reached = vec![false; faces];
    let mut stack = vec![0usize];
    reached[0] = true;
    let mut count = 1usize;
    while let Some(f) = stack.pop() {
        for k in 0..3 {
            let (a, b) = (mesh.corner(f, k) as u64, mesh.corner(f, (k + 1) % 3) as u64);
            if let Some(list) = owner.get(&(a.min(b) * vc + a.max(b))) {
                for &j in list {
                    if !reached[j] {
                        reached[j] = true;
                        count += 1;
                        stack.push(j);
                    }
                }
            }
        }
    }
    if count != faces {
        return Err(not_disk(format!(
            "the region is in several pieces ({} of its {faces} triangles are not joined to the first by edges)",
            faces - count
        )));
    }
    let euler = vertices.len() as i64 - edges + faces as i64;
    if euler != 1 {
        return Err(not_disk(format!("the region has Euler characteristic {euler} with one boundary loop (a disk has 1): it has handles")));
    }
    let loop_ = loops.remove(0);
    if loop_.len() < MIN_BOUNDARY_VERTICES {
        return Err(not_disk(format!(
            "the boundary of the region has {} vertices: the four corners of the parameter square need at least {MIN_BOUNDARY_VERTICES} (a single triangle cannot be mapped)",
            loop_.len()
        )));
    }
    Ok(Topology { vertices, loop_ })
}

/// `Math.round`-free twin of the corner choice: the positions in `loop_` of the four corners of the square, ascending.
fn pick_corners(loop_: &[u32], mesh: &Mesh, arc: &[f64], perimeter: f64) -> Vec<usize> {
    let n = loop_.len();
    let window = ((n as f64 / 32.0).round() as usize).max(1);
    let turning: Vec<f64> = (0..n)
        .map(|i| {
            let (before, here, ahead) =
                (mesh.point(loop_[(i + n - (window % n)) % n]), mesh.point(loop_[i]), mesh.point(loop_[(i + window) % n]));
            let (a, b) = (sub(here, before), sub(ahead, here));
            atan2(norm(cross(a, b)), dot(a, b))
        })
        .collect();
    let apart = |i: usize, j: usize| {
        let d = (arc[i] - arc[j]).abs();
        d.min(perimeter - d)
    };
    let mut chosen: Vec<usize> = Vec::new();
    let mut sharp: Vec<(f64, usize)> = turning.iter().enumerate().filter(|(_, &t)| t >= CORNER_TURN).map(|(i, &t)| (t, i)).collect();
    sharp.sort_by(|x, y| {
        let d = y.0 - x.0;
        if d < 0.0 {
            std::cmp::Ordering::Less
        } else if d > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            x.1.cmp(&y.1)
        }
    });
    for &(_, i) in &sharp {
        if chosen.len() < 4 && chosen.iter().all(|&c| apart(i, c) >= CORNER_SEPARATION * perimeter) {
            chosen.push(i);
        }
    }
    if chosen.is_empty() {
        chosen.push(0);
    }
    while chosen.len() < 4 {
        let mut sorted = chosen.clone();
        sorted.sort_unstable();
        let (mut gap_start, mut gap) = (0usize, -1.0f64);
        for (k, &c) in sorted.iter().enumerate() {
            let next_arc = if k + 1 < sorted.len() { arc[sorted[k + 1]] } else { perimeter + arc[sorted[0]] };
            if next_arc - arc[c] > gap {
                gap_start = c;
                gap = next_arc - arc[c];
            }
        }
        let target = (arc[gap_start] + gap / 2.0) % perimeter;
        let mut best: i64 = -1;
        for i in 0..n {
            if chosen.contains(&i) {
                continue;
            }
            let d = (arc[i] - target).abs();
            if best < 0 {
                best = i as i64;
                continue;
            }
            let bd = (arc[best as usize] - target).abs();
            if d.min(perimeter - d) < bd.min(perimeter - bd) {
                best = i as i64;
            }
        }
        chosen.push(best as usize);
    }
    chosen.sort_unstable();
    chosen
}

fn on_side(side: usize, f: f64) -> [f64; 2] {
    match side {
        0 => [f, 0.0],
        1 => [1.0, f],
        2 => [1.0 - f, 1.0],
        _ => [0.0, 1.0 - f],
    }
}

struct System {
    interior: Vec<u32>,
    diagonal: Vec<f64>,
    row_start: Vec<usize>,
    cols: Vec<usize>,
    vals: Vec<f64>,
    rhs_u: Vec<f64>,
    rhs_v: Vec<f64>,
}

/// Cotangent weight of every undirected edge of the region, keyed `min * vertexCount + max`, summed in face order.
fn cotangent_weights(mesh: &Mesh, faces: usize) -> HashMap<u64, f64> {
    let mut weights: HashMap<u64, f64> = HashMap::new();
    for f in 0..faces {
        let ids = [mesh.corner(f, 0), mesh.corner(f, 1), mesh.corner(f, 2)];
        for k in 0..3 {
            let (apex, a, b) = (ids[k], ids[(k + 1) % 3], ids[(k + 2) % 3]);
            let (ea, eb) = (sub(mesh.point(a), mesh.point(apex)), sub(mesh.point(b), mesh.point(apex)));
            let area2 = norm(cross(ea, eb));
            if !(area2 > 0.0) {
                continue;
            }
            let key = (a.min(b) as u64) * mesh.vertex_count + a.max(b) as u64;
            *weights.entry(key).or_insert(0.0) += dot(ea, eb) / area2 / 2.0;
        }
    }
    weights
}

/// Floater's mean-value weight of every DIRECTED edge i -> j, keyed `i * vertexCount + j`, summed in face order.
fn mean_value_weights(mesh: &Mesh, faces: usize) -> HashMap<u64, f64> {
    let mut weights: HashMap<u64, f64> = HashMap::new();
    for f in 0..faces {
        let ids = [mesh.corner(f, 0), mesh.corner(f, 1), mesh.corner(f, 2)];
        for k in 0..3 {
            let (apex, a, b) = (ids[k], ids[(k + 1) % 3], ids[(k + 2) % 3]);
            let (ea, eb) = (sub(mesh.point(a), mesh.point(apex)), sub(mesh.point(b), mesh.point(apex)));
            let (la, lb, area2) = (norm(ea), norm(eb), norm(cross(ea, eb)));
            if !(area2 > 0.0) {
                continue;
            }
            let half = area2 / (la * lb + dot(ea, eb));
            for (other, length) in [(a, la), (b, lb)] {
                let key = apex as u64 * mesh.vertex_count + other as u64;
                *weights.entry(key).or_insert(0.0) += half / length;
            }
        }
    }
    weights
}

type Boundary = HashMap<u32, [f64; 2]>;

fn system_of(mesh: &Mesh, faces: usize, topology: &Topology, weight: &dyn Fn(u32, u32) -> f64, boundary: &Boundary) -> System {
    let vc = mesh.vertex_count;
    let interior: Vec<u32> = topology.vertices.iter().copied().filter(|v| !boundary.contains_key(v)).collect();
    let mut local = vec![-1i32; vc as usize];
    for (i, &v) in interior.iter().enumerate() {
        local[v as usize] = i as i32;
    }
    let n = interior.len();
    let mut ends: Vec<(u32, u32)> = Vec::new();
    let mut done: HashSet<u64> = HashSet::new();
    for f in 0..faces {
        for k in 0..3 {
            let (a, b) = (mesh.corner(f, k), mesh.corner(f, (k + 1) % 3));
            let key = (a.min(b) as u64) * vc + a.max(b) as u64;
            if !done.insert(key) {
                continue;
            }
            ends.push((a, b));
        }
    }
    let mut degree = vec![0usize; n + 1];
    for &(a, b) in &ends {
        let (i, j) = (local[a as usize], local[b as usize]);
        if i >= 0 && j >= 0 {
            degree[i as usize + 1] += 1;
            degree[j as usize + 1] += 1;
        }
    }
    let mut row_start = vec![0usize; n + 1];
    for i in 0..n {
        row_start[i + 1] = row_start[i] + degree[i + 1];
    }
    let total = row_start[n];
    let (mut cols, mut vals) = (vec![0usize; total], vec![0.0f64; total]);
    let mut fill: Vec<usize> = row_start[..n].to_vec();
    let mut diagonal = vec![0.0f64; n];
    let (mut rhs_u, mut rhs_v) = (vec![0.0f64; n], vec![0.0f64; n]);
    for &(a, b) in &ends {
        for (v, other) in [(a, b), (b, a)] {
            let i = local[v as usize];
            if i < 0 {
                continue;
            }
            let i = i as usize;
            let w = weight(v, other);
            diagonal[i] += w;
            let j = local[other as usize];
            if j >= 0 {
                let at = fill[i];
                cols[at] = j as usize;
                vals[at] = w;
                fill[i] = at + 1;
            } else {
                let [u, t] = boundary[&other];
                rhs_u[i] += w * u;
                rhs_v[i] += w * t;
            }
        }
    }
    System { interior, diagonal, row_start, cols, vals, rhs_u, rhs_v }
}

struct Solve {
    x: Vec<f64>,
    iterations: usize,
    relative_residual: f64,
    converged: bool,
}

fn dot_v(a: &[f64], b: &[f64]) -> f64 {
    let mut total = 0.0;
    for i in 0..a.len() {
        total += a[i] * b[i];
    }
    total
}

fn inverse(diagonal: &[f64], i: usize) -> f64 {
    let d = diagonal[i];
    if d > 0.0 {
        1.0 / d
    } else {
        1.0
    }
}

/// `lib/conjugateGradient.ts` (Jacobi-preconditioned, stall window).
fn conjugate_gradient(system: &System, b: &[f64], x0: &[f64], max_iterations: usize) -> Solve {
    let n = b.len();
    let mut x = x0.to_vec();
    let mut r = vec![0.0; n];
    let mut ap = vec![0.0; n];
    apply(system, &x, &mut ap);
    for i in 0..n {
        r[i] = b[i] - ap[i];
    }
    let norm_b = dot_v(b, b).sqrt();
    if norm_b == 0.0 {
        return Solve { x: vec![0.0; n], iterations: 0, relative_residual: 0.0, converged: true };
    }
    let mut z = vec![0.0; n];
    for i in 0..n {
        z[i] = r[i] * inverse(&system.diagonal, i);
    }
    let mut p = z.clone();
    let mut rz = dot_v(&r, &z);
    let mut residual = dot_v(&r, &r).sqrt() / norm_b;
    let mut iterations = 0usize;
    let (mut checkpoint, mut best) = (residual, residual);
    while residual > HARMONIC_TOLERANCE && iterations < max_iterations {
        apply(system, &p, &mut ap);
        let curvature = dot_v(&p, &ap);
        if !(curvature > 0.0) {
            break;
        }
        let alpha = rz / curvature;
        for i in 0..n {
            x[i] += alpha * p[i];
            r[i] -= alpha * ap[i];
        }
        for i in 0..n {
            z[i] = r[i] * inverse(&system.diagonal, i);
        }
        let next = dot_v(&r, &z);
        let beta = next / rz;
        rz = next;
        for i in 0..n {
            p[i] = z[i] + beta * p[i];
        }
        residual = dot_v(&r, &r).sqrt() / norm_b;
        iterations += 1;
        best = best.min(residual);
        if iterations % STALL_WINDOW == 0 {
            if best >= 0.99 * checkpoint {
                break;
            }
            checkpoint = best;
        }
    }
    Solve { x, iterations, relative_residual: residual, converged: residual <= HARMONIC_TOLERANCE }
}

/// `lib/biCgStab.ts`.
fn bi_cg_stab(system: &System, b: &[f64], x0: &[f64], max_iterations: usize) -> Solve {
    let n = b.len();
    let mut x = x0.to_vec();
    let norm_b = dot_v(b, b).sqrt();
    if norm_b == 0.0 {
        return Solve { x: vec![0.0; n], iterations: 0, relative_residual: 0.0, converged: true };
    }
    let (mut r, mut p, mut v, mut y, mut z, mut s, mut t) =
        (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    apply(system, &x, &mut t);
    for i in 0..n {
        r[i] = b[i] - t[i];
    }
    let r_hat = r.clone();
    let (mut rho, mut alpha, mut omega) = (1.0f64, 1.0f64, 1.0f64);
    let mut residual = dot_v(&r, &r).sqrt() / norm_b;
    let (mut checkpoint, mut best) = (residual, residual);
    let mut iterations = 0usize;
    while residual > HARMONIC_TOLERANCE && iterations < max_iterations {
        let rho_next = dot_v(&r_hat, &r);
        if rho_next == 0.0 || omega == 0.0 {
            break;
        }
        let beta = (rho_next / rho) * (alpha / omega);
        for i in 0..n {
            p[i] = r[i] + beta * (p[i] - omega * v[i]);
        }
        for i in 0..n {
            y[i] = p[i] * inverse(&system.diagonal, i);
        }
        apply(system, &y, &mut v);
        let denominator = dot_v(&r_hat, &v);
        if denominator == 0.0 {
            break;
        }
        alpha = rho_next / denominator;
        for i in 0..n {
            s[i] = r[i] - alpha * v[i];
        }
        iterations += 1;
        let s_residual = dot_v(&s, &s).sqrt() / norm_b;
        if s_residual <= HARMONIC_TOLERANCE {
            for i in 0..n {
                x[i] += alpha * y[i];
            }
            residual = s_residual;
            break;
        }
        for i in 0..n {
            z[i] = s[i] * inverse(&system.diagonal, i);
        }
        apply(system, &z, &mut t);
        let tt = dot_v(&t, &t);
        if tt == 0.0 {
            break;
        }
        omega = dot_v(&t, &s) / tt;
        for i in 0..n {
            x[i] = x[i] + alpha * y[i] + omega * z[i];
            r[i] = s[i] - omega * t[i];
        }
        rho = rho_next;
        residual = dot_v(&r, &r).sqrt() / norm_b;
        best = best.min(residual);
        if iterations % STALL_WINDOW == 0 {
            if best >= 0.99 * checkpoint {
                break;
            }
            checkpoint = best;
        }
    }
    Solve { x, iterations, relative_residual: residual, converged: residual <= HARMONIC_TOLERANCE }
}

fn apply(system: &System, x: &[f64], out: &mut [f64]) {
    for i in 0..system.diagonal.len() {
        let mut sum = system.diagonal[i] * x[i];
        for at in system.row_start[i]..system.row_start[i + 1] {
            sum -= system.vals[at] * x[system.cols[at]];
        }
        out[i] = sum;
    }
}

struct Solved {
    u: Vec<f64>,
    v: Vec<f64>,
    iterations: usize,
    residual: f64,
    converged: bool,
}

fn solve(system: &System, symmetric: bool, budget: usize, start: Option<(&[f64], &[f64])>) -> Solved {
    let n = system.interior.len();
    let guess = || vec![0.5; n];
    let method = if symmetric { conjugate_gradient } else { bi_cg_stab };
    let u = method(system, &system.rhs_u, start.map(|s| s.0.to_vec()).unwrap_or_else(guess).as_slice(), budget);
    let v = method(system, &system.rhs_v, start.map(|s| s.1.to_vec()).unwrap_or_else(guess).as_slice(), budget);
    let finite = u.x.iter().all(|c| c.is_finite()) && v.x.iter().all(|c| c.is_finite());
    Solved {
        iterations: u.iterations + v.iterations,
        residual: u.relative_residual.max(v.relative_residual),
        converged: u.converged && v.converged && finite,
        u: u.x,
        v: v.x,
    }
}

fn flips(mesh: &Mesh, faces: usize, uv: &HashMap<u32, [f64; 2]>) -> (usize, usize) {
    let (mut flipped, mut collapsed) = (0usize, 0usize);
    for f in 0..faces {
        let (a, b, c) = (uv[&mesh.corner(f, 0)], uv[&mesh.corner(f, 1)], uv[&mesh.corner(f, 2)]);
        let area = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0;
        if area < FLIP_AREA {
            flipped += 1;
        } else if area <= -FLIP_AREA {
            collapsed += 1;
        }
    }
    (flipped, collapsed)
}

/// JavaScript's `Number.prototype.toExponential(2)`.
fn to_exponential(x: f64) -> String {
    let text = format!("{x:.2e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => format!("{mantissa}e+{exponent}"),
        _ => text,
    }
}

fn uv_map(boundary: &Boundary, system: &System, solved: &Solved) -> HashMap<u32, [f64; 2]> {
    let mut uv = boundary.clone();
    for (i, &vertex) in system.interior.iter().enumerate() {
        uv.insert(vertex, [solved.u[i], solved.v[i]]);
    }
    uv
}

/// Harmonic map of the whole mesh (`positions`, `triangles`) onto the unit square.
/// `max_iterations` is the budget per coordinate (default `iteration_budget`).
pub fn harmonic_map(positions: &[f64], triangles: &[u32], max_iterations: Option<usize>) -> Result<Harmonic, Refusal> {
    let faces = triangles.len() / 3;
    if faces == 0 {
        return Err(not_disk("the region has no triangle"));
    }
    let mesh = Mesh { positions, triangles, vertex_count: (positions.len() / 3) as u64 };
    let topology = disk_topology(&mesh, faces)?;
    let loop_ = &topology.loop_;
    let lengths: Vec<f64> = (0..loop_.len()).map(|i| norm(sub(mesh.point(loop_[(i + 1) % loop_.len()]), mesh.point(loop_[i])))).collect();
    let perimeter = lengths.iter().fold(0.0, |sum, length| sum + length);
    if !(perimeter > 0.0) {
        return Err(not_disk("the boundary loop of the region has no length"));
    }
    let mut arc: Vec<f64> = Vec::with_capacity(lengths.len());
    let mut running = 0.0;
    for length in &lengths {
        arc.push(running);
        running += length;
    }
    let corners = pick_corners(loop_, &mesh, &arc, perimeter);
    let mut boundary: Boundary = HashMap::new();
    for (side, &start) in corners.iter().enumerate() {
        let end = if side == 3 { corners[0] + loop_.len() } else { corners[side + 1] };
        let (from, to) = (arc[start], if end >= loop_.len() { perimeter + arc[end - loop_.len()] } else { arc[end] });
        for i in start..end {
            let at = i % loop_.len();
            let here = if i >= loop_.len() { perimeter + arc[at] } else { arc[at] };
            boundary.insert(loop_[at], on_side(side, if to > from { (here - from) / (to - from) } else { 0.0 }));
        }
    }
    let vc = mesh.vertex_count;
    let cotangent = cotangent_weights(&mesh, faces);
    let key = |a: u32, b: u32| (a.min(b) as u64) * vc + a.max(b) as u64;
    let interior_count = topology.vertices.len() - loop_.len();
    let budget = max_iterations.unwrap_or_else(|| iteration_budget(interior_count));
    let first_system = system_of(&mesh, faces, &topology, &|i, j| *cotangent.get(&key(i, j)).unwrap_or(&0.0), &boundary);
    let first = solve(&first_system, true, budget, None);
    let first_uv = uv_map(&boundary, &first_system, &first);
    let first_converged = first.converged && first_uv.values().all(|[p, q]| p.is_finite() && q.is_finite());
    let first_flips = if first_converged { flips(&mesh, faces, &first_uv) } else { (faces, 0) };
    let corner_ids: [u32; 4] = [loop_[corners[0]], loop_[corners[1]], loop_[corners[2]], loop_[corners[3]]];
    let accept = |solved: &Solved, system: &System, weights: &'static str, counted: (usize, usize), flipped_first: usize| -> Harmonic {
        let uv = uv_map(&boundary, system, solved);
        Harmonic {
            vertices: topology.vertices.clone(),
            uv: topology.vertices.iter().map(|v| uv[v]).collect(),
            weights,
            flipped_first,
            collapsed_in_parameters: counted.1,
            interior_vertices: interior_count,
            boundary_vertices: loop_.len(),
            cg_iterations: solved.iterations,
            cg_residual: solved.residual,
            corners: corner_ids,
        }
    };
    if first_converged && first_flips.0 == 0 {
        return Ok(accept(&first, &first_system, "cotangent", first_flips, 0));
    }
    let mean_value = mean_value_weights(&mesh, faces);
    let second_system = system_of(&mesh, faces, &topology, &|i, j| *mean_value.get(&(i as u64 * vc + j as u64)).unwrap_or(&0.0), &boundary);
    let second = solve(&second_system, false, budget, if first_converged { Some((&first.u, &first.v)) } else { None });
    let second_uv = uv_map(&boundary, &second_system, &second);
    let second_converged = second.converged && second_uv.values().all(|[p, q]| p.is_finite() && q.is_finite());
    if !second_converged {
        return Err(Refusal {
            code: "MESH_FIT_PARAM_FOLDED",
            message: format!(
                "the harmonic map did not reach its tolerance within the iteration budget (relative residual {} against {} after {} iterations, budget {budget} per coordinate): the region's triangles are too degenerate or too many; decimate_mesh it, or pick a smaller region (faceGroups)",
                to_exponential(second.residual),
                "1e-9",
                second.iterations
            ),
        });
    }
    let second_flips = flips(&mesh, faces, &second_uv);
    if second_flips.0 > 0 {
        return Err(Refusal {
            code: "MESH_FIT_PARAM_FOLDED",
            message: format!(
                "{} of {faces} triangles are flipped in the parameter square even with mean-value weights (the exact cotangent weights flipped {}): the region has degenerate or overlapping triangles; repair_mesh it first",
                second_flips.0, first_flips.0
            ),
        });
    }
    Ok(accept(&second, &second_system, "mean_value", second_flips, first_flips.0))
}

#[cfg(test)]
mod tests {
    use super::harmonic_map;

    /// A `n` x `n` square grid of side 1 in the plane z = 0, two triangles per cell, counter-clockwise.
    fn grid(n: usize) -> (Vec<f64>, Vec<u32>) {
        let mut positions = Vec::new();
        for j in 0..=n {
            for i in 0..=n {
                positions.extend([i as f64 / n as f64, j as f64 / n as f64, 0.0]);
            }
        }
        let id = |i: usize, j: usize| (j * (n + 1) + i) as u32;
        let mut triangles = Vec::new();
        for j in 0..n {
            for i in 0..n {
                triangles.extend([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
            }
        }
        (positions, triangles)
    }

    #[test]
    fn a_square_grid_maps_onto_itself() {
        let (positions, triangles) = grid(8);
        let map = harmonic_map(&positions, &triangles, None).expect("a grid is a disk");
        assert_eq!(map.weights, "cotangent");
        assert_eq!(map.flipped_first, 0);
        assert_eq!(map.vertices.len(), 81);
        for (v, uv) in map.vertices.iter().zip(&map.uv) {
            let (x, y) = (positions[3 * *v as usize], positions[3 * *v as usize + 1]);
            // the map may be a symmetry of the square (the corners are chosen on the boundary), so compare the distance from the centre
            assert!(((uv[0] - 0.5).abs() - (x - 0.5).abs()).abs() < 1e-6 || ((uv[0] - 0.5).abs() - (y - 0.5).abs()).abs() < 1e-6);
        }
    }

    #[test]
    fn the_refusals_carry_the_codes_of_the_command() {
        let (positions, mut triangles) = grid(4);
        triangles.extend_from_within(0..3);
        assert_eq!(harmonic_map(&positions, &triangles, None).unwrap_err().code, "MESH_FIT_NOT_DISK");
        let (positions, triangles) = grid(8);
        let starved = harmonic_map(&positions, &triangles, Some(1)).unwrap_err();
        assert_eq!(starved.code, "MESH_FIT_PARAM_FOLDED");
        assert!(starved.message.contains("budget 1 per coordinate"), "{}", starved.message);
        assert_eq!(harmonic_map(&positions, &[], None).unwrap_err().message, "the region has no triangle");
    }
}
