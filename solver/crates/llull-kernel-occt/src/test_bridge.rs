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
    }
}

pub fn refined_mass(shape: &Shape) -> bool {
    ffi::refined_mass_flag(crate::inner(shape).expect("a shape"))
}

pub fn adaptive_rule(shape: &Shape) -> bool {
    ffi::adaptive_rule(crate::inner(shape).expect("a shape"))
}
