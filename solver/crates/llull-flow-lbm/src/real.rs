//! Floating-point type of the CPU twin: f64 for the recorded / reference path (the validation cases reach second order at 64
//! cells only in f64: the forcing increments of a fine Poiseuille channel fall below the f32 resolution of the populations), f32
//! to mirror the WGSL kernels bit for bit in arithmetic (VC-CFD-26).

use std::fmt::Debug;
use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

/// f32 or f64.
pub trait Real:
    Copy
    + Send
    + Sync
    + Debug
    + PartialEq
    + PartialOrd
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
    + AddAssign
    + SubAssign
    + 'static
{
    const ZERO: Self;
    /// Name of the precision in provenance.
    const NAME: &'static str;
    fn of(value: f64) -> Self;
    fn to_f64(self) -> f64;
    fn to_f32(self) -> f32;
    fn sqrt(self) -> Self;
    fn is_finite(self) -> bool;
}

impl Real for f64 {
    const ZERO: f64 = 0.0;
    const NAME: &'static str = "f64";
    fn of(value: f64) -> f64 {
        value
    }
    fn to_f64(self) -> f64 {
        self
    }
    fn to_f32(self) -> f32 {
        self as f32
    }
    fn sqrt(self) -> f64 {
        f64::sqrt(self)
    }
    fn is_finite(self) -> bool {
        f64::is_finite(self)
    }
}

impl Real for f32 {
    const ZERO: f32 = 0.0;
    const NAME: &'static str = "f32";
    fn of(value: f64) -> f32 {
        value as f32
    }
    fn to_f64(self) -> f64 {
        f64::from(self)
    }
    fn to_f32(self) -> f32 {
        self
    }
    fn sqrt(self) -> f32 {
        f32::sqrt(self)
    }
    fn is_finite(self) -> bool {
        f32::is_finite(self)
    }
}
