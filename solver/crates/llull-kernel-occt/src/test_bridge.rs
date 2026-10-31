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
        /// How many faces the mass rule by knot span cuts into pieces.
        fn span_cut_count(shape: &Shape) -> i32;
        /// The oriented angle across the tangent edges of a face, the face reversed in a rebuilt shell or not.
        fn oriented_angle_probe(shape: &Shape, face: i32, reverse: bool) -> f64;
        /// The boundary angle of a face against its neighbours (-1: not measured), with the first loop edge dropped from the boundary or not.
        fn boundary_angle_probe(shape: &Shape, face: i32, drop_one: bool) -> f64;
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

pub fn set_corner_exact_patch(mode: i32) {
    ffi::set_corner_exact_patch(mode);
}

pub fn adaptive_rule(shape: &Shape) -> bool {
    ffi::adaptive_rule(crate::inner(shape).expect("a shape"))
}
