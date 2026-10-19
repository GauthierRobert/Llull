//! Floating-point type of the multigrid V-cycle: f64 like the PCG around it, or f32 (half the memory traffic and twice the
//! SIMD lanes; the V-cycle is only a preconditioner, so the PCG still reaches its f64 residual tolerance).

use rayon::prelude::*;
use std::fmt::Debug;
use std::ops::{Add, AddAssign, Div, Mul, Sub, SubAssign};

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
    + AddAssign
    + SubAssign
    + 'static
{
    const ZERO: Self;
    /// `value` rounded to this type.
    fn of(value: f64) -> Self;
    /// This value as f64 (exact).
    fn get(self) -> f64;
}

impl Real for f64 {
    const ZERO: f64 = 0.0;
    fn of(value: f64) -> f64 {
        value
    }
    fn get(self) -> f64 {
        self
    }
}

impl Real for f32 {
    const ZERO: f32 = 0.0;
    fn of(value: f64) -> f32 {
        value as f32
    }
    fn get(self) -> f64 {
        f64::from(self)
    }
}

/// `a · b` accumulated in f64 in the fixed order of `llull_gpu::reduce` (chunks summed left to right, then the partials):
/// the same bits for any thread count.
pub fn dot<T: Real>(a: &[T], b: &[T]) -> f64 {
    let chunk = llull_gpu::reduce::CHUNK;
    let partials: Vec<f64> = a
        .par_chunks(chunk)
        .zip(b.par_chunks(chunk))
        .map(|(x, y)| x.iter().zip(y).fold(0.0, |acc, (p, q)| acc + p.get() * q.get()))
        .collect();
    partials.iter().fold(0.0, |acc, v| acc + v)
}
