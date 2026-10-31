//! BLD §13.33.5: the sealed shell of a solid with corner-star faces (`shell_hollow`, `cpp/features.cxx`).

use crate::blend_corner_tests::{cube, cube_vertices, cut_block_setback, spec, CornerHooks};
use crate::features::{fillet_setback, shell_hollow};
use crate::Shape;

/// Puts the pole limit of the sealed shell back, even when the test fails.
struct ShellHooks;

impl Drop for ShellHooks {
    fn drop(&mut self) {
        crate::test_bridge::set_shell_star_pole_limit(36);
    }
}

/// The refusal of the sealed shell of `shape` (a test failure when it is not refused).
fn refusal_of(shape: &Shape) -> String {
    match shell_hollow(shape, 0.2) {
        Err(text) => text,
        Ok(_) => panic!("the sealed shell was not refused"),
    }
}

fn cube_of_stars() -> Shape {
    let shape = cube(10.0);
    let all: Vec<usize> = (0..12).collect();
    let (edges, corners) = spec(&shape, &all, 1.0, &cube_vertices(10.0), 2.0);
    fillet_setback(&shape, &edges, &corners).unwrap().expect("a solid")
}

/// BLD §13.33.5: measured on the cylinder block of 13.22.6 (thickness 0.2), the inward offset of star faces of 27 poles takes 26 s (a valid hollow solid), of 54 poles 161 to 166 s and of 70 poles
/// 410 s, and with 54 or more it returns the full solid with no cavity. So a solid with star faces of 36 poles or more in a direction is refused by name BEFORE the offset (here the block with
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
