//! DISP1: the display deflection follows the size of the part, so one large blend face stays a bounded mesh and a small part meshes as before.

use crate::features::fillet_laws;
use crate::mesh::{display_mesh, is_closed_mesh, mesh_at, scaled_linear};
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
fn the_linear_deflection_grows_with_the_diagonal_above_the_knee() {
    assert_eq!(scaled_linear(0.1, 100.0), 0.1);
    assert_eq!(scaled_linear(0.1, 5.0), 0.1);
    assert_eq!(scaled_linear(0.02, 100.0), 0.02);
    assert!((scaled_linear(0.1, 1000.0) - 1.0).abs() < 1e-12);
    assert!((scaled_linear(0.02, 1000.0) - 0.2).abs() < 1e-12);
}

#[test]
fn a_non_finite_or_unbounded_diagonal_keeps_the_floor() {
    for diagonal in [f64::NAN, f64::INFINITY, 1e100, 2e12, 0.0] {
        assert_eq!(scaled_linear(0.1, diagonal), 0.1, "diagonal {diagonal}");
    }
}

#[test]
fn a_small_part_meshes_exactly_as_with_the_fixed_display_deflection() {
    let _serial = crate::serial_blends();
    let small = blended_block(1.0);
    let fixed = crate::tessellate(&small, 0.1, 0.5).unwrap();
    let shown = display_mesh(&small).unwrap().unwrap();
    assert_eq!(shown.indices, fixed.indices);
    assert_eq!(shown.positions, fixed.positions);
}

#[test]
fn the_bounding_diagonal_is_that_of_the_tight_box_and_is_kept() {
    let shape = make_box([0.0; 3], [3.0, 4.0, 12.0]).unwrap().unwrap();
    assert!((crate::bounding_diagonal(&shape).unwrap() - 13.0).abs() < 1e-9);
    assert_eq!(crate::bounding_diagonal(&shape).unwrap(), crate::bounding_diagonal(&shape).unwrap());
}

/// Signed volume of a closed triangle mesh.
fn mesh_volume(mesh: &crate::MeshOut) -> f64 {
    let point = |index: u32| -> [f64; 3] {
        let at = 3 * index as usize;
        [mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]]
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (point(t[0]), point(t[1]), point(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
        })
        .sum()
}

/// The inscribed mesh of a sphere of diameter 2000 loses at most `area x deflection` of volume, the deflection being 1e-3 of the box diagonal (a literal
/// here: loosening the factor in `mesh.rs` fails this test).
#[test]
fn a_large_sphere_display_mesh_stays_within_the_stated_deflection_of_the_exact_volume() {
    let _serial = crate::serial_blends();
    let sphere = crate::make_sphere(1000.0).unwrap().unwrap();
    let exact = crate::mass_properties(&sphere).unwrap().volume;
    let area = 4.0 * std::f64::consts::PI * 1000.0 * 1000.0;
    let deflection = 1e-3 * crate::bounding_diagonal(&sphere).unwrap();
    let mesh = display_mesh(&sphere).unwrap().unwrap();
    let deficit = exact - mesh_volume(&mesh);
    assert!(deficit > 0.0 && deficit <= area * deflection, "deficit {deficit} against the bound {}", area * deflection);
    assert!(mesh.indices.len() / 3 < 20_000, "{} triangles", mesh.indices.len() / 3);
}

#[test]
fn large_closed_solids_with_seams_keep_a_closed_display_mesh() {
    let _serial = crate::serial_blends();
    for (name, shape) in [
        ("sphere D 1000", crate::make_sphere(500.0).unwrap().unwrap()),
        ("torus D 1000", crate::make_torus(400.0, 100.0).unwrap().unwrap()),
        ("sphere D 20000", crate::make_sphere(10_000.0).unwrap().unwrap()),
    ] {
        let mesh = display_mesh(&shape).unwrap().unwrap_or_else(|| panic!("{name}: refused as open"));
        assert!(is_closed_mesh(&mesh.positions, &mesh.indices), "{name} is open");
    }
}

#[test]
fn an_explicit_deflection_bypasses_the_size_scaling() {
    let _serial = crate::serial_blends();
    let sphere = crate::make_sphere(1000.0).unwrap().unwrap();
    let displayed = display_mesh(&sphere).unwrap().unwrap().indices.len();
    let exact = mesh_at(&sphere, 0.1, 0.5).unwrap().unwrap().indices.len();
    assert!(exact > 20 * displayed, "display {displayed}, explicit 0.1: {exact}");
    let same = mesh_at(&sphere, scaled_linear(0.1, crate::bounding_diagonal(&sphere).unwrap()), 0.5).unwrap().unwrap();
    assert_eq!(same.indices.len(), displayed);
}
