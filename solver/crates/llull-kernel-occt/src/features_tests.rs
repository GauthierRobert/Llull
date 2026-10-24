//! Tests of the feature operations in `features.rs` (fillet, chamfer, blend, shell, sweeps, surface faces and slabs).

use crate::features::*;
use crate::features_surface::{face_slab, surface_face};
use crate::Shape;

fn volume(shape: &Shape) -> f64 {
    crate::mass_properties(shape).unwrap().volume
}

fn cube() -> Shape {
    crate::make_box([0.0; 3], [2.0, 2.0, 2.0]).unwrap().unwrap()
}

#[test]
fn a_filleted_edge_removes_the_corner_material() {
    let _serial = crate::serial_blends();
    let rounded = fillet(&cube(), &[0], 0.5, None).unwrap().unwrap();
    let removed = 0.25 * (1.0 - std::f64::consts::PI / 4.0) * 2.0;
    assert!((volume(&rounded) - (8.0 - removed)).abs() < 1e-6);
    assert!(fillet(&cube(), &[99], 0.5, None).unwrap().is_none(), "an edge index out of range is refused");
}

#[test]
fn a_chamfered_edge_removes_a_prism() {
    let _serial = crate::serial_blends();
    let cut = chamfer(&cube(), &[0], 0.5).unwrap().unwrap();
    assert!((volume(&cut) - (8.0 - 0.125 * 2.0)).abs() < 1e-6);
}

#[test]
fn shells_hollow_and_open() {
    let sealed = shell_hollow(&cube(), 0.25).unwrap().unwrap();
    assert!((volume(&sealed) - (8.0 - 1.5f64.powi(3))).abs() < 1e-6);
    let open = shell_open(&cube(), 0.25, &[1.0, 1.0, 2.0]).unwrap().unwrap();
    assert!((volume(&open) - (8.0 - 1.5 * 1.5 * 1.75)).abs() < 1e-6);
}

#[test]
fn a_chain_face_extrudes_and_a_sweep_follows_its_spine() {
    let half_disc = [1.0, -1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0];
    let face = chain_face(&half_disc).unwrap().unwrap();
    let prism = prism_of_face(&face, [0.0, 0.0, 2.0]).unwrap().unwrap();
    assert!((volume(&prism) - std::f64::consts::PI).abs() < 1e-6);
    let section = circle_section([0.0; 3], [0.0, 0.0, 1.0], 1.0, Some(0.5)).unwrap().unwrap();
    let pipe = pipe_solid(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0], &section).unwrap().unwrap();
    assert!((volume(&pipe) - std::f64::consts::PI * 0.75 * 3.0).abs() < 1e-6);
}

/// 03 EQP Q3: a 2:1 ellipsoidal head (radius a, depth b = a / 2) revolved from an exact ellipse quarter is half an ellipsoid, 2/3 pi a^2 b.
#[test]
fn a_revolved_ellipse_quarter_is_an_exact_ellipsoidal_head() {
    let pi = std::f64::consts::PI;
    let (a, b) = (1.0, 0.5);
    let expected = 2.0 / 3.0 * pi * a * a * b;
    // line (0,0)->(a,0); ellipse quarter [(a,0), centre (0,0), (0,b)]; line (0,b)->(0,0)
    let head = [0.0, 0.0, 0.0, 0.0, a, 0.0, 0.0, 3.0, a, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, b, 0.0, 0.0, b, 0.0, 0.0, 0.0, 0.0, 0.0];
    let face = chain_face(&head).unwrap().unwrap();
    let solid = revolution_of_face(&face, [0.0, 1.0, 0.0], 2.0 * pi).unwrap().unwrap();
    assert!((volume(&solid) - expected).abs() < 1e-9 * expected, "volume {} vs {expected}", volume(&solid));
    // the same head traversed the other way round (line up the axis, ellipse [(0, b), centre, (a, 0)], line back): same solid
    let reversed = [0.0, 0.0, 0.0, 0.0, 0.0, b, 0.0, 3.0, 0.0, b, 0.0, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, 0.0, 0.0];
    let face = chain_face(&reversed).unwrap().unwrap();
    let solid = revolution_of_face(&face, [0.0, 1.0, 0.0], 2.0 * pi).unwrap().unwrap();
    assert!((volume(&solid) - expected).abs() < 1e-9 * expected, "reversed volume {} vs {expected}", volume(&solid));
    // a sheared (non-perpendicular conjugate) pair builds; a collinear start / centre / end is refused
    assert!(chain_wire_ok(&[3.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 0.0]).unwrap());
    assert!(!chain_wire_ok(&[3.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0]).unwrap());
}

/// LIM-1 (9): an annulus swept around a closed spine is a valid hollow ring (no caps), like the full section.
#[test]
fn a_hollow_section_around_a_closed_spine_is_a_valid_ring() {
    let ring = [1.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0, -10.0, 0.0, 0.0, 1.0, -10.0, 0.0, 0.0, 0.0, -10.0, 0.0, 10.0, 0.0, 0.0];
    let pi = std::f64::consts::PI;
    for (inner_radius, area) in [(None, 4.0), (Some(1.0), 3.0)] {
        let section = circle_section([10.0, 0.0, 0.0], [0.0, 1.0, 0.0], 2.0, inner_radius).unwrap().unwrap();
        let pipe = pipe_solid(&ring, &section).unwrap().unwrap();
        assert!(is_valid(&pipe).unwrap(), "ring with inner radius {inner_radius:?} is a valid solid");
        let torus = 2.0 * pi * 10.0 * pi * area;
        assert!((volume(&pipe) - torus).abs() < 1e-6 * torus, "volume {} vs {torus}", volume(&pipe));
    }
}

/// Ruled side of a prism: the segment from (ax, ay) to (bx, by) lifted from z = 0 to z = height (degree 1 x 1, 2 x 2 poles).
fn prism_side(a: [f64; 2], b: [f64; 2], height: f64) -> Vec<f64> {
    let mut data = vec![1.0, 1.0, 2.0, 2.0, 2.0, 2.0, 0.0];
    data.extend([a[0], a[1], 0.0, a[0], a[1], height, b[0], b[1], 0.0, b[0], b[1], height]);
    data.extend([0.0, 1.0, 2.0, 2.0, 0.0, 1.0, 2.0, 2.0]);
    data
}

/// SWG M2: lateral faces are sewn into a shell, the two closed boundaries get planar caps, the result is a valid solid of the exact volume.
#[test]
fn a_sheet_solid_closes_lateral_faces_with_two_caps() {
    let sides = [
        prism_side([0.0, 0.0], [2.0, 0.0], 3.0),
        prism_side([2.0, 0.0], [2.0, 1.5], 3.0),
        prism_side([2.0, 1.5], [0.0, 1.5], 3.0),
        prism_side([0.0, 1.5], [0.0, 0.0], 3.0),
    ];
    let solid = sheet_solid(&sides, 1e-6).unwrap().unwrap();
    assert!(is_valid(&solid).unwrap());
    assert!((volume(&solid) - 9.0).abs() < 1e-9, "volume {}", volume(&solid));
    assert!(sheet_solid(&sides[..3], 1e-6).is_err() || sheet_solid(&sides[..3], 1e-6).unwrap().is_none(), "an open prism is refused");
    assert!(sheet_solid(&[], 1e-6).unwrap().is_none(), "no faces");
    assert!(sheet_solid(&[vec![1.0, 2.0]], 1e-6).is_err() || sheet_solid(&[vec![1.0, 2.0]], 1e-6).unwrap().is_none(), "bad data");
}

/// SWG M8: a closed loft (no caps) and a loft closed to a point at one end (one cap) are sewn with the matching number of caps; a wrong count is refused.
#[test]
fn a_sheet_solid_takes_the_expected_number_of_caps() {
    let sides = [
        prism_side([0.0, 0.0], [2.0, 0.0], 3.0),
        prism_side([2.0, 0.0], [2.0, 1.5], 3.0),
        prism_side([2.0, 1.5], [0.0, 1.5], 3.0),
        prism_side([0.0, 1.5], [0.0, 0.0], 3.0),
    ];
    assert!(sheet_solid_capped(&sides, 1e-6, 1).map(|shape| shape.is_none()).unwrap_or(true), "two open ends are not one cap");
    assert!(sheet_solid_capped(&sides, 1e-6, 0).map(|shape| shape.is_none()).unwrap_or(true), "an open prism is not a closed loft");
    let solid = sheet_solid_capped(&sides, 1e-6, 2).unwrap().unwrap();
    assert!((volume(&solid) - 9.0).abs() < 1e-9);
}

/// SWG M8: MakePipeShell fast path: a constant round section along a straight spine is a cylinder; a probe off the result refuses it.
#[test]
fn a_pipe_shell_is_accepted_only_when_it_passes_its_probes() {
    let pi = std::f64::consts::PI;
    let section = circle_section([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 1.0, None).unwrap().unwrap();
    let spine = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0];
    let on_surface = [1.0, 0.0, 1.5, 0.0, -1.0, 2.5];
    let shell = PipeShell {
        mode: 0,
        direction: [0.0, 0.0, 1.0],
        law: &[],
        transition: 0,
        tolerance: 1e-6,
        probes: &on_surface,
        check: 1e-5,
        volume: 0.0,
    };
    let cylinder = pipe_shell_solid(&spine, &section, &shell).unwrap().unwrap();
    assert!((volume(&cylinder) - 3.0 * pi).abs() < 1e-6 * 3.0 * pi, "volume {}", volume(&cylinder));
    let off_surface = [2.0, 0.0, 1.5];
    let missed = PipeShell { probes: &off_surface, ..shell };
    assert!(pipe_shell_solid(&spine, &section, &missed).unwrap().is_none(), "a probe 1 away from the result refuses it");
    let tapered = PipeShell { law: &[0.0, 1.0, 1.0, 0.5], probes: &[], ..shell };
    let cone = pipe_shell_solid(&spine, &section, &tapered).unwrap().expect("the homothetic law builds");
    let frustum = pi * 3.0 * (1.0 + 0.5 + 0.25) / 3.0;
    assert!((volume(&cone) - frustum).abs() < 1e-3 * frustum, "homothetic law volume {} vs {frustum}", volume(&cone));
}

/// SWG review: probes are measured to the BOUNDARY (a point inside a too fat pipe is not on it), and a pipe whose volume differs from the
/// expected one is refused. A linear taper on a line + arc + line spine runs on the length fraction (Law_Interpol), volume pi L 7/12.
#[test]
fn a_pipe_shell_probe_inside_the_solid_and_a_wrong_volume_are_refused() {
    let pi = std::f64::consts::PI;
    let section = circle_section([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], 1.0, None).unwrap().unwrap();
    let h = std::f64::consts::FRAC_1_SQRT_2;
    let spine = [
        0.0,
        0.0,
        0.0,
        0.0,
        10.0,
        0.0,
        0.0, //
        1.0,
        10.0,
        0.0,
        0.0,
        10.0 + 10.0 * h,
        10.0 - 10.0 * h,
        0.0,
        20.0,
        10.0,
        0.0, //
        0.0,
        20.0,
        10.0,
        0.0,
        20.0,
        20.0,
        0.0,
    ];
    let total = 20.0 + 5.0 * pi;
    let exact = pi * total * (7.0 / 12.0);
    let law: Vec<f64> = (0..=64).flat_map(|k| [k as f64 / 64.0, 1.0 - 0.5 * k as f64 / 64.0]).collect();
    // a point of the tapered boundary at the middle of the first line (s = 5): radius 1 - 0.5 * 5 / total
    let on_boundary = [5.0, 1.0 - 0.5 * 5.0 / total, 0.0];
    let inside = [5.0, 0.0, 0.0];
    let shell = PipeShell {
        mode: 0,
        direction: [0.0, 0.0, 1.0],
        law: &law,
        transition: 0,
        tolerance: 1e-6,
        probes: &on_boundary,
        check: 1e-4,
        volume: exact,
    };
    let taper = pipe_shell_solid(&spine, &section, &shell).unwrap().expect("the taper passes its boundary probe and its volume");
    assert!((volume(&taper) - exact).abs() < 1e-5 * exact, "volume {} vs {exact}", volume(&taper));
    let centre = PipeShell { probes: &inside, ..shell };
    assert!(pipe_shell_solid(&spine, &section, &centre).unwrap().is_none(), "a probe on the axis is 0.9 inside the boundary, not on it");
    let fat = PipeShell { volume: exact * 1.01, ..shell };
    assert!(pipe_shell_solid(&spine, &section, &fat).unwrap().is_none(), "a pipe 1 % off the fitted volume is refused");
}

/// SWG M3: MakePipe along the exact helix edge has the closed-form volume pi r^2 L to ~2e-6 (OCC's pipe surface is itself an approximation; the host
/// uses fitted faces where 1e-6 matters), also left-handed.
#[test]
fn a_pipe_along_an_exact_helix_has_the_closed_form_volume() {
    let pi = std::f64::consts::PI;
    let section = |center: [f64; 3], tangent: [f64; 3]| circle_section(center, tangent, 0.5, None).unwrap().unwrap();
    // origin, axis, x direction, radius, end radius, turns, pitch, left, start angle
    let cylinder = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 5.0, 5.0, 3.0, 2.0, 0.0, 0.0];
    let lead = 2.0 / (2.0 * pi);
    let tangent = {
        let n = (25.0f64 + lead * lead).sqrt();
        [0.0, 5.0 / n, lead / n]
    };
    let pipe = helix_pipe_solid(&cylinder, &section([5.0, 0.0, 0.0], tangent)).unwrap().unwrap();
    let length = 3.0 * 2.0 * pi * (25.0f64 + lead * lead).sqrt();
    assert!((volume(&pipe) - pi * 0.25 * length).abs() < 5e-6 * pi * 0.25 * length, "volume {} vs {}", volume(&pipe), pi * 0.25 * length);
    let mut left = cylinder;
    left[13] = 1.0;
    let mirrored = helix_pipe_solid(&left, &section([5.0, 0.0, 0.0], [0.0, -tangent[1], tangent[2]])).unwrap().unwrap();
    assert!((volume(&mirrored) - volume(&pipe)).abs() < 5e-6 * volume(&pipe));
    assert!(helix_pipe_solid(&cylinder[..14], &section([5.0, 0.0, 0.0], tangent)).is_err(), "inconsistent data is an error");
}

/// Bilinear sheet over [0, 4] x [0, 3] (degree 1 x 1, one span, 2 x 2 poles).
fn flat_sheet() -> Vec<f64> {
    let mut data = vec![1.0, 1.0, 2.0, 2.0, 2.0, 2.0, 0.0];
    data.extend([0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0]);
    data.extend([0.0, 1.0, 2.0, 2.0, 0.0, 1.0, 2.0, 2.0]);
    data
}

/// Exact quarter cylinder (radius 10, axis z, height 5) as a rational degree 2 x 1 patch: u along the arc, v along the axis.
fn quarter_cylinder_sheet() -> Vec<f64> {
    let w = std::f64::consts::FRAC_1_SQRT_2;
    let mut data = vec![2.0, 1.0, 3.0, 2.0, 2.0, 2.0, 1.0];
    for (x, y) in [(10.0, 0.0), (10.0, 10.0), (0.0, 10.0)] {
        data.extend([x, y, 0.0, x, y, 5.0]);
    }
    data.extend([1.0, 1.0, w, w, 1.0, 1.0]);
    data.extend([0.0, 1.0, 3.0, 3.0, 0.0, 1.0, 2.0, 2.0]);
    data
}

fn rectangle(u0: f64, v0: f64, u1: f64, v1: f64) -> Vec<f64> {
    vec![1.0, 4.0, 1.0, u0, v0, u1, v0, u1, v1, u0, v1]
}

#[test]
fn a_b_spline_sheet_is_an_exact_face_with_optional_trims() {
    let whole = surface_face(0, &flat_sheet(), &[]).unwrap().unwrap();
    let area = crate::mass_properties(&whole).unwrap().area;
    assert!((area - 12.0).abs() < 1e-9, "sheet area {area}");
    let trimmed = surface_face(0, &flat_sheet(), &rectangle(0.25, 1.0 / 6.0, 0.75, 5.0 / 6.0)).unwrap().unwrap();
    let area = crate::mass_properties(&trimmed).unwrap().area;
    assert!((area - 4.0).abs() < 1e-9, "trimmed area {area}");
    // the whole sheet minus the hole [0.25, 0.75] x [1/3, 2/3] (2 x 1 in space)
    let mut with_hole = vec![2.0, 4.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0];
    with_hole.extend([4.0, 0.0, 0.25, 1.0 / 3.0, 0.75, 1.0 / 3.0, 0.75, 2.0 / 3.0, 0.25, 2.0 / 3.0]);
    let holed = surface_face(0, &flat_sheet(), &with_hole).unwrap().unwrap();
    let area = crate::mass_properties(&holed).unwrap().area;
    assert!((area - 10.0).abs() < 1e-9, "holed area {area}");
    assert!(surface_face(0, &[1.0, 1.0], &[]).is_err(), "inconsistent data is an error");
}

/// Loop and surface lists come from stored documents: counts that are fractional, huge, negative or NaN must be errors, never an out-of-range read.
#[test]
fn malformed_surface_and_loop_data_is_an_error_not_a_crash() {
    let plane = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let good = rectangle(0.0, 0.0, 1.0, 1.0);
    let bad_loops: Vec<Vec<f64>> = vec![
        vec![1e19, 4.0, 1.0],
        vec![1.0, 1e19, 1.0, 0.0, 0.0],
        vec![1.0, -1.0, 1.0, 0.0, 0.0],
        vec![f64::NAN, 4.0, 1.0],
        vec![1.0, f64::NAN, 1.0],
        vec![1.0, 4.5, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
        vec![1.0, 2.0, 1.0, 0.0, 0.0, 1.0, 0.0],
        vec![1.0, 4.0, 2.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
        vec![1.0, 4.0, 1.0, 0.0, 0.0],
        vec![2.0, 4.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 4.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
        vec![0.0],
    ];
    for loops in &bad_loops {
        assert!(surface_face(1, &plane, loops).is_err(), "loops {loops:?}");
        assert!(face_slab(1, &plane, loops, [0.0, 1.0], [0.0, 0.0, 1.0], 1e-6).is_err(), "slab loops {loops:?}");
    }
    let mut trailing = good.clone();
    trailing.push(7.0);
    assert!(surface_face(1, &plane, &trailing).is_err(), "trailing data");
    let mut sheet = flat_sheet();
    for (index, value) in [(0, 1e19), (2, f64::NAN), (3, -4.0), (4, 2.5), (6, 2.0)] {
        let previous = sheet[index];
        sheet[index] = value;
        assert!(surface_face(0, &sheet, &[]).is_err(), "sheet field {index} = {value}");
        sheet[index] = previous;
    }
    let mut multiplicity = flat_sheet();
    let last = multiplicity.len() - 1;
    multiplicity[last] = f64::NAN;
    assert!(surface_face(0, &multiplicity, &[]).is_err());
    assert!(surface_face(2, &[0.0; 9], &[]).is_err() && surface_face(7, &[], &[]).is_err());
    assert!(surface_face(0, &flat_sheet(), &[]).unwrap().is_some(), "the untouched data still builds");
}

#[test]
fn slabs_over_plane_cylinder_cone_and_b_spline_faces_have_the_exact_volume() {
    let tolerance = 1e-6;
    let plane = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let slab = face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [0.0, 0.5], [0.0, 0.0, 1.0], tolerance).unwrap().unwrap();
    let mass = crate::mass_properties(&slab).unwrap();
    assert!((mass.volume - 6.0).abs() < 1e-7, "plane slab {}", mass.volume);
    let lifted = face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [1.0, 1.5], [0.0, 0.0, 1.0], tolerance).unwrap().unwrap();
    let top = crate::mass_properties(&lifted).unwrap().centroid[2] - 0.25;
    assert!((top - 1.0).abs() < 1e-7, "lifted slab centroid {top}");
    let down = face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [0.0, 0.5], [0.0, 0.0, -1.0], tolerance).unwrap().unwrap();
    let bottom = crate::mass_properties(&down).unwrap().centroid[2] - 0.25;
    assert!((bottom + 0.5).abs() < 1e-7, "lifted against the reference direction {bottom}");
    // quarter of a cylinder shell, radius 10 -> 12, height 5
    let cylinder = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 10.0];
    let arc = std::f64::consts::FRAC_PI_2;
    let expected = 0.5 * arc * (144.0 - 100.0) * 5.0;
    let shell = face_slab(2, &cylinder, &rectangle(0.0, 0.0, arc, 5.0), [0.0, 2.0], [1.0, 0.0, 0.0], tolerance).unwrap().unwrap();
    let volume = crate::mass_properties(&shell).unwrap().volume;
    assert!((volume / expected - 1.0).abs() < 1e-6, "cylinder slab {volume} vs {expected}");
    // the same patch as a rational B-spline sheet
    let nurbs = face_slab(0, &quarter_cylinder_sheet(), &[], [0.0, 2.0], [1.0, 0.0, 0.0], tolerance).unwrap().unwrap();
    let volume = crate::mass_properties(&nurbs).unwrap().volume;
    assert!((volume / expected - 1.0).abs() < 1e-5, "B-spline slab {volume} vs {expected}");
    // full turn: the periodic seam
    let full = std::f64::consts::TAU;
    let ring = face_slab(2, &cylinder, &rectangle(0.0, 0.0, full, 5.0), [0.0, 2.0], [1.0, 0.0, 0.0], tolerance).unwrap().unwrap();
    let volume = crate::mass_properties(&ring).unwrap().volume;
    let expected_ring = std::f64::consts::PI * (144.0 - 100.0) * 5.0;
    assert!((volume / expected_ring - 1.0).abs() < 1e-6, "full tube {volume} vs {expected_ring}");
    // cone: apex at the origin, semi-angle 30 degrees, generators 20 .. 30, a 90-degree sector, lifted by 1
    let half = std::f64::consts::FRAC_PI_6;
    let cone = [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, half];
    let cone_slab = face_slab(3, &cone, &rectangle(0.0, 20.0, arc, 30.0), [0.0, 1.0], [0.0, 1.0, 0.0], tolerance);
    let volume = crate::mass_properties(&cone_slab.unwrap().unwrap()).unwrap().volume;
    let area = 0.5 * arc * half.sin() * (900.0 - 400.0) + 0.5 * half.cos() * arc * 10.0;
    assert!((volume / area - 1.0).abs() < 1e-6, "cone slab {volume} vs exact {area}");
    assert!(crate::analyze(&ring).unwrap().valid, "the full tube is a valid solid");
    assert!(face_slab(1, &plane, &rectangle(0.0, 0.0, 4.0, 3.0), [1.0, 1.0], [0.0, 0.0, 1.0], tolerance).unwrap().is_none());
}

/// As ONE multi-span edge per section the loft was exact but OCC's Gauss rule under-integrated its faces (square 6.963 instead of 8, circle
/// 0.9 % high; the fine tessellations gave 8 and 2 pi). Each knot span of a section is now its own edge.
#[test]
fn b_spline_sections_integrate_to_the_exact_volume() {
    let square = |z: f64| -> Vec<f64> {
        let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
        let mut data = vec![1.0, 5.0, 5.0, 0.0, 0.0];
        data.extend(corners.iter().flat_map(|corner| [corner[0], corner[1], z]));
        data.extend([0.0, 1.0, 2.0, 3.0, 4.0, 2.0, 1.0, 1.0, 1.0, 2.0]);
        data
    };
    let prism = skinned_solid_bsplines(&[square(0.0), square(2.0)], true).unwrap().unwrap();
    let mass = crate::mass_properties(&prism).unwrap();
    assert!((mass.volume - 8.0).abs() < 1e-9, "square loft volume {}", mass.volume);
    assert!((mass.area - 24.0).abs() < 1e-9, "square loft area {}", mass.area);
    let lumps = crate::analyze(&prism).unwrap().lumps;
    assert!((lumps[0] - 8.0).abs() < 1e-9, "analyze lump volume {}", lumps[0]);
    let circle = |z: f64| -> Vec<f64> {
        let w = std::f64::consts::FRAC_1_SQRT_2;
        let poles = [[1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [-1.0, 1.0], [-1.0, 0.0], [-1.0, -1.0], [0.0, -1.0], [1.0, -1.0], [1.0, 0.0]];
        let mut data = vec![2.0, 9.0, 5.0, 1.0, 0.0];
        data.extend(poles.iter().flat_map(|pole| [pole[0], pole[1], z]));
        data.extend([1.0, w, 1.0, w, 1.0, w, 1.0, w, 1.0]);
        data.extend([0.0, 1.0, 2.0, 3.0, 4.0, 3.0, 2.0, 2.0, 2.0, 3.0]);
        data
    };
    let cylinder = skinned_solid_bsplines(&[circle(0.0), circle(2.0)], true).unwrap().unwrap();
    let mass = crate::mass_properties(&cylinder).unwrap();
    assert!((mass.volume - 2.0 * std::f64::consts::PI).abs() < 1e-7, "rational circle loft volume {}", mass.volume);
}
