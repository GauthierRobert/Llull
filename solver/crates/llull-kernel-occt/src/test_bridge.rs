//! Test-only view of the mass-rule flags of a shape (`cpp/facade.hxx`): not part of the shipped API (this module exists only under `cfg(test)`;
//! the C++ glue cxx generates for it is unused by the binary).

use crate::Shape;

#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/facade.hxx");

        type Shape = crate::ffi::Shape;

        /// `Shape::refined_mass`: the shape asks for the adaptive mass rule.
        fn refined_mass_flag(shape: &Shape) -> bool;
        /// Whether the per-face areas use the adaptive rule: refined and with a freeform face.
        fn adaptive_rule(shape: &Shape) -> bool;
        /// The number of threads the corner fills of the next builds use (0: default).
        fn set_corner_threads(count: i32);
        /// The threads the last corner fill used.
        fn last_corner_threads() -> i32;
        /// The corner whose fill throws std::bad_alloc (-1: none).
        fn set_corner_fault(corner: i32);
        /// The worker whose creation fails (-1: none).
        fn set_corner_spawn_limit(workers: i32);
        /// The corner patch: 0 MakeFilling only, 1 the exact star first (default), 2 the exact star refused (MakeFilling is the fallback).
        fn set_corner_exact_patch(mode: i32);
        /// Whether every setback step uses the rolling-ball trim builder (13.22).
        fn set_corner_trim(on: bool);
        /// The pole count from which a sealed shell of a solid with corner-star faces refuses by name.
        fn set_shell_star_pole_limit(limit: i32);
        /// 1: the cut of a sealed shell answers the source solid (a result without its cavity); 0: off.
        fn set_shell_fault(fault: i32);
        /// The most poles in a direction of a star face seen by the last sealed shell (0: none).
        fn last_shell_star_poles() -> i32;
        /// The largest interior crease (rad) of the star sub-patches accepted since the last set_corner_exact_patch.
        fn last_corner_crease() -> f64;
        /// Whether the interior crease of the star sub-patches is gated (default) or only measured.
        fn set_corner_crease_gate(on: bool);
        /// Whether the star sub-patches take only C0 knots at the joints of their chains (no C1 attempt).
        fn set_corner_c0_knots(on: bool);
        fn set_corner_g2_star(on: bool);
        /// Every arc length inversion of a radius law on an uneven edge after the first `after` fails (-1: off).
        fn set_law_inversion_fault(after: i32);
        /// The most nodes a stretch of a radius law on an uneven edge may take (0: the default, 128).
        fn set_law_node_cap(nodes: i32);
        /// How many faces the mass rule by knot span cuts into pieces.
        fn span_cut_count(shape: &Shape) -> i32;
        /// The oriented angle across the tangent edges of a face, the face reversed in a rebuilt shell or not.
        fn oriented_angle_probe(shape: &Shape, face: i32, reverse: bool) -> f64;
        /// The boundary angle of a face against its neighbours (-1: not measured), with the first loop edge dropped from the boundary or not.
        fn boundary_angle_probe(shape: &Shape, face: i32, drop_one: bool) -> f64;
        /// `[Bezier-patch box, AddOptimal box, dense sample box]` (6 numbers each) of a synthetic many-patch B-spline face; the first box is zeros when the fast path refuses the face.
        fn spline_bounds_probe(kind: i32) -> Vec<f64>;
    }
}

pub fn refined_mass(shape: &Shape) -> bool {
    ffi::refined_mass_flag(crate::inner(shape).expect("a shape"))
}

pub fn oriented_angle(shape: &Shape, face: i32, reverse: bool) -> f64 {
    ffi::oriented_angle_probe(crate::inner(shape).expect("a shape"), face, reverse)
}

pub fn boundary_angle(shape: &Shape, face: i32, drop_one: bool) -> f64 {
    ffi::boundary_angle_probe(crate::inner(shape).expect("a shape"), face, drop_one)
}

pub fn span_cut_count(shape: &Shape) -> i32 {
    ffi::span_cut_count(crate::inner(shape).expect("a shape"))
}

pub fn set_corner_threads(count: i32) {
    ffi::set_corner_threads(count);
}

pub fn last_corner_threads() -> i32 {
    ffi::last_corner_threads()
}

pub fn set_corner_fault(corner: i32) {
    ffi::set_corner_fault(corner);
}

pub fn set_corner_spawn_limit(workers: i32) {
    ffi::set_corner_spawn_limit(workers);
}

pub fn last_corner_crease() -> f64 {
    ffi::last_corner_crease()
}

pub fn set_law_node_cap(nodes: i32) {
    ffi::set_law_node_cap(nodes);
}

pub fn set_law_inversion_fault(after: i32) {
    ffi::set_law_inversion_fault(after);
}

pub fn set_corner_c0_knots(on: bool) {
    ffi::set_corner_c0_knots(on);
}

/// Test hook: false builds the G1 star for a curvature profile too (the G2 star is the default there, BLD 13.36).
pub fn set_corner_g2_star(on: bool) {
    ffi::set_corner_g2_star(on);
}

pub fn set_corner_crease_gate(on: bool) {
    ffi::set_corner_crease_gate(on);
}

pub fn set_corner_exact_patch(mode: i32) {
    ffi::set_corner_exact_patch(mode);
}

pub fn set_corner_trim(on: bool) {
    ffi::set_corner_trim(on);
}

pub fn set_shell_star_pole_limit(limit: i32) {
    ffi::set_shell_star_pole_limit(limit);
}

pub fn set_shell_fault(fault: i32) {
    ffi::set_shell_fault(fault);
}

pub fn last_shell_star_poles() -> i32 {
    ffi::last_shell_star_poles()
}

pub fn adaptive_rule(shape: &Shape) -> bool {
    ffi::adaptive_rule(crate::inner(shape).expect("a shape"))
}

pub fn spline_bounds(kind: i32) -> Vec<f64> {
    ffi::spline_bounds_probe(kind)
}
