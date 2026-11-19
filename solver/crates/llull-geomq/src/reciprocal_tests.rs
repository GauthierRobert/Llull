//! `Integration::Reciprocal` (PERF1 §5 row 4): the pair rule against `Full`, its single panel against the scalar transliteration, and
//! the measured distance to `Full` on meshed cavities.

use super::tests::{bits, cavity, facet, plates, uniform};
use super::*;

fn baffle(size: f64) -> [Facet; 2] {
    [
        facet([0.3 * size, 0.3 * size, 0.5 * size], [0.7 * size, 0.3 * size, 0.5 * size], [0.7 * size, 0.7 * size, 0.5 * size]),
        facet([0.3 * size, 0.3 * size, 0.5 * size], [0.7 * size, 0.7 * size, 0.5 * size], [0.3 * size, 0.7 * size, 0.5 * size]),
    ]
}

fn occluders(owners: &[(usize, Facet)], extra: &[Facet]) -> Occluders {
    Occluders::new(owners.iter().map(|(_, f)| f.corners).chain(extra.iter().map(|f| f.corners)).collect())
}

/// Largest |a - b| / max|b| over the entries, and over the row sums.
fn distance(a: &[f64], b: &[f64], surfaces: usize) -> (f64, f64) {
    let entry = a.iter().zip(b).map(|(x, y)| if *y == 0.0 { x.abs() } else { ((x - y) / y).abs() }).fold(0.0, f64::max);
    let rows = a
        .chunks(surfaces)
        .zip(b.chunks(surfaces))
        .map(|(x, y)| ((x.iter().sum::<f64>() - y.iter().sum::<f64>()) / y.iter().sum::<f64>()).abs())
        .fold(0.0, f64::max);
    (entry, rows)
}

#[test]
fn parallel_plates_and_a_full_blocker() {
    let exchange = exchange_matrix(&plates(), None, 2, Integration::Reciprocal);
    assert!((exchange[1] - 0.199_825).abs() < 1e-5, "{}", exchange[1]);
    assert_eq!(exchange[0], 0.0);
    assert_eq!(exchange[1].to_bits(), exchange[2].to_bits());
    let wall = [facet([-1.0, -1.0, 0.5], [2.0, -1.0, 0.5], [2.0, 2.5, 0.5]), facet([-1.0, -1.0, 0.5], [2.0, 2.5, 0.5], [-1.0, 2.5, 0.5])];
    assert_eq!(exchange_matrix(&plates(), Some(&wall), 2, Integration::Reciprocal), vec![0.0; 4]);
    assert_eq!(exchange_matrix(&plates(), Some(&[]), 2, Integration::Reciprocal), exchange);
}

/// Without the single panel (no pair is ever "well separated") the rule only shares each pair's integral: the upper triangle is
/// `Full`'s bit for bit (same values, same order), obstruction included, and the lower triangle mirrors it wherever `Full` sees the
/// pair from both sides.
#[test]
fn without_the_single_panel_the_upper_triangle_is_full_bit_for_bit() {
    for size in [1.0, 0.037, 2500.0] {
        let owners = cavity(3, size);
        for extra in [None, Some(baffle(size))] {
            let tree = extra.as_ref().map(|b| occluders(&owners, b));
            let full = exchange_matrix(&owners, extra.as_ref().map(|b| &b[..]), 6, Integration::Full);
            let shared = reciprocal_matrix(&owners, tree.as_ref(), 6, f64::INFINITY);
            for i in 0..6 {
                for j in i + 1..6 {
                    assert_eq!(shared[i * 6 + j].to_bits(), full[i * 6 + j].to_bits(), "size {size}, [{i}][{j}]");
                    assert!((shared[j * 6 + i] - full[j * 6 + i]).abs() <= 1e-12 * full[j * 6 + i].abs(), "size {size}, [{j}][{i}]");
                }
                assert_eq!(shared[i * 6 + i], 0.0);
            }
            if extra.is_none() {
                for i in 0..6 {
                    for j in 0..6 {
                        assert_eq!(shared[i * 6 + j].to_bits(), shared[j * 6 + i].to_bits());
                    }
                }
            }
        }
    }
}

#[test]
fn the_batched_single_panel_is_the_scalar_one_bit_for_bit() {
    let mut next = uniform(0x0005_EED0_FAC0_FFEE);
    let mut point = |spread: f64| [(next() - 0.5) * spread, (next() - 0.5) * spread, (next() - 0.5) * spread];
    let mut scalar_lanes = 0;
    for k in 0..900 {
        let spread = [1.0, 1e-3, 1e4][k % 3];
        let (a, b, c) = (point(spread), point(spread), point(spread));
        let first = facet(a, b, c);
        let offset = scale(&point(1.0), 40.0 * spread);
        let (d, e, f) = (add(&point(spread), &offset), add(&point(spread), &offset), add(&point(spread), &offset));
        // far, near, a zero-length edge and an edge on the line of another (the collinear closed form: the scalar path)
        let along = add(&a, &scale(&sub(&b, &a), 9.0));
        for to in [
            facet(d, e, f),
            facet(point(spread), point(spread), point(spread)),
            Facet { corners: [d, d, e], ..first },
            facet(along, add(&along, &sub(&b, &a)), d),
        ] {
            let batched = facing_exchange_area::<true, true>(&first, &to);
            assert_eq!(batched.to_bits(), facing_exchange_area::<false, true>(&first, &to).to_bits(), "pair {k}");
            let v = sub(&to.corners[1], &to.corners[0]);
            scalar_lanes += usize::from(dot(&v, &v) == 0.0 || whole_panel(&first.corners[0], &sub(&b, &a), &to.corners[0], &v).is_none());
        }
    }
    assert!(scalar_lanes > 900, "{scalar_lanes}");
}

/// The criterion: every edge-pair integral of a well-separated pair by one panel is the adaptive one within 5e-14 x max(1, |value|)
/// (the bound in `SEPARATION`: about 2.5e-14, plus the rounding of the closed form, which grows with |ln r|), on random
/// triangles of every shape and three length scales, just beyond the threshold.
#[test]
fn one_panel_is_enough_beyond_the_separation() {
    let mut next = uniform(0xC0DE_D00D_1234_5678);
    let mut point = |spread: f64| [(next() - 0.5) * spread, (next() - 0.5) * spread, (next() - 0.5) * spread];
    let (mut worst, mut tested) = (0.0f64, 0);
    for k in 0..4000 {
        let spread = [1.0, 1e-3, 1e4][k % 3];
        let first = facet(point(spread), point(spread), point(spread));
        let raw = facet(point(spread), point(spread), point(spread));
        // move the second facet along a random direction until the pair sits on the threshold (x 1 .. 1.3)
        let direction = point(1.0);
        let unit = scale(&direction, 1.0 / length(&direction));
        let reach = SEPARATION * (radius(&first) + radius(&raw)) * (1.0 + 0.3 * (k % 7) as f64 / 6.0) * 1.000_001;
        let shift = sub(&add(&first.centroid, &scale(&unit, reach)), &raw.centroid);
        let to = facet(add(&raw.corners[0], &shift), add(&raw.corners[1], &shift), add(&raw.corners[2], &shift));
        if !well_separated(&first, radius(&first), &to, radius(&to), SEPARATION) {
            continue;
        }
        tested += 1;
        for a in 0..3 {
            let u = sub(&first.corners[(a + 1) % 3], &first.corners[a]);
            for b in 0..3 {
                let v = sub(&to.corners[(b + 1) % 3], &to.corners[b]);
                let panel = edge_pair_panel_scalar(&first.corners[a], &u, &to.corners[b], &v);
                let adaptive = edge_pair_integral_scalar(&first.corners[a], &u, &to.corners[b], &v);
                worst = worst.max((panel - adaptive).abs() / adaptive.abs().max(1.0));
            }
        }
    }
    assert!(tested > 3900, "{tested}");
    assert!(worst < 5e-14, "{worst:e}");
}

/// Distance to `Full` on meshed cube cavities (192 and 768 facets), free and with a baffle: entries within 1e-12 relative, row sums
/// within 2e-13 (measured 3e-14 and 8e-15; 7e-14 and 2e-14 at 3 072 facets); every row of F still sums to 1.
#[test]
fn a_meshed_cavity_is_full_within_the_stated_tolerance() {
    for (n, size) in [(4, 1.0), (6, 0.037), (8, 2500.0)] {
        let owners = cavity(n, size);
        let blockers = baffle(size);
        for extra in [None, Some(&blockers[..])] {
            let full = exchange_matrix(&owners, extra, 6, Integration::Full);
            let reciprocal = exchange_matrix(&owners, extra, 6, Integration::Reciprocal);
            assert_ne!(bits(&full), bits(&reciprocal));
            let (entry, rows) = distance(&reciprocal, &full, 6);
            assert!(entry < 1e-12 && rows < 2e-13, "n {n}, size {size}: entries {entry:e}, row sums {rows:e}");
            if extra.is_none() {
                for row in reciprocal.chunks(6) {
                    assert!((row.iter().sum::<f64>() / (size * size) - 1.0).abs() < 1e-9, "{row:?}");
                }
            }
        }
        // the single panel is really used: most pairs of the fine cavity are well separated
        let radii: Vec<f64> = owners.iter().map(|(_, f)| radius(f)).collect();
        let separated = (0..owners.len())
            .flat_map(|i| (i + 1..owners.len()).map(move |j| (i, j)))
            .filter(|&(i, j)| well_separated(&owners[i].1, radii[i], &owners[j].1, radii[j], SEPARATION))
            .count();
        assert_eq!(separated > 0, n > 4, "n {n}: {separated}");
    }
}
