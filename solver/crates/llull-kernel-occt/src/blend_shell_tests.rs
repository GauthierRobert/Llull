//! BLD §13.33.5: the sealed shell of a solid with corner-star faces (`shell_hollow`, `cpp/features.cxx`).
//! Convention of the workspace for measurements that take minutes (`llull-topopt`, `llull-voxfe`): `#[ignore = "..."]`, run with `cargo test --release -p llull-kernel-occt blend_shell_tests -- --ignored`.
//! `native:check` (cargo test, default members or --workspace in debug) therefore skips them; the pole gate, the fault hook and the 8-pole cube run in it.

use crate::blend_corner_tests::{cube, cube_vertices, cut_block_setback, spec, CornerHooks};
use crate::features::{fillet_setback, shell_hollow};
use crate::{analyze, mass_properties, Shape};

/// Puts the pole limit of the sealed shell back, even when the test fails.
struct ShellHooks;

impl Drop for ShellHooks {
    fn drop(&mut self) {
        crate::test_bridge::set_shell_star_pole_limit(30);
        crate::test_bridge::set_shell_fault(0);
    }
}

/// The refusal of the sealed shell of `shape` (a test failure when it is not refused).
fn refusal_of_thickness(shape: &Shape, thickness: f64) -> String {
    match shell_hollow(shape, thickness) {
        Err(text) => text,
        Ok(_) => panic!("the sealed shell was not refused"),
    }
}

fn refusal_of(shape: &Shape) -> String {
    refusal_of_thickness(shape, 0.2)
}

fn cube_of_stars() -> Shape {
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let (edges, corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), 2.0);
    fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid")
}

/// BLD §13.33.5: measured on the cylinder block of 13.22.6 (thickness 0.2), the inward offset of star faces of 27 poles takes 26 s (a valid hollow solid), of 54 poles 161 to 166 s and of 70 poles
/// 410 s, and with 54 or more it returns the full solid with no cavity. So a solid with star faces of 30 poles or more in a direction is refused by name BEFORE the offset (here the block with
/// setbacks 1.2 / 1.2 / 1.3, 54 poles: the refusal takes milliseconds), and a star of 8 poles (the cube) is not refused.
#[test]
fn a_sealed_shell_of_fine_star_faces_is_refused_by_name_before_the_offset() {
    let _serial = crate::serial_blends();
    let _corner = CornerHooks;
    let _shell = ShellHooks;
    let block = cut_block_setback(12.0, 1.3).expect("the block with fine stars");
    let start = std::time::Instant::now();
    let refusal = refusal_of(&block);
    assert!(start.elapsed().as_secs_f64() < 60.0, "before the offset (the offset takes 160 s): {:?}", start.elapsed());
    assert!(
        refusal.starts_with("[SHL_STAR_FACES]") && refusal.contains("openFacesNear") && refusal.contains("poles per direction"),
        "{refusal}"
    );
    assert_eq!(crate::test_bridge::last_shell_star_poles(), 54, "the finest star face of the block, measured");
    // (the block was built with the trim hooks; the cube is built the ordinary way)
    crate::test_bridge::set_corner_trim(false);
    crate::test_bridge::set_corner_exact_patch(1);
    // a cube of stars (8 poles) goes to the offset: not a star refusal (OCCT's own answer, a null for this thickness)
    let cube = cube_of_stars();
    assert!(shell_hollow(&cube, 0.2).is_ok());
    assert_eq!(crate::test_bridge::last_shell_star_poles(), 8);
    // the limit is a number, not a name: lowered to 8 it refuses the cube too
    crate::test_bridge::set_shell_star_pole_limit(8);
    assert!(refusal_of(&cube).starts_with("[SHL_STAR_FACES]"));
}

/// The volume the sealed shell of `shape` must have lost (the bound of the check of the kernel).
fn least_drop(shape: &Shape, thickness: f64) -> f64 {
    0.25 * mass_properties(shape).unwrap().area * thickness
}

/// BLD §13.33.6: with the pole gate off, the 54-pole block (setbacks 1.2 / 1.2 / 1.3, 160 s) comes out of the offset and the cut as a solid that BRepCheck rejects (volume 474.5 -> 402.7, a broken
/// cavity): the kernel refuses it by name from its result, not as a hollow solid.
#[test]
#[ignore = "160 s (release): cargo test --release -p llull-kernel-occt blend_shell_tests -- --ignored"]
fn a_sealed_shell_of_54_poles_with_the_gate_off_is_refused_by_name_from_its_result() {
    let _serial = crate::serial_blends();
    let _corner = CornerHooks;
    let _shell = ShellHooks;
    let block = cut_block_setback(12.0, 1.3).expect("the block with fine stars");
    crate::test_bridge::set_shell_star_pole_limit(1000);
    let refusal = refusal_of(&block);
    assert_eq!(crate::test_bridge::last_shell_star_poles(), 54);
    assert!(refusal.starts_with("[SHL_INVALID_CAVITY]") && refusal.contains("not valid"), "{refusal}");
}

/// A cut that answers the source solid (the failure the offset of fine star faces was first read as) is refused as a solid without its cavity (hook `set_shell_fault`).
#[test]
fn a_sealed_shell_whose_result_is_the_full_solid_is_refused_without_its_cavity() {
    let _serial = crate::serial_blends();
    let _shell = ShellHooks;
    assert!(shell_hollow(&cube(10.0), 1.0).unwrap().is_some(), "the sealed shell of a plain cube builds");
    crate::test_bridge::set_shell_fault(1);
    let refusal = refusal_of_thickness(&cube(10.0), 1.0);
    assert_eq!(refusal, "[SHL_NO_CAVITY] the offset returned a solid without its cavity");
}

/// Star faces of 42 poles with the gate off (measured, radius 13, setbacks 1.2 / 1.2 / 1.3): at thickness 0.2 (1 shell, more faces than the source, a valid solid that lost 72 mm3) and at 0.4 (73 s,
/// lost 141 mm3, not valid) the result has no second shell: both are refused by name as a solid without its cavity. Minutes in release: `--ignored` (see the module doc).
#[test]
#[ignore = "minutes (release): cargo test --release -p llull-kernel-occt blend_shell_tests -- --ignored"]
fn a_sealed_shell_of_42_poles_with_the_gate_off_is_refused_without_its_cavity_at_0_2_and_0_4() {
    let _serial = crate::serial_blends();
    let _corner = CornerHooks;
    let _shell = ShellHooks;
    let block = cut_block_setback(13.0, 1.3).expect("the block with stars of 42 poles");
    crate::test_bridge::set_shell_star_pole_limit(1000);
    for thickness in [0.2, 0.4] {
        assert_eq!(
            refusal_of_thickness(&block, thickness),
            "[SHL_NO_CAVITY] the offset returned a solid without its cavity",
            "{thickness}"
        );
    }
    assert_eq!(crate::test_bridge::last_shell_star_poles(), 42);
}

/// 27 poles (setbacks 1.2 on the three edges) stay under the gate: the sealed shell builds, valid, with its cavity.
#[test]
#[ignore = "26 s (release), minutes in debug: cargo test --release -p llull-kernel-occt blend_shell_tests -- --ignored"]
fn a_sealed_shell_of_star_faces_of_27_poles_still_builds() {
    let _serial = crate::serial_blends();
    let _corner = CornerHooks;
    let _shell = ShellHooks;
    let block = cut_block_setback(12.0, 1.2).expect("the block with stars of 27 poles");
    let shell = shell_hollow(&block, 0.2).expect("not refused").expect("a solid");
    assert_eq!(crate::test_bridge::last_shell_star_poles(), 27);
    let drop = mass_properties(&block).unwrap().volume - mass_properties(&shell).unwrap().volume;
    assert!(drop >= least_drop(&block, 0.2) && analyze(&shell).unwrap().valid, "the volume dropped by {drop}");
}
