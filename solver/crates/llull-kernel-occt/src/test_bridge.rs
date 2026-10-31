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

pub fn adaptive_rule(shape: &Shape) -> bool {
    ffi::adaptive_rule(crate::inner(shape).expect("a shape"))
}
