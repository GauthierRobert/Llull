//! DES-6c 13.33.7: `edgeContinuity` reads a SIGNED normal angle (`g1Signed`: convex fold positive, concave negative) that does not depend on the order of the two faces of the edge.

use crate::blend_corner_tests::{cube, num, point};
use crate::queries::{edge_continuity, topology};
use crate::{boolean, make_box, BooleanOp, Shape};
use std::f64::consts::FRAC_PI_2;

/// The signed angle at the middle sample of every edge of `shape` that folds by 90 degrees, with the edge's mid point.
fn folds(shape: &Shape) -> Vec<([f64; 3], f64)> {
    let topo = topology(shape).unwrap();
    let mut found = Vec::new();
    for (index, edge) in topo["edges"].as_array().unwrap().iter().enumerate() {
        let samples = edge_continuity(shape, index as f64, 3.0).unwrap();
        let middle = &samples[1];
        if (num(&middle["g1"]) - FRAC_PI_2).abs() < 1e-6 {
            found.push((point(&edge["mid"]), num(&middle["g1Signed"])));
        }
    }
    found
}

/// A 10-cube with a 10 x 5 x 10 block on top: `y0` and `y1` are the extent of the block in y. Its inner edge runs along x at (y = 5 or 5, z = 10).
fn l_shape(y0: f64, y1: f64) -> Shape {
    let base = cube(10.0);
    let top = make_box([0.0, y0, 10.0], [10.0, y1 - y0, 10.0]).unwrap().unwrap();
    boolean(BooleanOp::Union, &base, &top, true).unwrap().unwrap()
}

#[test]
fn every_edge_of_a_cube_reads_a_convex_quarter_turn() {
    let found = folds(&cube(10.0));
    assert_eq!(found.len(), 12);
    for (mid, signed) in found {
        assert!((signed - FRAC_PI_2).abs() < 1e-6, "{mid:?}: {signed}");
    }
}

/// The inner edge of an L (two faces meeting at a re-entrant corner) reads -pi/2, and so it does on the mirrored solid, where the two faces come in another order; the outer edges stay +pi/2.
#[test]
fn the_inner_edge_of_an_l_shape_reads_a_concave_quarter_turn_in_either_face_order() {
    for (y0, y1, inner_y) in [(0.0, 5.0, 5.0), (5.0, 10.0, 5.0)] {
        let found = folds(&l_shape(y0, y1));
        let concave: Vec<_> = found.iter().filter(|(_, signed)| *signed < 0.0).collect();
        assert_eq!(concave.len(), 1, "{y0}: {found:?}");
        let (mid, signed) = concave[0];
        assert!((signed + FRAC_PI_2).abs() < 1e-6 && (mid[1] - inner_y).abs() < 1e-6 && (mid[2] - 10.0).abs() < 1e-6, "{mid:?} {signed}");
        assert!(found.iter().filter(|(_, signed)| (signed - FRAC_PI_2).abs() < 1e-6).count() >= 8, "{found:?}");
    }
}
