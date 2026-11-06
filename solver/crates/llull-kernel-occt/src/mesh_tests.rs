//! DISP1: the display deflection follows the size of the part, so one large blend face stays a bounded mesh and a small part meshes as before.

use crate::features::fillet_laws;
use crate::mesh::{display_mesh, scaled_linear};
use crate::queries::topology;
use crate::{make_box, Shape};

fn number(value: &serde_json::Value) -> f64 {
    value.as_f64().unwrap()
}

/// The 20 x 10 x 5 block of DES-6c scaled by `scale`; its top long edge carries the straight radius law 1 -> 2 (also scaled): one B-spline blend face.
fn blended_block(scale: f64) -> Shape {
    let block = make_box([0.0; 3], [20.0 * scale, 10.0 * scale, 5.0 * scale]).unwrap().unwrap();
    let topo = topology(&block).unwrap();
    let at = |edge: &serde_json::Value, key: &str, axis: usize, value: f64| (number(&edge[key][axis]) - value).abs() < 1e-9;
    let top = topo["edges"]
        .as_array()
        .unwrap()
        .iter()
        .position(|e| ["start", "end"].iter().all(|key| at(e, key, 2, 5.0 * scale) && at(e, key, 1, 10.0 * scale)))
        .unwrap() as u32;
    fillet_laws(&block, &[top], &[scale, 2.0 * scale, 1.0, 0.0]).unwrap().unwrap()
}

fn triangles(shape: &Shape) -> usize {
    display_mesh(shape).unwrap().unwrap().indices.len() / 3
}

#[test]
fn a_large_blend_face_meshes_to_a_bounded_triangle_count() {
    let _serial = crate::serial_blends();
    let count = triangles(&blended_block(1000.0));
    assert!(count < 5_000, "{count} triangles");
}

#[test]
fn a_small_part_keeps_the_display_floor() {
    let _serial = crate::serial_blends();
    assert_eq!(scaled_linear(0.1, 100.0), 0.1);
    assert_eq!(scaled_linear(0.1, 5.0), 0.1);
    assert_eq!(scaled_linear(0.02, 100.0), 0.02);
    assert!((scaled_linear(0.1, 1000.0) - 1.0).abs() < 1e-12);
    assert!((scaled_linear(0.02, 1000.0) - 0.2).abs() < 1e-12);
    assert_eq!(scaled_linear(0.1, f64::NAN), 0.1);
    let small = blended_block(1.0);
    let fixed = crate::tessellate(&small, 0.1, 0.5).unwrap();
    assert_eq!(display_mesh(&small).unwrap().unwrap().indices.len(), fixed.indices.len());
}

#[test]
fn the_bounding_diagonal_is_that_of_the_tight_box() {
    let shape = make_box([0.0; 3], [3.0, 4.0, 12.0]).unwrap().unwrap();
    assert!((crate::bounding_diagonal(&shape).unwrap() - 13.0).abs() < 1e-9);
}
