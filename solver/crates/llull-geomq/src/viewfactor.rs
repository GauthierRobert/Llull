//! Diffuse view-factor exchange between planar facets (PHY-03 TR-THM-20, RS1 RS-6), transliterated from
//! `packages/core/src/lib/viewFactorContour.ts` (contour integral, closed-form inner integral, adaptive 8-point Gauss-Legendre outer) and
//! `packages/core/src/geometry/viewFactorExchange.ts` (per-surface sums, centroid-segment obstruction). `Math.log` / `Math.atan` are the
//! V8 twins of `llull-jsmath`, so every exchange area is bit-identical to the TypeScript; facet pairs run in parallel and are summed in
//! the TypeScript order (owner a, then b).
//! The first three panels of every edge pair (what `adaptive` needs to decide; 98 % of the integrand values of a meshed cavity) are
//! evaluated as one batch (`panels.rs`: the same operations per value, so the same bits); deeper bisection and the rare branches run the
//! scalar transliteration below.
//! The obstruction test walks a box tree of the occluders instead of the TypeScript's brute-force loop (`occlusion.rs`): it only skips
//! triangles whose inflated box the segment cannot reach, so the boolean per pair is the same.

use crate::occlusion::Occluders;
use crate::panels::{first_panels, NODES, WEIGHTS};
use crate::triangle::{add, cross, dot, length, scale, sub, Vec3};
use llull_jsmath::{atan, log};
use rayon::prelude::*;

const TOLERANCE: f64 = 1e-13;
const MAX_DEPTH: i32 = 48;
/// Emitting facets per parallel chunk: contributions of a chunk are buffered, then summed in order.
const CHUNK: usize = 64;

/// A planar triangle with its (emitting-side) unit normal, centroid and area, as the TypeScript `Facet` (values passed, not recomputed).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Facet {
    pub corners: [Vec3; 3],
    pub normal: Vec3,
    pub centroid: Vec3,
    pub area: f64,
}

fn x_log_abs(u: f64) -> f64 {
    if u == 0.0 {
        0.0
    } else {
        u * log(u.abs()) - u
    }
}

/// ∫_0^1 ln|w - t v| dt in closed form.
fn log_integral(w: &Vec3, v: &Vec3) -> f64 {
    let a = dot(v, v);
    if a == 0.0 {
        return log(length(w));
    }
    let wv = dot(w, v);
    let c = cross(w, v);
    let delta = 4.0 * dot(&c, &c);
    if delta == 0.0 {
        return 0.5 * log(a) + x_log_abs(1.0 - wv / a) - x_log_abs(-wv / a);
    }
    let b = -2.0 * wv;
    let root = delta.sqrt();
    let antiderivative = |t: f64| {
        let d = sub(w, &scale(v, t));
        let q = dot(&d, &d);
        let log_term = if q > 0.0 { (t + b / (2.0 * a)) * log(q) } else { 0.0 };
        log_term - 2.0 * t + (root / a) * atan((2.0 * a * t + b) / root)
    };
    0.5 * (antiderivative(1.0) - antiderivative(0.0))
}

fn gauss_legendre(f: &impl Fn(f64) -> f64, lo: f64, hi: f64) -> f64 {
    let half = 0.5 * (hi - lo);
    let mid = 0.5 * (hi + lo);
    let mut sum = 0.0;
    for k in 0..NODES.len() {
        let node = NODES[k] * half;
        sum += WEIGHTS[k] * (f(mid - node) + f(mid + node));
    }
    sum * half
}

fn adaptive(f: &impl Fn(f64) -> f64, lo: f64, hi: f64, whole: f64, tolerance: f64, depth: i32) -> f64 {
    let mid = 0.5 * (lo + hi);
    let left = gauss_legendre(f, lo, mid);
    let right = gauss_legendre(f, mid, hi);
    if depth <= 0 || (left + right - whole).abs() <= tolerance {
        return left + right;
    }
    adaptive(f, lo, mid, left, tolerance / 2.0, depth - 1) + adaptive(f, mid, hi, right, tolerance / 2.0, depth - 1)
}

/// ∫_0^1 ∫_0^1 ln|(a + s u) - (c + t v)| dt ds, every value from the scalar transliteration.
#[inline(never)]
fn edge_pair_integral_scalar(a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3) -> f64 {
    let inner = |s: f64| log_integral(&sub(&add(a, &scale(u, s)), c), v);
    adaptive(&inner, 0.0, 1.0, gauss_legendre(&inner, 0.0, 1.0), TOLERANCE, MAX_DEPTH)
}

/// The bisection of `adaptive(inner, 0, 1, whole, TOLERANCE, MAX_DEPTH)` once its first test failed.
#[inline(never)]
fn bisect_further(a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3, left: f64, right: f64) -> f64 {
    let inner = |s: f64| log_integral(&sub(&add(a, &scale(u, s)), c), v);
    adaptive(&inner, 0.0, 0.5, left, TOLERANCE / 2.0, MAX_DEPTH - 1) + adaptive(&inner, 0.5, 1.0, right, TOLERANCE / 2.0, MAX_DEPTH - 1)
}

/// ∫_0^1 ∫_0^1 ln|(a + s u) - (c + t v)| dt ds: the first step of `adaptive` from the batched panels, the rest as the scalar path.
#[inline(always)]
fn edge_pair_integral(a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3) -> f64 {
    if dot(v, v) == 0.0 {
        return edge_pair_integral_scalar(a, u, c, v);
    }
    let Some((whole, left, right)) = first_panels(a, u, c, v) else { return edge_pair_integral_scalar(a, u, c, v) };
    if (left + right - whole).abs() <= TOLERANCE {
        return left + right;
    }
    bisect_further(a, u, c, v, left, right)
}

/// True when each facet is in front of the other (centroid test).
pub fn facing(from: &Facet, to: &Facet) -> bool {
    dot(&from.normal, &sub(&to.centroid, &from.centroid)) > 0.0 && dot(&to.normal, &sub(&from.centroid, &to.centroid)) > 0.0
}

/// A_i F_ij (0 for facets that do not face each other).
pub fn exchange_area(from: &Facet, to: &Facet) -> f64 {
    if !facing(from, to) {
        return 0.0;
    }
    facing_exchange_area::<true>(from, to)
}

/// A_i F_ij of two facets that face each other; `BATCHED = false` is the scalar transliteration alone (the oracle of the tests).
#[inline(always)]
fn facing_exchange_area<const BATCHED: bool>(from: &Facet, to: &Facet) -> f64 {
    let mut sum = 0.0;
    for a in 0..3 {
        let start = &from.corners[a];
        let u = sub(&from.corners[(a + 1) % 3], start);
        for b in 0..3 {
            let origin = &to.corners[b];
            let v = sub(&to.corners[(b + 1) % 3], origin);
            let alignment = dot(&u, &v);
            if alignment != 0.0 {
                let integral =
                    if BATCHED { edge_pair_integral(start, &u, origin, &v) } else { edge_pair_integral_scalar(start, &u, origin, &v) };
                sum += alignment * integral;
            }
        }
    }
    sum / (2.0 * std::f64::consts::PI)
}

/// The contributions of one emitting facet, in receiving order: (surface of the receiver, A_i F_ij). A `pulp` operation (not a closure:
/// the body must be inlined into the function compiled for the dispatched instruction set, and a large closure is not).
struct Row<'a> {
    owners: &'a [(usize, Facet)],
    occluders: Option<&'a Occluders>,
    emitter: usize,
}

impl pulp::WithSimd for Row<'_> {
    type Output = Vec<(usize, f64)>;

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, _simd: S) -> Self::Output {
        let (surface_a, a) = &self.owners[self.emitter];
        let mut out = Vec::new();
        for (j, (surface_b, b)) in self.owners.iter().enumerate() {
            let visible = surface_a != surface_b
                && facing(a, b)
                && self.occluders.is_none_or(|o| !o.blocked(&a.centroid, &b.centroid, [self.emitter, j]));
            if visible {
                out.push((*surface_b, facing_exchange_area::<true>(a, b)));
            }
        }
        out
    }
}

/// Exchange matrix A_I F_IJ (row-major, `surfaces` × `surfaces`) of `owners` (facet, surface index; surface-major order). With
/// `blockers = Some(..)` a facet pair is dropped when the open segment between the centroids crosses another occluder (every owner facet,
/// then the blockers; the pair's own two facets are skipped). Same pairs, same order and same sums as the TypeScript reference.
pub fn exchange_matrix(owners: &[(usize, Facet)], blockers: Option<&[Facet]>, surfaces: usize) -> Vec<f64> {
    let occluders =
        blockers.map(|extra| Occluders::new(owners.iter().map(|(_, f)| f.corners).chain(extra.iter().map(|f| f.corners)).collect()));
    let mut exchange = vec![0.0; surfaces * surfaces];
    // the widest instruction set pulp knows on this CPU (AVX2 on x86-64); same bits on every set: no contraction, no fast-math
    let arch = pulp::Arch::new();
    let indices: Vec<usize> = (0..owners.len()).collect();
    for chunk in indices.chunks(CHUNK) {
        let rows: Vec<Vec<(usize, f64)>> =
            chunk.par_iter().map(|&emitter| arch.dispatch(Row { owners, occluders: occluders.as_ref(), emitter })).collect();
        for (&i, row) in chunk.iter().zip(&rows) {
            let surface_a = owners[i].0;
            for &(surface_b, value) in row {
                exchange[surface_a * surfaces + surface_b] += value;
            }
        }
    }
    exchange
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facet(a: Vec3, b: Vec3, c: Vec3) -> Facet {
        let n = cross(&sub(&b, &a), &sub(&c, &a));
        let twice = length(&n);
        Facet { corners: [a, b, c], normal: scale(&n, 1.0 / twice), centroid: scale(&add(&add(&a, &b), &c), 1.0 / 3.0), area: twice / 2.0 }
    }

    /// Two unit squares 1 apart facing each other: F = 0.1998 (closed form, Incropera Table 13.2).
    fn plates() -> Vec<(usize, Facet)> {
        vec![
            (0, facet([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0])),
            (0, facet([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0])),
            (1, facet([0.0, 0.0, 1.0], [1.0, 1.0, 1.0], [1.0, 0.0, 1.0])),
            (1, facet([0.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 1.0, 1.0])),
        ]
    }

    #[test]
    fn parallel_plates_match_the_closed_form() {
        let exchange = exchange_matrix(&plates(), None, 2);
        assert!((exchange[1] - 0.199_825).abs() < 1e-5, "{}", exchange[1]);
        assert_eq!(exchange[0], 0.0);
        assert!((exchange[1] - exchange[2]).abs() < 1e-12);
    }

    #[test]
    fn a_blocker_between_the_plates_shadows_every_pair() {
        let wall =
            [facet([-1.0, -1.0, 0.5], [2.0, -1.0, 0.5], [2.0, 2.5, 0.5]), facet([-1.0, -1.0, 0.5], [2.0, 2.5, 0.5], [-1.0, 2.5, 0.5])];
        assert_eq!(exchange_matrix(&plates(), Some(&wall), 2), vec![0.0; 4]);
        assert_eq!(exchange_matrix(&plates(), Some(&[]), 2), exchange_matrix(&plates(), None, 2));
    }

    /// xorshift64* in [0, 1).
    fn uniform(seed: u64) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            (state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / 9_007_199_254_740_992.0
        }
    }

    /// The walls of the cube [0, size]^3 seen from inside (surface = wall), `n` x `n` cells of two triangles each.
    fn cavity(n: usize, size: f64) -> Vec<(usize, Facet)> {
        let mut out = Vec::new();
        for axis in 0..3 {
            for (side, high) in [(0.0, false), (size, true)] {
                let point = |a: usize, b: usize| {
                    let mut p = [side; 3];
                    p[(axis + 1) % 3] = size * a as f64 / n as f64;
                    p[(axis + 2) % 3] = size * b as f64 / n as f64;
                    p
                };
                for a in 0..n {
                    for b in 0..n {
                        let quad = [point(a, b), point(a + 1, b), point(a + 1, b + 1), point(a, b + 1)];
                        let surface = axis * 2 + usize::from(high);
                        // inward normals: +axis on the low wall, -axis on the high wall
                        let pairs = if high { [[0, 2, 1], [0, 3, 2]] } else { [[0, 1, 2], [0, 2, 3]] };
                        out.extend(pairs.map(|[i, j, k]| (surface, facet(quad[i], quad[j], quad[k]))));
                    }
                }
            }
        }
        out
    }

    /// The reference loop: every value from the scalar transliteration, obstruction by brute force, sums in the TypeScript order.
    fn scalar_matrix(owners: &[(usize, Facet)], blockers: Option<&[Facet]>, surfaces: usize) -> Vec<f64> {
        let occluders: Vec<&Facet> = owners.iter().map(|(_, f)| f).chain(blockers.unwrap_or(&[])).collect();
        let mut exchange = vec![0.0; surfaces * surfaces];
        for (i, (surface_a, a)) in owners.iter().enumerate() {
            for (j, (surface_b, b)) in owners.iter().enumerate() {
                let hidden = blockers.is_some()
                    && occluders
                        .iter()
                        .enumerate()
                        .any(|(k, o)| k != i && k != j && crate::triangle::segment_hits_triangle(&a.centroid, &b.centroid, &o.corners));
                if surface_a != surface_b && facing(a, b) && !hidden {
                    exchange[surface_a * surfaces + surface_b] += facing_exchange_area::<false>(a, b);
                }
            }
        }
        exchange
    }

    fn bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|v| v.to_bits()).collect()
    }

    #[test]
    fn the_batched_matrix_of_a_meshed_cavity_is_the_scalar_one_bit_for_bit() {
        for size in [1.0, 0.037, 2500.0] {
            let owners = cavity(3, size);
            let baffle = [
                facet([0.3 * size, 0.3 * size, 0.5 * size], [0.7 * size, 0.3 * size, 0.5 * size], [0.7 * size, 0.7 * size, 0.5 * size]),
                facet([0.3 * size, 0.3 * size, 0.5 * size], [0.7 * size, 0.7 * size, 0.5 * size], [0.3 * size, 0.7 * size, 0.5 * size]),
            ];
            let free = exchange_matrix(&owners, None, 6);
            assert_eq!(bits(&free), bits(&scalar_matrix(&owners, None, 6)), "size {size}");
            let shadowed = exchange_matrix(&owners, Some(&baffle), 6);
            assert_eq!(bits(&shadowed), bits(&scalar_matrix(&owners, Some(&baffle), 6)), "size {size}, baffle");
            assert_ne!(bits(&shadowed), bits(&free));
            // closed cavity: every row of F sums to 1 (A = size^2 per wall)
            for row in free.chunks(6) {
                assert!((row.iter().sum::<f64>() / (size * size) - 1.0).abs() < 1e-9, "{row:?}");
            }
        }
    }

    #[test]
    fn batched_and_scalar_pairs_agree_on_touching_degenerate_and_random_facets() {
        let mut next = uniform(0x0DDB_1A5E_5BAD_5EED);
        let mut point = |spread: f64| [(next() - 0.5) * spread, (next() - 0.5) * spread, (next() - 0.5) * spread];
        let mut pairs: Vec<(Facet, Facet)> = Vec::new();
        for k in 0..600 {
            let spread = [1.0, 1e-3, 1e4][k % 3];
            let (a, b, c) = (point(spread), point(spread), point(spread));
            let first = facet(a, b, c);
            let (d, e, f) = (point(spread), point(spread), point(spread));
            pairs.push((first, facet(d, e, f)));
            // a shared edge (collinear closed form), a shared corner, an edge on the line of another, a zero-length edge
            pairs.push((first, facet(b, a, d)));
            pairs.push((first, facet(a, d, e)));
            pairs.push((first, facet(add(&a, &scale(&sub(&b, &a), 2.0)), add(&a, &scale(&sub(&b, &a), 3.5)), d)));
            pairs.push((first, Facet { corners: [d, d, e], ..first }));
            pairs.push((first, facet(d, add(&d, &sub(&b, &a)), add(&d, &sub(&c, &a)))));
        }
        let mut bisected = 0;
        for (k, (from, to)) in pairs.iter().enumerate() {
            let batched = facing_exchange_area::<true>(from, to);
            assert_eq!(batched.to_bits(), facing_exchange_area::<false>(from, to).to_bits(), "pair {k}");
            let u = sub(&from.corners[1], &from.corners[0]);
            let v = sub(&to.corners[1], &to.corners[0]);
            let panels = first_panels(&from.corners[0], &u, &to.corners[0], &v);
            bisected += usize::from(panels.is_some_and(|(whole, left, right)| (left + right - whole).abs() > TOLERANCE));
        }
        assert!(bisected > 100, "{bisected}");
    }
}
