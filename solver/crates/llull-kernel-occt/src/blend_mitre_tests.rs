//! BLD M2 mitre ends (TECHNICAL_SPEC 13.16): profile blends on creased tangent chains (the rim of an N-gon prism, a polyline outline). Every tolerance is
//! relative to the part; the volumes are compared with the swept section: with `A` the area of the removed section, `M` its first moment about the wall
//! (the integral of the distance from the wall) and `P` the perimeter of the rim, a mitred sweep along a closed polygon removes `A P - 2 M sum(s tan(turn / 2))`
//! (`s` is +1 where the rim turns toward the material).
use crate::features::{fillet_profile_blend, profile_blend_reason};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, make_prism, mass_properties, BooleanOp, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;
const SCALES: [f64; 4] = [1.0, 10.0, 100.0, 1000.0];
const TAU: f64 = std::f64::consts::TAU;

type Outline = Vec<(f64, f64)>;

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn volume_of(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

fn diagonal_of(bounds: &[f64]) -> f64 {
    (0..3).map(|axis| (bounds[3 + axis] - bounds[axis]).powi(2)).sum::<f64>().sqrt()
}

fn notes_of(shape: &Shape) -> Value {
    serde_json::from_str(&crate::features::shape_notes(shape).unwrap()).unwrap()
}

fn prism_of(points: &[(f64, f64)], depth: f64) -> Shape {
    let polygon: Vec<f64> = points.iter().flat_map(|p| [p.0, p.1, 0.0]).collect();
    make_prism(&polygon, [0.0, 0.0, depth]).unwrap().unwrap()
}

fn regular(sides: usize, radius: f64) -> Vec<(f64, f64)> {
    (0..sides).map(|k| (radius * (TAU * k as f64 / sides as f64).cos(), radius * (TAU * k as f64 / sides as f64).sin())).collect()
}

fn edge_near_mid(shape: &Shape, near: [f64; 3]) -> u32 {
    let topo = topology(shape).unwrap();
    let mut best = (f64::MAX, 0);
    for (index, edge) in topo["edges"].as_array().unwrap().iter().enumerate() {
        let d = (0..3).map(|axis| (num(&edge["mid"][axis]) - near[axis]).powi(2)).sum::<f64>().sqrt();
        if d < best.0 {
            best = (d, index);
        }
    }
    best.1 as u32
}

/// The edge of the polygon `points` from vertex `k` to the next, at height `z`.
fn side_edge(shape: &Shape, points: &[(f64, f64)], k: usize, z: f64) -> u32 {
    let (a, b) = (points[k], points[(k + 1) % points.len()]);
    edge_near_mid(shape, [(a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0, z])
}

fn blend(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Result<Shape, String> {
    let specs = if laws.chunks(4).all(|law| law[1].is_nan() && law[3] == 0.0) {
        edges.iter().zip(laws.chunks(4)).flat_map(|(edge, law)| [f64::from(*edge), kind, param, law[0], NAN, -1.0, 0.0]).collect()
    } else {
        Vec::new()
    };
    match fillet_profile_blend(shape, &specs, edges, laws, kind, param).unwrap() {
        Some(built) => Ok(built),
        None => Err(profile_blend_reason(shape, &specs, edges, laws, kind, param).unwrap()),
    }
}

fn built(shape: &Shape, edges: &[u32], size: f64, kind: f64, param: f64) -> Shape {
    blend(shape, edges, &[size, NAN, 0.0, 0.0], kind, param).unwrap_or_else(|why| panic!("refused: {why}"))
}

/// Area and first moment about the wall of the region a profile removes from a right-angle corner with legs `d`: the corner T = (0, 0), the contact
/// point A = (0, -d) on the wall, B = (d, 0) on the support. Kind 0 is the conic of weight rho / (1 - rho); kind 1 the degree 5 curvature section.
fn section(kind: f64, param: f64, d: f64) -> (f64, f64) {
    let (a, t, b) = ((0.0, -d), (0.0, 0.0), (d, 0.0));
    let along = |from: (f64, f64), to: (f64, f64), s: f64| (from.0 + (to.0 - from.0) * s, from.1 + (to.1 - from.1) * s);
    let (lead, reach) = (0.8 * param, 0.4 * param + 0.6);
    let poles = [a, along(a, t, lead), along(a, t, reach), along(b, t, reach), along(b, t, lead), b];
    let weight = param / (1.0 - param);
    let point = |u: f64| -> (f64, f64) {
        if kind == 0.0 {
            let basis = [(1.0 - u) * (1.0 - u), 2.0 * u * (1.0 - u) * weight, u * u];
            let sum: f64 = basis.iter().sum();
            ((basis[0] * a.0 + basis[1] * t.0 + basis[2] * b.0) / sum, (basis[0] * a.1 + basis[1] * t.1 + basis[2] * b.1) / sum)
        } else {
            let choose = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];
            let mut p = (0.0, 0.0);
            for (i, pole) in poles.iter().enumerate() {
                let bernstein = choose[i] * u.powi(i as i32) * (1.0 - u).powi(5 - i as i32);
                p = (p.0 + bernstein * pole.0, p.1 + bernstein * pole.1);
            }
            p
        }
    };
    let n = 200_000;
    let (mut area, mut moment, mut last) = (0.0, 0.0, point(0.0));
    for k in 1..=n {
        let now = point(k as f64 / n as f64);
        let dz = now.1 - last.1;
        area += 0.5 * (last.0 + now.0) * dz;
        moment += 0.25 * (last.0 * last.0 + now.0 * now.0) * dz;
        last = now;
    }
    (area, moment)
}

/// Perimeter of the closed polygon and sum of s tan(turn / 2) over its corners (s = +1 where it turns left, toward the inside of a ccw polygon).
fn perimeter_and_turns(points: &[(f64, f64)]) -> (f64, f64) {
    let n = points.len();
    let (mut perimeter, mut turns) = (0.0, 0.0);
    for k in 0..n {
        let (p, q, r) = (points[(k + n - 1) % n], points[k], points[(k + 1) % n]);
        perimeter += ((r.0 - q.0).powi(2) + (r.1 - q.1).powi(2)).sqrt();
        let (e1, e2) = ((q.0 - p.0, q.1 - p.1), (r.0 - q.0, r.1 - q.1));
        turns += ((e1.0 * e2.1 - e1.1 * e2.0).atan2(e1.0 * e2.0 + e1.1 * e2.1) / 2.0).tan();
    }
    (perimeter, turns)
}

/// What a mitred section sweep along the whole polygon changes: negative when it removes material (`convex`), positive when it adds.
fn swept(points: &[(f64, f64)], kind: f64, param: f64, size: f64, convex: bool) -> f64 {
    let (area, moment) = section(kind, param, size);
    let (perimeter, turns) = perimeter_and_turns(points);
    if convex {
        -(area * perimeter - 2.0 * moment * turns)
    } else {
        area * perimeter + 2.0 * moment * turns
    }
}

/// G0 and G1 readings over edges that meet within 0.5 rad at every sample.
#[derive(Default)]
struct Contacts {
    g0: f64,
    g1: f64,
    count: usize,
}

/// The contacts with the support faces and, apart, the junctions between two blends (an edge whose name has two blend faces).
fn contacts(shape: &Shape) -> (Contacts, Contacts) {
    let topo = topology(shape).unwrap();
    let edges = topo["edges"].as_array().unwrap();
    let (mut supports, mut junctions) = (Contacts::default(), Contacts::default());
    for (edge, entry) in edges.iter().enumerate() {
        let Some(samples) = edge_continuity(shape, edge as f64, 9.0).unwrap().as_array().cloned() else { continue };
        if samples.iter().any(|sample| num(&sample["g1"]) > 0.5) {
            continue;
        }
        // edges of the part itself (the sharp edge between two walls) are not blend edges: skipped
        let found = match entry["name"].as_str().unwrap_or_default().matches("blend(").count() {
            0 => continue,
            1 => &mut supports,
            _ => &mut junctions,
        };
        found.count += 1;
        for sample in samples {
            found.g0 = found.g0.max(num(&sample["g0"]));
            found.g1 = found.g1.max(num(&sample["g1"]));
        }
    }
    (supports, junctions)
}

fn assert_mitred(result: &Shape, expected_change: f64, before: f64, turn: f64, label: &str) {
    let mass = mass_properties(result).unwrap();
    let change = mass.volume - before;
    assert!((change - expected_change).abs() < 1e-6 * expected_change.abs(), "{label}: changed {change} vs {expected_change}");
    let notes = notes_of(result);
    assert_eq!(notes["builder"], "rails", "{label}");
    assert!(num(&notes["gap"]) <= num(&notes["gapLimit"]), "{label}: {notes}");
    assert!((num(&notes["creaseRad"]) - turn).abs() < 2e-3, "{label}: crease {} vs turn {turn}", num(&notes["creaseRad"]));
    assert!(num(&notes["junctionG1"]) <= num(&notes["creaseRad"]) + 0.0095, "{label}: {notes}");
    let (supports, junctions) = contacts(result);
    let limit = 5e-6 * diagonal_of(&mass.bounds);
    // the contacts with the supports are tangent; the junctions between blends carry the crease of the part (the larger of their normals' angles)
    assert!(supports.count > 0 && junctions.count > 0, "{label}: {} contacts, {} junctions", supports.count, junctions.count);
    assert!(supports.g0 < limit && supports.g1 < 1e-5, "{label}: supports g0 {} g1 {}", supports.g0, supports.g1);
    assert!(junctions.g0 < limit && junctions.g1 < turn + 0.0095, "{label}: junctions g0 {} g1 {}", junctions.g0, junctions.g1);
}

fn scaled(points: &[(f64, f64)], scale: f64) -> Vec<(f64, f64)> {
    points.iter().map(|p| (p.0 * scale, p.1 * scale)).collect()
}

#[test]
fn a_64_gon_rim_gets_conic_and_curvature_mitres_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        for (kind, param) in [(0.0, 0.5), (1.0, 0.5)] {
            let points = regular(64, 50.0 * scale);
            let shape = prism_of(&points, 20.0 * scale);
            let result = built(&shape, &[side_edge(&shape, &points, 0, 20.0 * scale)], scale, kind, param);
            let expected = swept(&points, kind, param, scale, true);
            assert_mitred(&result, expected, volume_of(&shape), TAU / 64.0, &format!("scale {scale} kind {kind}"));
        }
    }
}

#[test]
fn a_120_gon_rim_builds_at_the_smallest_and_largest_size() {
    let _serial = crate::serial_blends();
    for scale in [1.0, 1000.0] {
        let points = regular(120, 50.0 * scale);
        let shape = prism_of(&points, 20.0 * scale);
        let result = built(&shape, &[side_edge(&shape, &points, 7, 20.0 * scale)], scale, 0.0, 0.5);
        assert_mitred(&result, swept(&points, 0.0, 0.5, scale, true), volume_of(&shape), TAU / 120.0, &format!("120-gon at {scale}"));
    }
}

#[test]
fn the_concave_foot_ring_of_a_64_gon_boss_gets_the_mitred_spandrel_added() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let points = regular(64, 50.0 * scale);
        let plate = make_box([-100.0 * scale, -100.0 * scale, 0.0], [200.0 * scale, 200.0 * scale, 10.0 * scale]).unwrap().unwrap();
        let fused = boolean(BooleanOp::Union, &plate, &prism_of(&points, 30.0 * scale), true).unwrap().unwrap();
        for (kind, param) in [(0.0, 0.4), (1.0, 0.5)] {
            let result = built(&fused, &[side_edge(&fused, &points, 5, 10.0 * scale)], scale, kind, param);
            let expected = swept(&points, kind, param, scale, false);
            assert!(expected > 0.0);
            assert_mitred(&result, expected, volume_of(&fused), TAU / 64.0, &format!("boss at {scale} kind {kind}"));
        }
    }
}

/// A closed outline whose turns are of both signs (reflex corners among convex ones), the sharpest 0.086 rad.
fn wavy_outline() -> Vec<(f64, f64)> {
    let sides = 240;
    (0..sides)
        .map(|k| {
            let a = TAU * k as f64 / sides as f64;
            let r = 50.0 * (1.0 + 0.1 * (5.0 * a).sin());
            (r * a.cos(), r * a.sin())
        })
        .collect()
}

#[test]
fn a_wavy_outline_with_reflex_and_convex_creases_is_mitred_with_signed_turns() {
    let _serial = crate::serial_blends();
    let points = wavy_outline();
    let (_, turns) = perimeter_and_turns(&points);
    assert!(turns > 0.0);
    for scale in [1.0, 100.0] {
        let outline = scaled(&points, scale);
        let shape = prism_of(&outline, 20.0 * scale);
        let result = built(&shape, &[side_edge(&shape, &outline, 3, 20.0 * scale)], 0.5 * scale, 0.0, 0.5);
        let notes = notes_of(&result);
        let expected = swept(&outline, 0.0, 0.5, 0.5 * scale, true);
        let change = volume_of(&result) - volume_of(&shape);
        assert!((change - expected).abs() < 1e-6 * expected.abs(), "wavy at {scale}: {change} vs {expected}");
        assert!(num(&notes["gap"]) <= num(&notes["gapLimit"]), "{notes}");
        assert!(num(&notes["creaseRad"]) > 0.05 && num(&notes["creaseRad"]) < 0.099, "{notes}");
        assert!(num(&notes["junctionG1"]) <= num(&notes["creaseRad"]) + 0.0095, "{notes}");
    }
}

/// A bar whose rim path is three segments of 30 turning by `turn` at both bends (left when positive), with square end walls.
fn bent_bar(turn: f64, scale: f64) -> (Outline, Outline) {
    let angles = [0.0, turn, 2.0 * turn];
    let mut lower = vec![(0.0, 0.0)];
    for a in angles {
        let last = *lower.last().unwrap();
        lower.push((last.0 + 30.0 * scale * a.cos(), last.1 + 30.0 * scale * a.sin()));
    }
    let normal = |a: f64| (-a.sin(), a.cos());
    let height = 20.0 * scale;
    let mut upper = Vec::new();
    for (k, point) in lower.iter().enumerate() {
        let offset = if k == 0 {
            normal(angles[0])
        } else if k == angles.len() {
            normal(angles[k - 1])
        } else {
            let (n0, n1) = (normal(angles[k - 1]), normal(angles[k]));
            let scale_mitre = 1.0 / (1.0 + n0.0 * n1.0 + n0.1 * n1.1);
            ((n0.0 + n1.0) * scale_mitre, (n0.1 + n1.1) * scale_mitre)
        };
        upper.push((point.0 + height * offset.0, point.1 + height * offset.1));
    }
    let mut outline = lower.clone();
    outline.extend(upper.iter().rev());
    (outline, lower)
}

#[test]
fn a_bent_bar_at_the_creases_occt_still_chains_is_mitred_between_its_square_end_walls() {
    let _serial = crate::serial_blends();
    for turn in [0.099, -0.099] {
        for scale in SCALES {
            let (outline, lower) = bent_bar(turn, scale);
            let shape = prism_of(&outline, 10.0 * scale);
            let edge = side_edge(&shape, &lower, 1, 10.0 * scale);
            for (kind, param) in [(0.0, 0.5), (1.0, 0.5)] {
                let result = built(&shape, &[edge], scale, kind, param);
                let (area, moment) = section(kind, param, scale);
                // the rim path is the three segments (90 long); each bend turns toward the material for a left turn
                let expected = -(area * 90.0 * scale - 2.0 * moment * 2.0 * (turn / 2.0_f64).tan());
                let change = volume_of(&result) - volume_of(&shape);
                assert!((change - expected).abs() < 1e-6 * expected.abs(), "bar {turn} at {scale} kind {kind}: {change} vs {expected}");
                let notes = notes_of(&result);
                assert!(num(&notes["gap"]) <= num(&notes["gapLimit"]), "{notes}");
                assert!((num(&notes["creaseRad"]) - turn.abs()).abs() < 2e-3, "{notes}");
            }
        }
    }
}

#[test]
fn a_crease_occt_does_not_chain_ends_the_blend_on_the_next_wall_and_is_refused_with_the_angle() {
    let _serial = crate::serial_blends();
    let (outline, lower) = bent_bar(0.1005, 1.0);
    let shape = prism_of(&outline, 10.0);
    let why = blend(&shape, &[side_edge(&shape, &lower, 1, 10.0)], &[1.0, NAN, 0.0, 0.0], 0.0, 0.5).err().unwrap();
    assert!(why.contains("ends obliquely") && why.contains("0.1005") && why.contains("about 0.1 rad"), "{why}");
}

#[test]
fn a_varying_size_on_a_creased_chain_is_refused_because_occt_cannot_round_it() {
    let _serial = crate::serial_blends();
    let points = regular(64, 50.0);
    let shape = prism_of(&points, 20.0);
    let edge = side_edge(&shape, &points, 0, 20.0);
    for kind in [0.0, 1.0] {
        let why = blend(&shape, &[edge], &[1.0, 1.5, 0.0, 0.0], kind, 0.5).err().unwrap();
        assert!(why.contains("circular blend the profile is cut from could not be built"), "{why}");
    }
}

#[test]
fn a_size_given_as_a_range_on_a_creased_chain_is_refused_as_not_constant() {
    let _serial = crate::serial_blends();
    let points = regular(64, 50.0);
    let shape = prism_of(&points, 20.0);
    let edge = side_edge(&shape, &points, 0, 20.0);
    // 1 -> 1 builds as a circular blend (a range law) but the mitre is exact for a constant size only
    let why = blend(&shape, &[edge], &[1.0, 1.0, 0.0, 0.0], 0.0, 0.5).err().unwrap();
    assert!(why.contains("needs a single radius") && why.contains("even 1 -> 1"), "{why}");
}

#[test]
fn a_blend_too_short_for_its_mitre_states_the_rule_and_the_values() {
    let _serial = crate::serial_blends();
    // sides of 0.29 with a blend of 1: the half of a blend (0.147) is less than 4 x the displacement (4 x 0.049)
    let points = regular(64, 3.0);
    let shape = prism_of(&points, 20.0);
    let why = blend(&shape, &[side_edge(&shape, &points, 0, 20.0)], &[1.0, NAN, 0.0, 0.0], 0.0, 0.5).err().unwrap();
    assert!(why.contains("too short for its mitre: half of it (0.14") && why.contains("at least 4 x the displacement"), "{why}");
}

#[test]
fn a_step_that_mixes_a_mitred_chain_and_tangent_arcs_keeps_the_plain_limit_on_the_smooth_junctions() {
    let _serial = crate::serial_blends();
    // a bent bar whose four outline corners are rounded: the rim chain turns across 0.09 rad at four bends and runs tangent through four arcs
    let (outline, lower) = bent_bar(0.09, 1.0);
    let bar = prism_of(&outline, 10.0);
    let corners: Vec<u32> = [0, 3, 4, 7].iter().map(|k| edge_near_mid(&bar, [outline[*k].0, outline[*k].1, 5.0])).collect();
    let rounded = crate::features::fillet(&bar, &corners, 3.0, None).unwrap().unwrap();
    let edge = edge_near_mid(&rounded, [(lower[1].0 + lower[2].0) / 2.0, (lower[1].1 + lower[2].1) / 2.0, 10.0]);
    let result = built(&rounded, &[edge], 1.0, 0.0, 0.5);
    let notes = notes_of(&result);
    assert!((num(&notes["creaseRad"]) - 0.09).abs() < 2e-3, "{notes}");
    // A smooth junction between 0.0095 and 0.0095 + the crease cannot be reached natively (the arcs here are exact tangents), so the check that a
    // mitred chain does not widen the limit of its smooth junctions is the unit test of check_blends (tests/unit/blendJunctionVerdict.test.ts).
    // the junctions of the arcs are smooth: each stays within the plain 0.0095; the four bends carry their crease
    let topo = topology(&result).unwrap();
    let (mut smooth, mut creased) = (0, 0);
    for (edge, entry) in topo["edges"].as_array().unwrap().iter().enumerate() {
        if entry["name"].as_str().unwrap_or_default().matches("blend(").count() < 2 {
            continue;
        }
        let samples = edge_continuity(&result, edge as f64, 9.0).unwrap();
        let largest = samples.as_array().unwrap().iter().map(|s| num(&s["g1"])).fold(0.0, f64::max);
        if largest > 0.05 {
            creased += 1;
        } else {
            assert!(largest <= 0.0095, "smooth junction {edge} reads {largest}");
            smooth += 1;
        }
    }
    assert_eq!(creased, 4);
    assert!(smooth >= 8, "{smooth} smooth junctions");
}
