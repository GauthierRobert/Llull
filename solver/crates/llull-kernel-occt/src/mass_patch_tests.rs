//! BLD §13.48: the strip integrator for the B-spline faces of many knot cells (`cpp/mass_patch.cxx`) against BRepGProp's fixed rule, against closed forms, and on the vertex fan shell.

use crate::blend_corner_tests::{cube, CornerHooks};
use crate::blend_g2corner_tests::profile_of;
use crate::queries::topology;
use crate::test_bridge::{
    patch_properties, patch_properties_mode, patch_synthetic, set_patch_agreement, set_patch_integrator, set_patch_order,
};
use crate::{boolean, make_box, make_cylinder, mass_properties, BooleanOp, Shape};
use std::f64::consts::PI;

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs()).max(1e-300)
}

/// The largest relative difference of two `[mass, centre x3, central inertia x6]` rows (the products of inertia against the largest moment: they can be zero by symmetry).
fn worst(a: &[f64; 10], b: &[f64; 10]) -> f64 {
    let moment = a[4].abs().max(a[5].abs()).max(a[6].abs()).max(1e-300);
    (0..10).map(|k| if k < 7 { rel(a[k], b[k]) } else { (a[k] - b[k]).abs() / moment }).fold(0.0, f64::max)
}

/// Puts the integrator back on and its order to automatic, whatever a test does.
struct PatchHooks;

impl Drop for PatchHooks {
    fn drop(&mut self) {
        set_patch_integrator(true);
        set_patch_order(0);
        set_patch_agreement(0.0);
    }
}

/// A flat square of side 10 (kind 0), with a round hole of radius 2 (kind 3: 100 - 4 pi; kind 7: the same hole whose edge runs over [-pi, pi], so a sample of the pcurve falls on the extremum of u: the first version dropped
/// that piece and read an area off by pi r^2 / 2), inside a diamond of straight sides (kind 5: 10^2 times the shoelace area 0.3705): the area is known in closed form.
#[test]
fn the_area_of_flat_trimmed_faces_is_their_closed_form() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let diamond = [(0.5, 0.05), (0.93, 0.47), (0.55, 0.92), (0.08, 0.5)];
    let shoelace: f64 =
        (0..4).map(|k| diamond[k].0 * diamond[(k + 1) % 4].1 - diamond[(k + 1) % 4].0 * diamond[k].1).sum::<f64>().abs() / 2.0;
    for (kind, exact) in
        [(0, 100.0), (3, 100.0 - 4.0 * PI), (5, 100.0 * shoelace), (16, 100.0), (19, 100.0 - 4.0 * PI), (7, 100.0 - 4.0 * PI)]
    {
        let (taken, strips, fixed, _) = patch_synthetic(kind, false).unwrap_or_else(|| panic!("kind {kind}: no face taken"));
        assert_eq!(taken, 1, "kind {kind}");
        assert!(rel(strips[0], exact) < 1e-12, "kind {kind}: strips {} against {exact}", strips[0]);
        assert!(rel(fixed[0], exact) < 1e-13, "kind {kind}: BRepGProp {} against {exact}", fixed[0]);
        assert!(strips[3].abs() < 1e-12, "kind {kind}: the centre lies in the plane z = 0: {}", strips[3]);
    }
}

/// Smooth (wavy) faces of degree 6 and 7, whole, with a corner cut off by lines, with holes: area, centre and inertia against BRepGProp. The two agree to 2e-10 at worst (BRepGProp's own error: the strip
/// result is the same at order 30, `the_automatic_order_is_converged`), and the reversed faces read the same area.
#[test]
fn the_strips_agree_with_brepgprop_on_wavy_trimmed_faces() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    for kind in [1, 2, 4, 6] {
        let (taken, strips, fixed, _) = patch_synthetic(kind, false).unwrap_or_else(|| panic!("kind {kind}: no face taken"));
        assert_eq!(taken, 1, "kind {kind}");
        assert!(worst(&strips, &fixed) < 5e-10, "kind {kind}: {strips:?} against {fixed:?}");
        let (_, reversed, _, _) = patch_synthetic(kind + 16, false).unwrap();
        assert_eq!(reversed[0], strips[0], "kind {kind}: the area of the reversed face");
    }
}

/// The automatic order (successive orders until three agree pairwise to 1e-11) lands where a fixed order 30 does, on every synthetic face.
#[test]
fn the_automatic_order_is_converged() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    for kind in [0, 1, 2, 3, 4, 5, 6, 7, 8] {
        let (_, automatic, _, _) = patch_synthetic(kind, false).unwrap();
        set_patch_order(30);
        let (_, high, _, _) = patch_synthetic(kind, false).unwrap();
        set_patch_order(0);
        assert!(worst(&automatic, &high) < 1e-11, "kind {kind}: {automatic:?} against {high:?}");
    }
}

/// A shape none of whose faces is a B-spline of many cells and of degree 6 or more (a cube with a hole and a pocket) is not taken: BRepGProp runs as before, and the volume is the closed form.
#[test]
fn a_cube_with_holes_is_left_to_brepgprop() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let block = make_box([-5.0, -5.0, 0.0], [10.0, 10.0, 10.0]).unwrap().unwrap();
    let drilled = boolean(BooleanOp::Subtract, &block, &make_cylinder(1.0, 10.0).unwrap().unwrap(), true).unwrap().unwrap();
    let pocket = make_box([2.0, -1.0, 3.0], [2.0, 2.0, 4.0]).unwrap().unwrap();
    let shape: Shape = boolean(BooleanOp::Subtract, &drilled, &pocket, true).unwrap().unwrap();
    assert!(patch_properties(&shape, true).is_none(), "no B-spline face: nothing is taken");
    assert!(patch_properties(&shape, false).is_none());
    let mass = mass_properties(&shape).unwrap();
    assert!(rel(mass.volume, 1000.0 - 10.0 * PI - 16.0) < 1e-9, "volume {}", mass.volume);
    // a plane (the box) and a cylinder alone: analytic faces, closed forms
    let plane = mass_properties(&block).unwrap();
    assert!(rel(plane.volume, 1000.0) < 1e-12 && rel(plane.area, 600.0) < 1e-12, "{} {}", plane.volume, plane.area);
    let cylinder = make_cylinder(3.0, 7.0).unwrap().unwrap();
    assert!(patch_properties(&cylinder, true).is_none());
    let round = mass_properties(&cylinder).unwrap();
    assert!(rel(round.volume, 63.0 * PI) < 1e-12 && rel(round.area, 2.0 * PI * 3.0 * 10.0) < 1e-12, "{} {}", round.volume, round.area);
}

/// With the integrator off nothing is taken (every face by BRepGProp); a volume of a shape with an open shell is never taken (the cones of an open shell depend on the apex).
#[test]
fn the_hook_turns_the_strips_off_and_an_open_shell_has_no_strip_volume() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    assert!(patch_synthetic(1, false).is_some());
    assert!(patch_synthetic(1, true).is_none(), "one face is an open shell");
    set_patch_integrator(false);
    assert!(patch_synthetic(1, false).is_none());
    set_patch_integrator(true);
    assert!(patch_synthetic(1, false).is_some());
}

/// A flat square whose left side is a B-spline pcurve with a double bump (two extrema of u between two of the 48 samples of the whole curve): the parameter domain has the area 0.64. The first
/// version cut only at sign changes between samples, missed pairs of extrema and paired the pieces wrongly: the strips must read 64 (closed form).
#[test]
fn a_pcurve_with_many_extrema_between_samples_is_read_right_or_left_to_brepgprop() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let (taken, strips, fixed, _) = patch_synthetic(8, false)
        .unwrap_or_else(|| panic!("the wiggly face is taken: refusal {}", crate::test_bridge::last_patch_refusal()));
    assert_eq!(taken, 1);
    assert!(
        crate::test_bridge::last_domain_gap() < 1e-11,
        "the strips and Green's theorem agree on the parameter domain: {}",
        crate::test_bridge::last_domain_gap()
    );
    assert!(rel(strips[0], 64.0) < 1e-10, "strips {} against 64", strips[0]);
    // BRepGProp reads 64.0108 (1.7e-4 off) on this face: the closed form is the reference
    assert!(rel(fixed[0], 64.0) < 1e-3, "BRepGProp {}", fixed[0]);
}

/// The volume of the reversed fan shell is the negative of the shell's (the sign of the reversed faces taken by strips), the shell moved far from the origin (a rotation and a translation of 1100 in the locations
/// of its faces) keeps its area, volume and central moments against BRepGProp, and with an agreement no face can meet every face falls back to BRepGProp (the same numbers as with the integrator off, bit for bit).
#[test]
fn reversed_moved_and_non_converging_faces() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let _reset = CornerHooks;
    crate::test_bridge::set_corner_fan(1);
    let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
    let (_, upright, _, _) = patch_properties_mode(&shape, 1).unwrap();
    let (_, flat, _, _) = patch_properties_mode(&shape, 0).unwrap();
    let (taken, reversed, fixed, _) = patch_properties_mode(&shape, 2).unwrap();
    assert_eq!(taken, 144);
    assert!(reversed[0] < 0.0 && rel(reversed[0], -upright[0]) < 1e-12, "reversed volume {} against {}", reversed[0], upright[0]);
    assert!(worst(&reversed, &fixed) < 1e-11, "reversed: {reversed:?} against {fixed:?}");
    for (mode, mass) in [(3, upright[0]), (4, flat[0])] {
        let (taken, moved, fixed, _) = patch_properties_mode(&shape, mode).unwrap();
        assert_eq!(taken, 144, "mode {mode}");
        assert!(worst(&moved, &fixed) < 1e-9, "mode {mode}: {moved:?} against {fixed:?}");
        assert!(rel(moved[0], mass) < 1e-9, "mode {mode}: the mass moved: {}", moved[0]);
    }
    // an agreement nobody meets: nothing is taken, and mass_properties is exactly what BRepGProp gives
    set_patch_agreement(-1.0);
    assert!(patch_properties(&shape, true).is_none() && patch_synthetic(1, false).is_none());
    let fallback = mass_properties(&profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap()).unwrap();
    set_patch_agreement(0.0);
    set_patch_integrator(false);
    let plain = mass_properties(&profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap()).unwrap();
    assert_eq!((fallback.volume, fallback.area), (plain.volume, plain.area), "every face fell back to BRepGProp");
}

/// The setback cube with its plate patches and with its exact stars (the two blend_corner tests that failed on the first version: the faces the strips leave to BRepGProp were summed with another apex): the volume
/// and area read with the integrator on equal those with it off to 1e-7 (BRepGProp's own error on the plate patches is 3.4e-8: the strips are the same at order 30 to 1e-15).
#[test]
fn the_plate_and_the_star_read_the_same_with_the_integrator_on_and_off() {
    use crate::blend_corner_tests::cube_corner_step;
    use crate::features::fillet_setback;
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let _reset = CornerHooks;
    let (shape, edges, corners) = cube_corner_step();
    for exact in [0, 1] {
        crate::test_bridge::set_corner_exact_patch(exact);
        let built = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
        // the plate patches are strip faces (the sub-patches of the exact stars are too small)
        let strips = patch_properties(&built, true);
        assert_eq!(strips.is_some(), exact == 0, "exact {exact}");
        if let Some((taken, auto, fixed, _)) = strips {
            set_patch_order(30);
            let (_, high, _, _) = patch_properties(&built, true).unwrap();
            set_patch_order(0);
            assert!(taken >= 8, "the corner patches are taken ({taken})");
            assert!(worst(&auto, &high) < 1e-11, "the strips are converged: {} against order 30 {}", auto[0], high[0]);
            assert!(rel(auto[0], fixed[0]) < 1e-7, "strips {} against BRepGProp {}", auto[0], fixed[0]);
        }
        let on = mass_properties(&built).unwrap();
        set_patch_integrator(false);
        let off = fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid");
        let off = mass_properties(&off).unwrap();
        set_patch_integrator(true);
        assert!(rel(on.volume, off.volume) < 1e-7, "exact {exact}: volume {} against {}", on.volume, off.volume);
        assert!(rel(on.area, off.area) < 1e-7, "exact {exact}: area {} against {}", on.area, off.area);
    }
}

/// Measurement, not a gate (`cargo test --release -p llull-kernel-occt timings_of_the_fan_shell_reads -- --ignored --nocapture`): the build of the curvature cube and the reads that follow it
/// (bounds, mass, topology, face graph, analyze), strips off and on, fans off and on. BLD 13.48 quotes them.
#[test]
#[ignore]
fn timings_of_the_fan_shell_reads() {
    use crate::queries::face_graph;
    use std::time::Instant;
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let _reset = CornerHooks;
    let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
    for volume in [true, false] {
        let (_, _, _, seconds) = patch_properties(&shape, volume).unwrap();
        eprintln!("TIMING fan shell volume {volume}: strips {:.2} s, BRepGProp {:.2} s", seconds[0], seconds[1]);
    }
    for strips in [false, true] {
        set_patch_integrator(strips);
        let mut totals = [0.0; 2];
        for fans in [0, 1] {
            crate::test_bridge::set_corner_fan(fans);
            let started = Instant::now();
            let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
            let mut seconds = vec![started.elapsed().as_secs_f64()];
            let mut lap = |read: &dyn Fn()| {
                let started = Instant::now();
                read();
                seconds.push(started.elapsed().as_secs_f64());
            };
            lap(&|| {
                let _ = crate::shape_bounds(&shape).unwrap();
            });
            lap(&|| drop(mass_properties(&shape).unwrap()));
            lap(&|| drop(topology(&shape).unwrap()));
            lap(&|| drop(face_graph(&shape).unwrap()));
            lap(&|| drop(crate::analyze(&shape).unwrap()));
            totals[fans as usize] = seconds.iter().sum();
            eprintln!(
                "TIMING strips {strips} fans {fans}: build, bounds, mass, topology, graph, analyze = {seconds:.2?} total {:.2}",
                totals[fans as usize]
            );
        }
        eprintln!("TIMING strips {strips}: fans on over fans off {:.2}", totals[1] / totals[0]);
    }
}

/// The vertex fan shell of the curvature cube (144 B-spline faces of degree 7, hexagon-trimmed star pieces and full fans, sewn: curved pcurves): volume, area, centre and inertia against BRepGProp
/// (volume 5.6e-13, area 3e-14 relative with the fans; 1.6e-12 and 1.3e-11 without, where BRepGProp itself is the less accurate).
#[test]
fn the_strips_integrate_the_vertex_fan_shell_like_brepgprop() {
    let _serial = crate::serial_blends();
    let _hooks = PatchHooks;
    let _reset = CornerHooks;
    for (fans, expected_faces, tolerance) in [(1, 144, 1e-11), (0, 48, 3e-11)] {
        crate::test_bridge::set_corner_fan(fans);
        let shape = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
        for volume in [true, false] {
            let (taken, strips, fixed, seconds) = patch_properties(&shape, volume).unwrap();
            assert_eq!(taken, expected_faces, "fans {fans}");
            assert!(worst(&strips, &fixed) < tolerance, "fans {fans} volume {volume}: {strips:?} against {fixed:?}");
            let _ = seconds;
        }
        // the public numbers (mass, topology) read the same either way
        let on = mass_properties(&shape).unwrap();
        let faces: f64 = topology(&shape).unwrap()["faces"].as_array().unwrap().iter().map(|face| face["area"].as_f64().unwrap()).sum();
        assert!(rel(faces, on.area) < 1e-9, "face areas {faces} against {}", on.area);
        let fresh = profile_of(&cube(10.0), 1.0, 1.0, 0.5).unwrap();
        set_patch_integrator(false);
        let off = mass_properties(&fresh).unwrap();
        set_patch_integrator(true);
        assert!(rel(on.volume, off.volume) < tolerance, "fans {fans}: volume {} against {}", on.volume, off.volume);
        assert!(rel(on.area, off.area) < tolerance, "fans {fans}: area {} against {}", on.area, off.area);
        for k in 0..3 {
            assert!((on.centroid[k] - off.centroid[k]).abs() < 1e-9, "fans {fans}: centroid {k}");
            assert!(
                rel(on.inertia[k], off.inertia[k]) < tolerance,
                "fans {fans}: inertia {k}: {} against {}",
                on.inertia[k],
                off.inertia[k]
            );
        }
    }
}
