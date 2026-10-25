//! V8 `Math.sin`, `Math.cos` and `Math.atan2` (fdlibm 5.3 `s_sin.c`, `s_cos.c`, `k_sin.c`, `k_cos.c`, `e_rem_pio2.c`, `e_atan2.c`; V8
//! `ieee754::sin` / `cos` / `atan2`), bit for bit for every finite argument below 2^19 pi / 2 (about 8.2e5); beyond that the platform function
//! answers and `take_platform_fallback` reports it (the reduction by the 2/pi table is not ported, so the result is not claimed to match V8).
//!
//! fdlibm notice (kept as its licence requires): Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//! Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved.

use crate::atan;
use std::sync::atomic::{AtomicBool, Ordering};

static PLATFORM_FALLBACK: AtomicBool = AtomicBool::new(false);

/// Whether `sin` or `cos` answered a finite argument beyond the ported reduction (|x| >= 2^19 pi / 2) with the platform function since the last call, and
/// resets the flag. Such an answer is not guaranteed to match V8 bit for bit, so a caller that promises V8 parity must refuse its result.
pub fn take_platform_fallback() -> bool {
    PLATFORM_FALLBACK.swap(false, Ordering::Relaxed)
}

const S1: f64 = f64::from_bits(0xbfc5_5555_5555_5549); // -0.16666666666666632
const S2: f64 = f64::from_bits(0x3f81_1111_1110_f8a6); // 0.00833333333332249
const S3: f64 = f64::from_bits(0xbf2a_01a0_19c1_61d5); // -0.0001984126982985795
const S4: f64 = f64::from_bits(0x3ec7_1de3_57b1_fe7d); // 0.0000027557313707070068
const S5: f64 = f64::from_bits(0xbe5a_e5e6_8a2b_9ceb); // -2.5050760253406863e-8
const S6: f64 = f64::from_bits(0x3de5_d93a_5acf_d57c); // 1.58969099521155e-10
const C1: f64 = f64::from_bits(0x3fa5_5555_5555_554c); // 0.0416666666666666
const C2: f64 = f64::from_bits(0xbf56_c16c_16c1_5177); // -0.001388888888887411
const C3: f64 = f64::from_bits(0x3efa_01a0_19cb_1590); // 0.00002480158728947673
const C4: f64 = f64::from_bits(0xbe92_7e4f_809c_52ad); // -2.7557314351390663e-7
const C5: f64 = f64::from_bits(0x3e21_ee9e_bdb4_b1c4); // 2.087572321298175e-9
const C6: f64 = f64::from_bits(0xbda8_fae9_be88_38d4); // -1.1359647557788195e-11
const INVPIO2: f64 = f64::from_bits(0x3fe4_5f30_6dc9_c883); // 0.6366197723675814
const PIO2_1: f64 = f64::from_bits(0x3ff9_21fb_5440_0000); // 1.5707963267341256
const PIO2_1T: f64 = f64::from_bits(0x3dd0_b461_1a62_6331); // 6.077100506506192e-11
const PIO2_2: f64 = f64::from_bits(0x3dd0_b461_1a60_0000); // 6.077100506303966e-11
const PIO2_2T: f64 = f64::from_bits(0x3ba3_198a_2e03_7073); // 2.0222662487959506e-21
const PIO2_3: f64 = f64::from_bits(0x3ba3_198a_2e00_0000); // 2.0222662487111665e-21
const PIO2_3T: f64 = f64::from_bits(0x397b_839a_2520_49c1); // 8.4784276603689e-32

#[inline]
fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

#[inline]
fn with_high(x: f64, hi: i32) -> f64 {
    f64::from_bits((x.to_bits() & 0x0000_0000_FFFF_FFFF) | (u64::from(hi as u32) << 32))
}

fn kernel_sin(x: f64, y: f64, tail: bool) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && (x as i32) == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if tail {
        x - ((z * (0.5 * y - v * r) - y) - v * S1)
    } else {
        x + v * (S1 + z * r)
    }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 && (x as i32) == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3FD3_3333 {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe9_0000 { 0.28125 } else { with_high(0.0, ix - 0x0020_0000) };
    let hz = 0.5 * z - qx;
    let a = 1.0 - qx;
    a - (hz - (z * r - x * y))
}

/// `(n, y0, y1)` with `x = n pi/2 + y0 + y1` for 0 < |x| <= 2^19 pi / 2 (fdlibm `__ieee754_rem_pio2`, medium path; the quick cancellation
/// test on the `npio2_hw` table is skipped: the refinement it guards then runs only when the cancellation is real).
fn rem_pio2(x: f64) -> (i32, f64, f64) {
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return (0, x, 0.0);
    }
    if ix < 0x4002_d97c {
        if hx > 0 {
            let mut z = x - PIO2_1;
            let (y0, y1);
            if ix != 0x3ff9_21fb {
                y0 = z - PIO2_1T;
                y1 = (z - y0) - PIO2_1T;
            } else {
                z -= PIO2_2;
                y0 = z - PIO2_2T;
                y1 = (z - y0) - PIO2_2T;
            }
            return (1, y0, y1);
        }
        let mut z = x + PIO2_1;
        let (y0, y1);
        if ix != 0x3ff9_21fb {
            y0 = z + PIO2_1T;
            y1 = (z - y0) + PIO2_1T;
        } else {
            z += PIO2_2;
            y0 = z + PIO2_2T;
            y1 = (z - y0) + PIO2_2T;
        }
        return (-1, y0, y1);
    }
    let t = x.abs();
    let n = (t * INVPIO2 + 0.5) as i32;
    let fn_ = f64::from(n);
    let mut r = t - fn_ * PIO2_1;
    let mut w = fn_ * PIO2_1T;
    let j = ix >> 20;
    let mut y0 = r - w;
    let mut i = j - ((high(y0) >> 20) & 0x7ff);
    if i > 16 {
        let t = r;
        w = fn_ * PIO2_2;
        r = t - w;
        w = fn_ * PIO2_2T - ((t - r) - w);
        y0 = r - w;
        i = j - ((high(y0) >> 20) & 0x7ff);
        if i > 49 {
            let t = r;
            w = fn_ * PIO2_3;
            r = t - w;
            w = fn_ * PIO2_3T - ((t - r) - w);
            y0 = r - w;
        }
    }
    let y1 = (r - y0) - w;
    if hx < 0 {
        (-n, -y0, -y1)
    } else {
        (n, y0, y1)
    }
}

const REDUCTION_LIMIT: i32 = 0x4139_21fb;

/// V8 `Math.sin`.
pub fn sin(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff0_0000 {
        return f64::NAN;
    }
    if ix > REDUCTION_LIMIT {
        PLATFORM_FALLBACK.store(true, Ordering::Relaxed);
        return x.sin();
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

/// V8 `Math.cos`.
pub fn cos(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff0_0000 {
        return f64::NAN;
    }
    if ix > REDUCTION_LIMIT {
        PLATFORM_FALLBACK.store(true, Ordering::Relaxed);
        return x.cos();
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_cos(y0, y1),
        1 => -kernel_sin(y0, y1, true),
        2 => -kernel_cos(y0, y1),
        _ => kernel_sin(y0, y1, true),
    }
}

/// V8 `Math.atan2(y, x)`.
pub fn atan2(y: f64, x: f64) -> f64 {
    const TINY: f64 = f64::from_bits(0x01a5_6e1f_c2f8_f359); // 1e-300
    const PI_O_4: f64 = f64::from_bits(0x3fe9_21fb_5444_2d18); // 0.7853981633974483
    const PI_O_2: f64 = f64::from_bits(0x3ff9_21fb_5444_2d18); // 1.5707963267948966
    const PI: f64 = f64::from_bits(0x4009_21fb_5444_2d18); // 3.141592653589793
    const PI_LO: f64 = f64::from_bits(0x3ca1_a626_3314_5c07); // 1.2246467991473532e-16
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    let (hx, hy) = (high(x), high(y));
    let (lx, ly) = (x.to_bits() as u32, y.to_bits() as u32);
    let (ix, iy) = (hx & 0x7fff_ffff, hy & 0x7fff_ffff);
    if (hx.wrapping_sub(0x3ff0_0000) as u32 | lx) == 0 {
        return atan(y);
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if (iy as u32 | ly) == 0 {
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if (ix as u32 | lx) == 0 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    if ix == 0x7ff0_0000 {
        if iy == 0x7ff0_0000 {
            return match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            };
        }
        return match m {
            0 => 0.0,
            1 => -0.0,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if iy == 0x7ff0_0000 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        m &= 1;
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agrees_with_the_platform_functions_to_rounding() {
        let mut worst = 0.0_f64;
        for k in -4000..4000 {
            let x = f64::from(k) * 0.37 + 0.001;
            worst = worst.max((sin(x) - x.sin()).abs()).max((cos(x) - x.cos()).abs());
        }
        for k in -300..300 {
            for l in -300..300 {
                let (y, x) = (f64::from(k) * 0.31 + 0.01, f64::from(l) * 0.29 - 0.02);
                worst = worst.max((atan2(y, x) - y.atan2(x)).abs());
            }
        }
        assert!(worst < 2e-15, "worst deviation {worst:e}");
    }

    #[test]
    fn special_values_follow_ecmascript() {
        assert!(sin(f64::INFINITY).is_nan() && cos(f64::NAN).is_nan());
        assert_eq!(sin(0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(sin(-0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(cos(0.0), 1.0);
        assert_eq!(atan2(0.0, -1.0), std::f64::consts::PI);
        assert_eq!(atan2(-0.0, -1.0), -std::f64::consts::PI);
        assert_eq!(atan2(1.0, 0.0), std::f64::consts::FRAC_PI_2);
        assert_eq!(atan2(-1.0, 0.0), -std::f64::consts::FRAC_PI_2);
        assert_eq!(atan2(f64::INFINITY, f64::INFINITY), std::f64::consts::FRAC_PI_4);
        assert_eq!(atan2(1.0, f64::INFINITY), 0.0);
        assert_eq!(atan2(1.0, f64::NEG_INFINITY), std::f64::consts::PI);
        assert_eq!(atan2(f64::INFINITY, 3.0), std::f64::consts::FRAC_PI_2);
        assert_eq!(atan2(3.0, 1.0), atan(3.0));
        assert_eq!(atan2(1e300, 1e-300), std::f64::consts::FRAC_PI_2);
        assert_eq!(atan2(1e-300, -1e300), std::f64::consts::PI);
        assert!(atan2(f64::NAN, 1.0).is_nan());
        assert_eq!(sin(1.0e7), 1.0e7_f64.sin());
        assert_eq!(cos(-1.0e7), (-1.0e7_f64).cos());
    }
}
