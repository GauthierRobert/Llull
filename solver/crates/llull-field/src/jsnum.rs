//! ECMAScript number semantics the TypeScript engine relies on: `Math.min` / `Math.max` propagate NaN and order the zeros.

#[inline]
pub fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

#[inline]
pub fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

pub fn jmin4(values: [f64; 4]) -> f64 {
    values.into_iter().fold(f64::INFINITY, jmin)
}

pub fn jmax4(values: [f64; 4]) -> f64 {
    values.into_iter().fold(f64::NEG_INFINITY, jmax)
}

#[inline]
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    llull_jsmath::hypot(&[a, b, c])
}

#[inline]
pub fn hypot2(a: f64, b: f64) -> f64 {
    llull_jsmath::hypot(&[a, b])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_and_max_follow_ecmascript() {
        assert!(jmin(f64::NAN, 1.0).is_nan() && jmax(1.0, f64::NAN).is_nan());
        assert!(jmin(0.0, -0.0).is_sign_negative() && jmax(-0.0, 0.0).is_sign_positive());
        assert_eq!(jmin4([3.0, 1.0, 2.0, 5.0]), 1.0);
        assert_eq!(jmax4([3.0, 1.0, 2.0, 5.0]), 5.0);
        assert_eq!(hypot3(2.0, 3.0, 6.0), 7.0);
        assert_eq!(hypot2(3.0, 4.0), 5.0);
    }
}
