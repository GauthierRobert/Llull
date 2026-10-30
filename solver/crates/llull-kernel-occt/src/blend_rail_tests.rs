//! BLD M2: profile blends on curved edges and faces, with varying sizes, and corners of profile blends (`features::fillet_profile_blend`,
//! `cpp/blend_rails.cxx`, `cpp/blend_corner.cxx`). Every tolerance is relative to the part (its diagonal or its size), never absolute.

use crate::features::{fillet_profile_blend, fillet_rails, profile_blend_reason};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, make_cone, make_cylinder, make_sphere, mass_properties, BooleanOp, Shape};
use serde_json::Value;

const NAN: f64 = f64::NAN;
const SCALES: [f64; 4] = [1.0, 10.0, 100.0, 1000.0];

fn num(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

fn volume_of(shape: &Shape) -> f64 {
    mass_properties(shape).unwrap().volume
}

fn edges_where(shape: &Shape, keep: impl Fn(&Value) -> bool) -> Vec<u32> {
    let topo = topology(shape).unwrap();
    topo["edges"].as_array().unwrap().iter().enumerate().filter(|(_, edge)| keep(edge)).map(|(index, _)| index as u32).collect()
}

fn circles_at_height(shape: &Shape, height: f64, scale: f64) -> Vec<u32> {
    edges_where(shape, |e| e["curve"] == "circle" && (num(&e["mid"][2]) - height).abs() < 1e-9 * scale)
}

/// Contact measurements over every edge shared by two faces that meet tangentially (g1 under 0.5 rad at every sample).
struct Contacts {
    g0: f64,
    g1: f64,
    /// Largest |k1 - k2| over the contacts (curvature jump, 1 / length).
    g2: f64,
    count: usize,
}

fn contacts(shape: &Shape) -> Contacts {
    let count = topology(shape).unwrap()["edges"].as_array().unwrap().len();
    let mut found = Contacts { g0: 0.0, g1: 0.0, g2: 0.0, count: 0 };
    for edge in 0..count {
        let Some(samples) = edge_continuity(shape, edge as f64, 9.0).unwrap().as_array().cloned() else { continue };
        if samples.iter().any(|sample| num(&sample["g1"]) > 0.5) {
            continue;
        }
        found.count += 1;
        for sample in samples {
            found.g0 = found.g0.max(num(&sample["g0"]));
            found.g1 = found.g1.max(num(&sample["g1"]));
            found.g2 = found.g2.max((num(&sample["normalCurvature"][0]) - num(&sample["normalCurvature"][1])).abs());
        }
    }
    found
}

/// Diagonal of the bounding box.
fn diagonal(shape: &Shape) -> f64 {
    let bounds = mass_properties(shape).unwrap().bounds;
    (0..3).map(|axis| (bounds[3 + axis] - bounds[axis]).powi(2)).sum::<f64>().sqrt()
}

/// The blend with the symmetric constant laws of `size` on `edges`; the prism builder is tried first, as in the evaluator.
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

fn built(shape: &Shape, edges: &[u32], laws: &[f64], kind: f64, param: f64) -> Shape {
    blend(shape, edges, laws, kind, param).unwrap_or_else(|why| panic!("refused: {why}"))
}

/// Volume of the revolution (about the z axis) of the spandrel between the corner `t` and the rational quadratic conic `a`, `t`, `b` of weight `w`
/// (points as (rho, z)), by Green's theorem: 2 pi |closed integral of rho^2 / 2 dz| over corner -> a, conic, b -> corner.
fn revolved_spandrel(a: (f64, f64), t: (f64, f64), b: (f64, f64), w: f64) -> f64 {
    let n = 40000;
    let mut sum = 0.0;
    let mut previous = a;
    for k in 1..=n {
        let u = f64::from(k) / f64::from(n);
        let basis = [(1.0 - u) * (1.0 - u), 2.0 * u * (1.0 - u) * w, u * u];
        let norm: f64 = basis.iter().sum();
        let rho = (basis[0] * a.0 + basis[1] * t.0 + basis[2] * b.0) / norm;
        let z = (basis[0] * a.1 + basis[1] * t.1 + basis[2] * b.1) / norm;
        sum += 0.25 * (previous.0 * previous.0 + rho * rho) * (z - previous.1);
        previous = (rho, z);
    }
    let line = |from: (f64, f64), to: (f64, f64)| 0.5 * (from.0 * from.0 + to.0 * to.0) / 2.0 * (to.1 - from.1);
    sum += line(b, t) + line(t, a);
    2.0 * std::f64::consts::PI * sum.abs()
}

#[test]
fn a_conic_rim_of_a_cylinder_removes_the_revolved_spandrel_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let cylinder = make_cylinder(10.0 * scale, 20.0 * scale).unwrap().unwrap();
        let rim = circles_at_height(&cylinder, 20.0 * scale, scale);
        let (radius, rho) = (2.0 * scale, 0.5);
        let shape = built(&cylinder, &rim, &[radius, NAN, 0.0, 0.0], 0.0, rho);
        let removed = volume_of(&cylinder) - volume_of(&shape);
        let (r, h) = (10.0 * scale, 20.0 * scale);
        let expected = revolved_spandrel((r - radius, h), (r, h), (r, h - radius), rho / (1.0 - rho));
        assert!((removed - expected).abs() < 1e-6 * expected, "scale {scale}: removed {removed} vs {expected}");
        let found = contacts(&shape);
        assert_eq!(found.count, 2);
        assert!(found.g0 < 1e-6 * diagonal(&shape), "scale {scale}: g0 {}", found.g0);
        assert!(found.g1 < 1e-3, "scale {scale}: g1 {}", found.g1);
        // the source is untouched
        assert!((volume_of(&cylinder) - std::f64::consts::PI * r * r * h).abs() < 1e-9 * volume_of(&cylinder));
    }
}

#[test]
fn a_conic_ring_around_a_boss_adds_the_revolved_spandrel_on_the_concave_side() {
    let _serial = crate::serial_blends();
    for scale in [1.0, 100.0] {
        let plate = make_box([-30.0 * scale, -30.0 * scale, -5.0 * scale], [60.0 * scale, 60.0 * scale, 5.0 * scale]).unwrap().unwrap();
        let boss = make_cylinder(10.0 * scale, 15.0 * scale).unwrap().unwrap();
        let fused = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
        let ring = circles_at_height(&fused, 0.0, scale);
        assert_eq!(ring.len(), 1);
        let (radius, rho) = (2.0 * scale, 0.4);
        let shape = built(&fused, &ring, &[radius, NAN, 0.0, 0.0], 0.0, rho);
        let added = volume_of(&shape) - volume_of(&fused);
        let r = 10.0 * scale;
        let expected = revolved_spandrel((r + radius, 0.0), (r, 0.0), (r, radius), rho / (1.0 - rho));
        assert!((added - expected).abs() < 1e-6 * expected, "scale {scale}: added {added} vs {expected}");
        let found = contacts(&shape);
        assert!(found.g0 < 1e-6 * diagonal(&shape) && found.g1 < 1e-3, "g0 {} g1 {}", found.g0, found.g1);
    }
}

#[test]
fn a_curvature_blend_matches_the_curvature_of_a_sphere_and_of_a_plane() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let sphere = make_sphere(5.0 * scale).unwrap().unwrap();
        let slab = make_box([-10.0 * scale, -10.0 * scale, -2.5 * scale], [20.0 * scale, 20.0 * scale, 5.0 * scale]).unwrap().unwrap();
        let band = boolean(BooleanOp::Intersect, &sphere, &slab, true).unwrap().unwrap();
        let rims = edges_where(&band, |e| e["curve"] == "circle");
        let laws = [0.4 * scale, NAN, 0.0, 0.0].repeat(rims.len());
        let curved = built(&band, &rims, &laws, 1.0, 0.5);
        let found = contacts(&curved);
        // the planar cap has curvature 0, the sphere 1 / R: the section matches both, so the jump is zero (relative to 1 / R)
        assert!(found.g2 * 5.0 * scale < 1e-6, "scale {scale}: curvature jump {}", found.g2);
        assert!(found.g0 < 1e-6 * diagonal(&curved) && found.g1 < 1e-3);
        let conic = built(&band, &rims, &laws, 0.0, 0.5);
        assert!(contacts(&conic).g2 * 5.0 * scale > 1e-3, "a conic section is not curvature continuous");
    }
}

#[test]
fn a_curvature_rim_is_g2_to_a_planar_cap_and_a_cylinder_wall() {
    let _serial = crate::serial_blends();
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    let rim = circles_at_height(&cylinder, 20.0, 1.0);
    let shape = built(&cylinder, &rim, &[2.0, NAN, 0.0, 0.0], 1.0, 0.5);
    assert!(contacts(&shape).g2 < 1e-9);
}

#[test]
fn a_changing_size_on_a_straight_edge_scales_the_conic_area_with_the_square_of_the_leg() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let block = make_box([0.0; 3], [20.0 * scale, 10.0 * scale, 10.0 * scale]).unwrap().unwrap();
        let edge = edges_where(&block, |e| {
            (num(&e["mid"][1]) - 10.0 * scale).abs() < 1e-9 * scale && (num(&e["mid"][2]) - 10.0 * scale).abs() < 1e-9 * scale
        });
        assert_eq!(edge.len(), 1);
        let laws = [scale, 2.0 * scale, 0.0, 0.0];
        let circular = crate::features::fillet_laws(&block, &edge, &laws).unwrap().unwrap();
        let rho: f64 = 0.5;
        let conic = built(&block, &edge, &laws, 0.0, rho);
        // At a right angle the conic area is c(rho) d^2 with c = 1/6 for rho 0.5 (parabola) and 1 - pi/4 for the circle: the same contact lines,
        // so the removed volumes are in that ratio (the sections of the two are in the same planes).
        let ratio = (1.0 / 6.0) / (1.0 - std::f64::consts::FRAC_PI_4);
        let removed_circular = volume_of(&block) - volume_of(&circular);
        let removed_conic = volume_of(&block) - volume_of(&conic);
        assert!(
            (removed_conic - ratio * removed_circular).abs() < 1e-4 * removed_circular,
            "scale {scale}: {removed_conic} vs {}",
            ratio * removed_circular
        );
        let found = contacts(&conic);
        assert!(found.g0 < 1e-6 * diagonal(&conic) && found.g1 < 1e-6, "g0 {} g1 {}", found.g0, found.g1);
    }
}

#[test]
fn a_rim_whose_size_varies_around_it_stays_a_closed_g1_blend() {
    let _serial = crate::serial_blends();
    for scale in [1.0, 100.0] {
        let plate = make_box([-30.0 * scale, -30.0 * scale, 0.0], [60.0 * scale, 60.0 * scale, 8.0 * scale]).unwrap().unwrap();
        let hole = make_cylinder(10.0 * scale, 8.0 * scale).unwrap().unwrap();
        let holed = boolean(BooleanOp::Subtract, &plate, &hole, true).unwrap().unwrap();
        let rim = circles_at_height(&holed, 8.0 * scale, scale);
        assert_eq!(rim.len(), 1);
        let laws = [2.0 * scale, 2.0 * scale, 0.0, 1.0, 0.5, 1.0 * scale];
        for (kind, param) in [(0.0, 0.5), (1.0, 0.5)] {
            let shape = built(&holed, &rim, &laws, kind, param);
            let found = contacts(&shape);
            assert!(found.g0 < 1e-6 * diagonal(&shape) && found.g1 < 1e-3, "kind {kind}: g0 {} g1 {}", found.g0, found.g1);
            assert!(volume_of(&shape) > volume_of(&holed) - 0.2 * volume_of(&hole), "material is removed around the hole, not added");
        }
    }
}

#[test]
fn a_tangent_chain_of_blends_is_one_closed_loop_even_when_one_edge_is_picked() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        let slab = make_box([-20.0 * scale, -15.0 * scale, 0.0], [40.0 * scale, 30.0 * scale, 6.0 * scale]).unwrap().unwrap();
        let vertical = edges_where(&slab, |e| (num(&e["start"][2]) - num(&e["end"][2])).abs() > 1e-3 * scale);
        let rounded = crate::features::fillet(&slab, &vertical, 5.0 * scale, None).unwrap().unwrap();
        let top = edges_where(&rounded, |e| (num(&e["mid"][2]) - 6.0 * scale).abs() < 1e-9 * scale);
        assert_eq!(top.len(), 8);
        let all = built(&rounded, &top, &[1.5 * scale, NAN, 0.0, 0.0].repeat(8), 0.0, 0.5);
        let one = built(&rounded, &top[..1], &[1.5 * scale, NAN, 0.0, 0.0], 0.0, 0.5);
        assert!((volume_of(&all) - volume_of(&one)).abs() < 1e-9 * volume_of(&all), "OCCT rounds the whole chain of a picked edge");
        let found = contacts(&all);
        assert_eq!(found.count, 32);
        assert!(found.g0 < 1e-6 * diagonal(&all) && found.g1 < 1e-3, "scale {scale}: g0 {} g1 {}", found.g0, found.g1);
    }
}

#[test]
fn profile_blends_run_on_cones_and_acute_wedges() {
    let _serial = crate::serial_blends();
    let cone = make_cone(10.0, 5.0, 20.0).unwrap().unwrap();
    for height in [0.0, 20.0] {
        let rim = circles_at_height(&cone, height, 1.0);
        for kind in [0.0, 1.0] {
            let shape = built(&cone, &rim, &[1.0, NAN, 0.0, 0.0], kind, 0.45);
            let found = contacts(&shape);
            assert!(found.g0 < 1e-6 * diagonal(&shape) && found.g1 < 1e-3);
        }
    }
    let mut chain = Vec::new();
    let triangle = [[0.0, 0.0], [10.0, 0.0], [5.0, 8.660254037844386]];
    for k in 0..3 {
        let (a, b) = (triangle[k], triangle[(k + 1) % 3]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    let face = crate::features::chain_face(&chain).unwrap().unwrap();
    let wedge = crate::features::prism_of_face(&face, [0.0, 0.0, 10.0]).unwrap().unwrap();
    let edge = edges_where(&wedge, |e| (num(&e["start"][2]) - num(&e["end"][2])).abs() > 1.0);
    // a 60 degree vertical edge: legs r tan(60 deg / 2 ... fold 120) -- removed area of the parabola is d^2 sin(60) / 6 per unit length
    let shape = built(&wedge, &edge[..1], &[1.0, 2.0, 0.0, 0.0], 0.0, 0.5);
    assert!(volume_of(&shape) < volume_of(&wedge));
    assert!(contacts(&shape).g1 < 1e-6);
}

#[test]
fn what_the_rail_builder_cannot_make_is_named() {
    let _serial = crate::serial_blends();
    // a blend that ends obliquely on its neighbour
    let mut chain = Vec::new();
    let parallelogram = [[0.0, 0.0], [10.0, 0.0], [14.0, 6.0], [4.0, 6.0]];
    for k in 0..4 {
        let (a, b) = (parallelogram[k], parallelogram[(k + 1) % 4]);
        chain.extend([0.0, a[0], a[1], 0.0, b[0], b[1], 0.0]);
    }
    let face = crate::features::chain_face(&chain).unwrap().unwrap();
    let skew = crate::features::prism_of_face(&face, [0.0, 0.0, 3.0]).unwrap().unwrap();
    let front = edges_where(&skew, |e| num(&e["mid"][2]) > 2.9 && num(&e["mid"][1]).abs() < 1e-9);
    let why = blend(&skew, &front, &[0.5, NAN, 0.0, 0.0], 0.0, 0.5).err().unwrap();
    assert!(why.contains("obliquely"), "{why}");
    // a size no circular fillet can have
    let slab = make_box([0.0; 3], [20.0, 20.0, 4.0]).unwrap().unwrap();
    let top = edges_where(&slab, |e| (num(&e["mid"][2]) - 4.0).abs() < 1e-9);
    let rounded = crate::features::fillet(&slab, &edges_where(&slab, |e| (num(&e["start"][2]) - num(&e["end"][2])).abs() > 1.0), 4.0, None)
        .unwrap()
        .unwrap();
    let why = blend(&rounded, &edges_where(&rounded, |e| (num(&e["mid"][2]) - 4.0).abs() < 1e-9)[..1], &[9.0, NAN, 0.0, 0.0], 0.0, 0.5)
        .err()
        .unwrap();
    assert!(why.contains("could not be built"), "{why}");
    assert_eq!(top.len(), 4);
    // asymmetric legs are not eligible for the rail builder: the prism builder's own reason is given
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    let rim = circles_at_height(&cylinder, 20.0, 1.0);
    let specs = [f64::from(rim[0]), 2.0, 0.0, 1.0, 2.0, 0.0, 0.0];
    let why = profile_blend_reason(&cylinder, &specs, &rim, &[], 2.0, 0.0).unwrap();
    assert!(why.contains("straight"), "{why}");
    // a blend of a straight chain of edges that meet at a corner with an unrounded third edge
    let block = make_box([0.0; 3], [20.0, 10.0, 10.0]).unwrap().unwrap();
    let two = edges_where(&block, |e| num(&e["mid"][2]) > 9.9 && (num(&e["mid"][1]) < 0.1 || num(&e["mid"][0]) > 19.9));
    assert_eq!(two.len(), 2);
    let why = blend(&block, &two, &[1.0, NAN, 0.0, 0.0].repeat(2), 0.0, 0.5).err().unwrap();
    assert!(why.contains("not rounded"), "{why}");
}

#[test]
fn the_rail_builder_refuses_edges_that_meet_at_a_corner_with_a_named_reason() {
    let _serial = crate::serial_blends();
    let cube = make_box([0.0; 3], [10.0; 3]).unwrap().unwrap();
    let all: Vec<u32> = (0..12).collect();
    let why = match fillet_rails(&cube, &all, &[1.0, NAN, 0.0, 0.0].repeat(12), 0.0, 0.5).unwrap() {
        Some(_) => String::new(),
        None => crate::features::rails_reason(&cube, &all, &[1.0, NAN, 0.0, 0.0].repeat(12), 0.0, 0.5).unwrap(),
    };
    assert!(why.contains("iso-line"), "{why}");
}

#[test]
fn a_cube_with_every_edge_profiled_gets_g1_corner_patches_at_every_size() {
    let _serial = crate::serial_blends();
    for scale in SCALES {
        for (kind, param) in [(0.0, 0.5), (1.0, 0.5), (0.0, 0.3)] {
            let cube = make_box([0.0; 3], [10.0 * scale; 3]).unwrap().unwrap();
            let all: Vec<u32> = (0..12).collect();
            let size = scale;
            let shape = built(&cube, &all, &[size, NAN, 0.0, 0.0].repeat(12), kind, param);
            let found = contacts(&shape);
            let limit = diagonal(&shape);
            // blend contacts are within the default g0; the corner patches within 5x of it (the fill is a B-spline approximation of the plate)
            assert!(found.g0 < 5e-6 * limit, "scale {scale} kind {kind} param {param}: g0 {} ({}x)", found.g0, found.g0 / (1e-6 * limit));
            assert!(found.g1 < 0.0101, "scale {scale} kind {kind}: g1 {}", found.g1);
            // the volume lies between the cube and the cube less 12 edge prisms of the whole edge and 8 generous corner cubes
            let a = 10.0 * scale;
            assert!(volume_of(&shape) < a * a * a, "material is removed");
            assert!(
                volume_of(&shape) > a * a * a - 12.0 * a * size * size - 8.0 * (4.0 * size).powi(3),
                "not more than the generous bound"
            );
        }
    }
}

#[test]
fn the_apex_of_a_pyramid_gets_a_profile_corner_and_a_lone_corner_edge_is_refused() {
    let _serial = crate::serial_blends();
    // four lateral edges of a square pyramid meet at the apex: an automatic corner of 4 edges
    let apex = [5.0, 5.0, 10.0];
    let base = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0]];
    let mut positions = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut push = |a: [f64; 3], b: [f64; 3], c: [f64; 3]| {
        let first = (positions.len() / 3) as u32;
        for p in [a, b, c] {
            positions.extend(p);
        }
        indices.extend([first, first + 1, first + 2]);
    };
    for k in 0..4 {
        push(base[k], base[(k + 1) % 4], apex);
    }
    push(base[0], base[2], base[1]);
    push(base[0], base[3], base[2]);
    let pyramid = crate::make_sewn_solid(&positions, &indices).unwrap().unwrap();
    let lateral = edges_where(&pyramid, |e| (num(&e["mid"][2]) - 5.0).abs() < 1e-6);
    assert_eq!(lateral.len(), 4);
    let outcome = blend(&pyramid, &lateral, &[0.5, NAN, 0.0, 0.0].repeat(4), 0.0, 0.5);
    // the base vertices close each lateral edge by one flat face: the same limits as the setback corner
    let shape = outcome.unwrap_or_else(|why| panic!("{why}"));
    assert!(volume_of(&shape) < volume_of(&pyramid));
    let found = contacts(&shape);
    assert!(found.g0 < 5e-6 * diagonal(&shape) && found.g1 < 0.0101, "g0 {} g1 {}", found.g0, found.g1);
}

#[test]
fn a_straight_law_with_a_kink_gets_stations_where_the_circular_blend_bends() {
    let _serial = crate::serial_blends();
    for scale in [1.0, 100.0] {
        let block = make_box([0.0; 3], [20.0 * scale, 10.0 * scale, 10.0 * scale]).unwrap().unwrap();
        let edge = edges_where(&block, |e| {
            (num(&e["mid"][1]) - 10.0 * scale).abs() < 1e-9 * scale && (num(&e["mid"][2]) - 10.0 * scale).abs() < 1e-9 * scale
        });
        // size 1 -> 2 -> 1 in straight pieces (mode 1), one control point at the middle
        let laws = [scale, scale, 1.0, 1.0, 0.5, 2.0 * scale];
        for (kind, param) in [(0.0, 0.5), (1.0, 0.4)] {
            let shape = built(&block, &edge, &laws, kind, param);
            let found = contacts(&shape);
            assert!(found.g0 < 1e-6 * diagonal(&shape) && found.g1 < 1e-5, "scale {scale} kind {kind}: g0 {} g1 {}", found.g0, found.g1);
            assert_eq!(found.count, 2);
        }
    }
}

mod recipe_level {
    //! The `fillet` node as the evaluator reads it: the plan of a profile (prism specs, rail laws), its refusals and its blend report.
    use crate::recipe::Evaluator;
    use serde_json::{json, Value};

    fn cylinder_leaf() -> Value {
        json!({ "op": "solid", "entity": { "kind": "cylinder", "radius": 10, "height": 20, "position": [0, 0, 0], "rotation": [0, 0, 0] } })
    }

    fn fillet(edges: &Value, extra: Value) -> Value {
        let mut node = json!({ "op": "fillet", "source": cylinder_leaf(), "edges": edges, "size": 2 });
        for (key, value) in extra.as_object().unwrap() {
            node[key] = value.clone();
        }
        node
    }

    fn rim_edge() -> u32 {
        let _ = Evaluator::new(8);
        let cylinder = crate::make_cylinder(10.0, 20.0).unwrap().unwrap();
        super::edges_where(&cylinder, |e| e["curve"] == "circle" && super::num(&e["mid"][2]) > 19.0)[0]
    }

    #[test]
    fn a_profile_node_builds_a_rim_with_constant_and_varying_sizes_and_reports_none() {
        let _serial = crate::serial_blends();
        let mut evaluator = Evaluator::new(16);
        let rim = json!([rim_edge()]);
        let constant = fillet(&rim, json!({ "profile": { "type": "conic", "rho": 0.5 } }));
        assert!(evaluator.evaluate(&constant).unwrap().is_some());
        let report = evaluator.blend_report(&constant).unwrap();
        assert_eq!(report["stage"], "none");
        assert_eq!(report["notes"]["builder"], "rails", "the report of a built profile carries what the builder measured");
        assert!(report["notes"]["gap"].as_f64().unwrap() <= report["notes"]["gapLimit"].as_f64().unwrap());
        let varying = fillet(
            &rim,
            json!({ "sizeEnd": 2, "radii": [{ "size": 2, "sizeEnd": 2, "sizes": [{ "t": 0.5, "size": 1 }] }], "profile": { "type": "curvature", "shape": 0.5 } }),
        );
        assert!(evaluator.evaluate(&varying).unwrap().is_some());
    }

    #[test]
    fn malformed_profiles_are_refused_and_reported() {
        let _serial = crate::serial_blends();
        let mut evaluator = Evaluator::new(16);
        let rim = json!([rim_edge()]);
        for profile in [json!({ "type": "conic", "rho": 2 }), json!({ "type": "curvature" }), json!({ "type": "other" })] {
            let node = fillet(&rim, json!({ "profile": profile }));
            assert!(evaluator.evaluate(&node).unwrap().is_none());
            let report = evaluator.blend_report(&node).unwrap();
            assert_eq!(report["stage"], "profile");
            assert!(report["message"].as_str().unwrap().contains("malformed"));
        }
        // a second leg whose size varies, a second leg without its face
        let legs_varying = fillet(&rim, json!({ "radii": [{ "size": 1, "sizeEnd": 2, "size2": 2, "sideFace": 0 }] }));
        assert!(evaluator.evaluate(&legs_varying).unwrap().is_none());
        let legs_unsided = fillet(&rim, json!({ "radii": [{ "size": 1, "size2": 2 }] }));
        assert!(evaluator.evaluate(&legs_unsided).unwrap().is_none());
        // a size 9 conic on a 10 mm rim cylinder cannot be rolled: the report carries the kernel's reason
        let huge = fillet(&rim, json!({ "size": 30, "profile": { "type": "conic", "rho": 0.5 } }));
        assert!(evaluator.evaluate(&huge).unwrap().is_none());
        let report = evaluator.blend_report(&huge).unwrap();
        assert_eq!(report["stage"], "profile");
        assert!(report["message"].as_str().unwrap().contains("could not be built"), "the reason kept from the build: {report}");
    }
}

/// BLD §13.17: a void is kept. The rim of a cylinder with a spherical pocket is blended; the pocket's shell stays an inner shell of the result, so the volume is the blended
/// cylinder's less the pocket (4/3 pi 3^3), and a pocket outside the body (a second body) is refused by name.
#[test]
fn a_solid_with_a_void_keeps_its_void_through_a_profile_blend() {
    let _serial = crate::serial_blends();
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    let mut pocket = make_sphere(3.0).unwrap().unwrap();
    pocket = crate::placed(&pocket, [0.0; 3], [0.0, 0.0, 10.0], [0.0; 3]).unwrap().unwrap();
    let hollow = boolean(BooleanOp::Subtract, &cylinder, &pocket, true).unwrap().unwrap();
    let rim = circles_at_height(&hollow, 20.0, 1.0);
    assert_eq!(rim.len(), 1);
    let rounded = blend(&hollow, &rim, &[2.0, NAN, 0.0, 0.0], 0.0, 0.5).unwrap();
    let solid_rim = circles_at_height(&cylinder, 20.0, 1.0);
    let reference = blend(&cylinder, &solid_rim, &[2.0, NAN, 0.0, 0.0], 0.0, 0.5).unwrap();
    let void = 4.0 / 3.0 * std::f64::consts::PI * 27.0;
    let volume = |shape: &Shape| crate::mass_properties(shape).unwrap().volume;
    assert!(
        (volume(&rounded) - (volume(&reference) - void)).abs() < 1e-6 * volume(&reference),
        "{} vs {}",
        volume(&rounded),
        volume(&reference) - void
    );
    assert!(crate::analyze(&rounded).unwrap().valid);
    let shells = topology(&rounded).unwrap()["faces"].as_array().unwrap().len();
    assert_eq!(shells, topology(&reference).unwrap()["faces"].as_array().unwrap().len() + 1, "the pocket's face is kept");
}

fn notes_of(shape: &Shape) -> Value {
    serde_json::from_str(&crate::features::shape_notes(shape).unwrap()).unwrap()
}

/// A spherical cap (R 20) cut by a rounded rectangle: the walls change from plane to cylinder along the rim, so the curvature of a wall along the
/// section jumps at every junction of the rim chain.
fn rounded_cap() -> (Shape, Vec<u32>) {
    let sphere = make_sphere(20.0).unwrap().unwrap();
    let block = make_box([-10.0, -6.0, -30.0], [20.0, 12.0, 60.0]).unwrap().unwrap();
    let vertical = edges_where(&block, |e| (num(&e["start"][2]) - num(&e["end"][2])).abs() > 1.0);
    let stadium = crate::features::fillet(&block, &vertical, 4.0, None).unwrap().unwrap();
    let cap = boolean(BooleanOp::Intersect, &sphere, &stadium, true).unwrap().unwrap();
    let rim = edges_where(&cap, |e| num(&e["mid"][2]) > 0.0 && num(&e["length"]) > 1e-6 && e["seam"] != true);
    (cap, rim)
}

#[test]
fn a_curvature_chain_whose_supports_jump_in_curvature_falls_back_to_the_quartic_and_says_so() {
    let _serial = crate::serial_blends();
    let (cap, rim) = rounded_cap();
    // blend 0.5: the curvature-continuous sections of two blends do not sew, the quartic's junctions meet at 0.0087 rad
    let laws = [0.5, NAN, 0.0, 0.0].repeat(rim.len());
    let curvature = built(&cap, &rim, &laws, 1.0, 0.5);
    let notes = notes_of(&curvature);
    assert_eq!(notes["builder"], "rails");
    let edges: Vec<u64> = notes["fallback"]["edges"].as_array().unwrap().iter().map(|edge| edge.as_u64().unwrap()).collect();
    assert!(edges.len() >= rim.len(), "the fallback names the edges it applies to, the whole chain");
    assert!(notes["fallback"]["reason"].as_str().unwrap().contains("support curvature jumps"));
    let junction = notes["junctionG1"].as_f64().unwrap();
    assert!(junction > 1e-3 && junction <= 0.01, "the largest junction angle is reported: {junction}");
    let found = contacts(&curvature);
    assert!(found.g1 <= 0.01 + 1e-9 && found.g0 < 1e-3, "g1 {} g0 {}", found.g1, found.g0);
    // a conic never asks for the curvature pass, so it never falls back
    assert!(notes_of(&built(&cap, &rim, &laws, 0.0, 0.5)).get("fallback").is_none());
    // where the curved pass builds there is nothing to report
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    let rim = circles_at_height(&cylinder, 20.0, 1.0);
    assert!(notes_of(&built(&cylinder, &rim, &[2.0, NAN, 0.0, 0.0], 1.0, 0.5)).get("fallback").is_none());
}

#[test]
fn a_chain_whose_curvature_blend_would_meet_at_more_than_the_g1_default_is_refused_and_a_conic_fades_to_the_circle() {
    let _serial = crate::serial_blends();
    let (cap, rim) = rounded_cap();
    let laws = [1.0, NAN, 0.0, 0.0].repeat(rim.len());
    // blend 1: the quartic (the fallback) kinks by 0.0184 rad at a junction, the curvature-continuous pass does not sew
    let why = blend(&cap, &rim, &laws, 1.0, 0.5).err().unwrap();
    assert!(
        why.contains("curvature-continuous pass failed")
            && why.contains("zero-curvature quartic")
            && why.contains("0.0184")
            && why.contains("limit 0.0095"),
        "{why}"
    );
    // the conic of the same blend meets at 0.0077 rad: built, and the angle is reported even though it passes
    let conic = built(&cap, &rim, &laws, 0.0, 0.5);
    let junction = notes_of(&conic)["junctionG1"].as_f64().unwrap();
    assert!(junction > 1e-3 && junction <= 0.01, "{junction}");
    // the conic of the R 30 cap with a 2 mm outline would kink by 0.0182 rad: its ends fade to the circular arc (13.19)
    let (cap_small, rim_small) = {
        let sphere = make_sphere(30.0).unwrap().unwrap();
        let block = make_box([-10.0, -6.0, -60.0], [20.0, 12.0, 120.0]).unwrap().unwrap();
        let vertical = edges_where(&block, |e| (num(&e["start"][2]) - num(&e["end"][2])).abs() > 1.0);
        let stadium = crate::features::fillet(&block, &vertical, 2.0, None).unwrap().unwrap();
        let cap = boolean(BooleanOp::Intersect, &sphere, &stadium, true).unwrap().unwrap();
        let rim = edges_where(&cap, |e| num(&e["mid"][2]) > 0.0 && num(&e["length"]) > 1e-6 && e["seam"] != true);
        (cap, rim)
    };
    let laws_small = [1.0, NAN, 0.0, 0.0].repeat(rim_small.len());
    let faded = built(&cap_small, &rim_small, &laws_small, 0.0, 0.5);
    let notes = notes_of(&faded);
    assert_eq!(notes["circularFade"]["reachChords"], 3.0);
    assert!(notes["circularFade"]["ends"].as_u64().unwrap() >= rim_small.len() as u64, "{notes}");
    // G1 across every junction to rounding (0.0182 rad without the fade), the contacts with the walls as for any profile
    assert!(notes["junctionG1"].as_f64().unwrap() < 1e-4, "{notes}");
    assert!(contacts(&faded).g1 < 1e-4 && contacts(&faded).g0 < 1e-3, "g1 {} g0 {}", contacts(&faded).g1, contacts(&faded).g0);
    // volume: the circular fillet removes 7.079 mm3 here; a conic of weight 1 (the profile) removes less, the circle (the fade's end) as much: between the two
    let circular = crate::features::fillet(&cap_small, &rim_small, 1.0, None).unwrap().unwrap();
    let removed = (volume_of(&cap_small) - volume_of(&faded)) / (volume_of(&cap_small) - volume_of(&circular));
    assert!(removed > 0.75 && removed < 1.0, "the faded conic removes {removed} of the circular fillet's volume");
    // a chain that does not kink has no fade, and a curvature profile has none to give
    assert!(notes_of(&built(&cap, &rim, &[1.0, NAN, 0.0, 0.0].repeat(rim.len()), 0.0, 0.5)).get("circularFade").is_none());
}

#[test]
fn a_step_that_mixes_convex_and_concave_blends_builds_and_is_not_held_to_the_circular_volume() {
    let _serial = crate::serial_blends();
    // a boss on a plate: the top rim of the boss is convex, its foot ring concave
    let plate = make_box([-30.0, -30.0, -5.0], [60.0, 60.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(10.0, 15.0).unwrap().unwrap();
    let fused = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
    let rims =
        edges_where(&fused, |e| e["curve"] == "circle" && (num(&e["mid"][2]).abs() < 1e-9 || (num(&e["mid"][2]) - 15.0).abs() < 1e-9));
    assert_eq!(rims.len(), 2);
    let shape = built(&fused, &rims, &[2.0, NAN, 0.0, 0.0].repeat(2), 0.0, 0.5);
    assert_eq!(crate::features::profile_blend_last_reason().unwrap(), "", "a success clears the reason of an earlier failure");
    // the foot adds (concave) what the top removes (convex): the net of two rings of about 40 mm3 each, held to 2e-6 of their sum
    let expected = ring_removed_both(10.0, 15.0, 2.0, 0.5 / 0.5);
    assert!(
        (volume_of(&fused) - volume_of(&shape) - expected).abs() < 2e-6 * 85.0,
        "{} vs {expected}",
        volume_of(&fused) - volume_of(&shape)
    );
    let found = contacts(&shape);
    assert!(found.g0 < 1e-6 * diagonal(&shape) && found.g1 < 1e-3);
}

/// Net volume removed by conic spandrels of leg `d` at the top rim (convex, removed) and the foot ring (concave, added) of a boss of radius `r` and height
/// `h` on a plate.
fn ring_removed_both(r: f64, h: f64, d: f64, w: f64) -> f64 {
    let top = revolved_spandrel((r - d, h), (r, h), (r, h - d), w);
    let foot = revolved_spandrel((r + d, 0.0), (r, 0.0), (r, d), w);
    top - foot
}

#[test]
fn the_measured_gap_is_reported_and_a_part_too_small_for_the_circular_blend_is_refused_with_it() {
    let _serial = crate::serial_blends();
    let band = |scale: f64| {
        let sphere = make_sphere(5.0 * scale).unwrap().unwrap();
        let slab = make_box([-10.0 * scale, -10.0 * scale, -2.5 * scale], [20.0 * scale, 20.0 * scale, 5.0 * scale]).unwrap().unwrap();
        boolean(BooleanOp::Intersect, &sphere, &slab, true).unwrap().unwrap()
    };
    for scale in [1.0, 10.0, 100.0] {
        let shape = band(scale);
        let rims = edges_where(&shape, |e| e["curve"] == "circle");
        let done = built(&shape, &rims, &[0.4 * scale, NAN, 0.0, 0.0].repeat(rims.len()), 1.0, 0.5);
        let notes = notes_of(&done);
        let (gap, limit) = (notes["gap"].as_f64().unwrap(), notes["gapLimit"].as_f64().unwrap());
        // the limit is 5e-6 x the true bounding-box diagonal (the smaller of the source's and the result's), as check_blends reads it
        assert!(
            gap <= limit && (limit - 0.95 * 5e-6 * diagonal(&done)).abs() < 0.01 * limit,
            "scale {scale}: gap {gap} limit {limit} diagonal {}",
            diagonal(&done)
        );
    }
    // 0.3 mm across: OCCT's own circular blend is 6.6e-6 x the true diagonal off its supports (an absolute approximation error of a few 1e-6), above the 5e-6 limit
    let tiny = band(0.03);
    let rims = edges_where(&tiny, |e| e["curve"] == "circle");
    let why = blend(&tiny, &rims, &[0.012, NAN, 0.0, 0.0].repeat(rims.len()), 1.0, 0.5).err().unwrap();
    assert!(why.contains("meet their neighbours only to") && why.contains("5e-6"), "{why}");
}

#[test]
fn profiled_edges_that_meet_at_a_vertex_need_one_constant_size() {
    let _serial = crate::serial_blends();
    let block = make_box([0.0; 3], [20.0, 20.0, 20.0]).unwrap().unwrap();
    // the three edges at (20, 20, 20), then two of them
    let at_vertex = edges_where(&block, |e| {
        let near = |p: &Value| (0..3).all(|axis| (num(&p[axis]) - 20.0).abs() < 1e-9);
        near(&e["start"]) || near(&e["end"])
    });
    assert_eq!(at_vertex.len(), 3);
    for picked in [&at_vertex[..], &at_vertex[..2]] {
        let laws: Vec<f64> = picked.iter().flat_map(|_| [1.0, 2.0, 0.0, 0.0]).collect();
        let why = blend(&block, picked, &laws, 0.0, 0.5).err().unwrap();
        assert!(why.contains("meet at a vertex need one constant size"), "{} edges: {why}", picked.len());
    }
    // one constant size at the same vertex is the corner builder
    let shape = built(&block, &at_vertex, &[1.0, NAN, 0.0, 0.0].repeat(3), 0.0, 0.5);
    assert_eq!(notes_of(&shape)["builder"], "corners");
}

#[test]
fn the_corner_builder_reports_the_setback_it_chose_and_a_failure_is_explained_once() {
    let _serial = crate::serial_blends();
    let cube = make_box([0.0; 3], [10.0; 3]).unwrap().unwrap();
    let all: Vec<u32> = (0..12).collect();
    let shape = built(&cube, &all, &[1.0, NAN, 0.0, 0.0].repeat(12), 0.0, 0.5);
    let notes = notes_of(&shape);
    assert_eq!(notes["builder"], "corners");
    assert_eq!(notes["factor"], 2.0);
    let corners = notes["corners"].as_array().unwrap();
    assert_eq!(corners.len(), 8);
    for corner in corners {
        let setbacks = corner["setbacks"].as_array().unwrap();
        assert_eq!(setbacks.len(), 3);
        // a right-angle cube: the least setback is the tangent distance r = 1, the build takes twice that
        for setback in setbacks {
            assert!((num(&setback["distance"]) - 2.0).abs() < 1e-9, "{setback}");
        }
    }
    // the reason of a refusal is the one computed while building (profile_blend_last_reason), with the sizes that were tried
    let specs: Vec<f64> = all.iter().flat_map(|e| [f64::from(*e), 0.0, 0.5, 4.0, NAN, -1.0, 0.0]).collect();
    assert!(fillet_profile_blend(&cube, &specs, &all, &[4.0, NAN, 0.0, 0.0].repeat(12), 0.0, 0.5).unwrap().is_none());
    let kept = crate::features::profile_blend_last_reason().unwrap();
    assert_eq!(kept, profile_blend_reason(&cube, &specs, &all, &[4.0, NAN, 0.0, 0.0].repeat(12), 0.0, 0.5).unwrap());
    assert!(!kept.is_empty());
}

#[test]
fn a_thin_large_disc_gets_a_gap_limit_of_5e_6_of_its_true_diagonal_not_of_its_vertex_box() {
    let _serial = crate::serial_blends();
    // R 200, h 0.5: the vertices of the cylinder are a few points on the rim, whose box is a fraction of the part's 566 mm
    let disc = make_cylinder(200.0, 0.5).unwrap().unwrap();
    let rim = circles_at_height(&disc, 0.5, 1.0);
    let shape = built(&disc, &rim, &[0.2, NAN, 0.0, 0.0], 0.0, 0.5);
    let notes = notes_of(&shape);
    let true_diagonal = diagonal(&shape);
    assert!((true_diagonal - (400.0f64.powi(2) * 2.0 + 0.25).sqrt()).abs() < 1e-6, "{true_diagonal}");
    let limit = notes["gapLimit"].as_f64().unwrap();
    assert!((limit - 0.95 * 5e-6 * true_diagonal).abs() < 1e-9 * limit, "gap limit {limit} against 0.95 x 5e-6 x {true_diagonal}");
    assert!(notes["gap"].as_f64().unwrap() <= limit);
    // and the chain-junction margin: the largest angle is reported under 0.0095 rad (0.95 x the check_blends default)
    assert!(notes["junctionG1"].as_f64().unwrap() <= 0.0095);
}

#[test]
fn only_a_step_with_convex_and_concave_blends_is_mixed_not_every_open_convex_blend() {
    let _serial = crate::serial_blends();
    let mixed_of = |shape: &Shape, edges: &[u32], laws: &[f64]| {
        notes_of(&fillet_rails(shape, edges, laws, 0.0, 0.5).unwrap().unwrap())["mixed"].as_bool().unwrap()
    };
    // a single convex box edge, open and square to its end faces (its ball centres at the ends lie in the end faces)
    let block = make_box([0.0; 3], [20.0, 10.0, 10.0]).unwrap().unwrap();
    let edge = edges_where(&block, |e| (num(&e["mid"][1]) - 10.0).abs() < 1e-9 && (num(&e["mid"][2]) - 10.0).abs() < 1e-9);
    assert!(!mixed_of(&block, &edge, &[1.0, NAN, 0.0, 0.0]));
    assert!(!mixed_of(&block, &edge, &[1.0, 2.0, 0.0, 0.0]));
    // a cylinder rim (closed)
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    assert!(!mixed_of(&cylinder, &circles_at_height(&cylinder, 20.0, 1.0), &[2.0, NAN, 0.0, 0.0]));
    // a concave edge alone is not mixed either (an L-shaped inner corner)
    let a = make_box([0.0; 3], [40.0, 10.0, 20.0]).unwrap().unwrap();
    let b = make_box([0.0; 3], [10.0, 40.0, 20.0]).unwrap().unwrap();
    let l = boolean(BooleanOp::Union, &a, &b, true).unwrap().unwrap();
    let inner = vec![edge_near_mid(&l, [10.0, 10.0, 10.0])];
    assert!(!mixed_of(&l, &inner, &[2.0, NAN, 0.0, 0.0]));
    // the boss top rim (convex) with its foot ring (concave) is mixed
    let plate = make_box([-30.0, -30.0, -5.0], [60.0, 60.0, 5.0]).unwrap().unwrap();
    let boss = make_cylinder(10.0, 15.0).unwrap().unwrap();
    let fused = boolean(BooleanOp::Union, &plate, &boss, true).unwrap().unwrap();
    let rims =
        edges_where(&fused, |e| e["curve"] == "circle" && (num(&e["mid"][2]).abs() < 1e-9 || (num(&e["mid"][2]) - 15.0).abs() < 1e-9));
    assert!(mixed_of(&fused, &rims, &[2.0, NAN, 0.0, 0.0].repeat(2)));
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

/// BLD §13.17 review: what one solid cannot hold is refused by name. A second body outside the first (a disjoint sphere in a compound), a body inside a void (an island
/// sphere inside the pocket: it would read as a second void, outer - void - island instead of + island).
#[test]
fn a_second_body_and_a_body_inside_a_void_are_refused_by_name() {
    let _serial = crate::serial_blends();
    let cylinder = make_cylinder(10.0, 20.0).unwrap().unwrap();
    let sphere =
        |radius: f64, at: [f64; 3]| crate::placed(&make_sphere(radius).unwrap().unwrap(), [0.0; 3], at, [0.0; 3]).unwrap().unwrap();
    let rim = circles_at_height(&cylinder, 20.0, 1.0);
    assert_eq!(rim.len(), 1);
    let beside = boolean(BooleanOp::Union, &cylinder, &sphere(3.0, [40.0, 0.0, 10.0]), true).unwrap().unwrap();
    let why = blend(&beside, &rim, &[2.0, NAN, 0.0, 0.0], 0.0, 0.5).err().unwrap();
    assert!(why.contains("second body"), "{why}");
    let hollow = boolean(BooleanOp::Subtract, &cylinder, &sphere(5.0, [0.0, 0.0, 10.0]), true).unwrap().unwrap();
    let island = boolean(BooleanOp::Union, &hollow, &sphere(2.0, [0.0, 0.0, 10.0]), true).unwrap().unwrap();
    let rim_of_island = circles_at_height(&island, 20.0, 1.0);
    let why = blend(&island, &rim_of_island, &[2.0, NAN, 0.0, 0.0], 0.0, 0.5).err().unwrap();
    assert!(why.contains("a body inside a void"), "{why}");
}
