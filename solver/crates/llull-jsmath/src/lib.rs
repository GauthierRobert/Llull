//! Bit-exact twins of the V8 `Math` functions used by the TypeScript references that native jobs must reproduce (RS1 §2 rule 4).
//!
//! The platform `f64::powf` / `log10` (glibc) differ from V8 in the last bit for several percent of the inputs, so a native port of a
//! TypeScript formula would not be bit-identical. `pow`, `exp`, `log`, `log10` and `atan` transliterate V8's `src/base/ieee754.cc` (fdlibm 5.3);
//! `hypot` is V8's Kahan-compensated `Math.hypot`; `cbrt` is V8's `ieee754::cbrt` (FreeBSD s_cbrt.c); `round` is ECMAScript `Math.round`.
//!
//! fdlibm notice (kept as its licence requires): Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//! Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved.

#[inline]
fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}

#[inline]
fn low(x: f64) -> u32 {
    x.to_bits() as u32
}

#[inline]
fn with_high(x: f64, hi: i32) -> f64 {
    f64::from_bits((x.to_bits() & 0x0000_0000_FFFF_FFFF) | (u64::from(hi as u32) << 32))
}

#[inline]
fn with_low(x: f64, lo: u32) -> f64 {
    f64::from_bits((x.to_bits() & 0xFFFF_FFFF_0000_0000) | u64::from(lo))
}

/// `x * 2^n` (musl `scalbn`), used by `pow` for subnormal results only.
fn scalbn(mut x: f64, mut n: i32) -> f64 {
    let p1023 = f64::from_bits(0x7fe0_0000_0000_0000);
    let pm1022 = f64::from_bits(0x0010_0000_0000_0000);
    let p53 = f64::from_bits(0x4340_0000_0000_0000);
    if n > 1023 {
        x *= p1023;
        n -= 1023;
        if n > 1023 {
            x *= p1023;
            n -= 1023;
            n = n.min(1023);
        }
    } else if n < -1022 {
        x *= pm1022 * p53;
        n += 1022 - 53;
        if n < -1022 {
            x *= pm1022 * p53;
            n += 1022 - 53;
            n = n.max(-1022);
        }
    }
    x * f64::from_bits(((0x3ff + n) as u64) << 52)
}

/// ECMAScript `Math.round`: the nearest integer, ties toward +Infinity.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// V8 `Math.cbrt` (`base::ieee754::cbrt`, FreeBSD s_cbrt.c: polynomial to 23 bits, rounded away from zero, one Newton step to 53 bits).
pub fn cbrt(x: f64) -> f64 {
    const B1: u32 = 715_094_163;
    const B2: u32 = 696_219_795;
    const P0: f64 = 1.875_951_824_271_77;
    const P1: f64 = -1.884_979_795_433_771_7;
    const P2: f64 = 1.621_429_720_105_354_5;
    const P3: f64 = -0.758_397_934_778_766;
    const P4: f64 = 0.145_996_192_886_612_45;
    let mut hx = high(x) as u32;
    let lo = low(x);
    let sign = hx & 0x8000_0000;
    hx ^= sign;
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    let mut t: f64;
    if hx < 0x0010_0000 {
        if (hx | lo) == 0 {
            return x;
        }
        t = f64::from_bits(u64::from(0x4350_0000u32) << 32);
        t *= x;
        let hi_t = (t.to_bits() >> 32) as u32;
        let guess = sign | ((hi_t & 0x7fff_ffff) / 3 + B2);
        t = f64::from_bits(u64::from(guess) << 32);
    } else {
        let guess = sign | (hx / 3 + B1);
        t = f64::from_bits(u64::from(guess) << 32);
    }
    let mut r = (t * t) * (t / x);
    t *= (P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4);
    t = f64::from_bits((t.to_bits().wrapping_add(0x8000_0000)) & 0xffff_ffff_c000_0000);
    let s = t * t;
    r = x / s;
    let w = t + t;
    r = (r - t) / (w + r);
    t + t * r
}

/// V8 `Math.hypot`: scaled by the largest magnitude, Kahan-compensated sum of squares.
pub fn hypot(values: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for value in values {
        let magnitude = value.abs();
        if magnitude == f64::INFINITY {
            return f64::INFINITY;
        }
        if magnitude.is_nan() {
            nan = true;
        } else if magnitude > max {
            max = magnitude;
        }
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for value in values {
        let n = value.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// V8 `Math.exp` (fdlibm `__ieee754_exp`, V8 `base::ieee754::exp`).
#[allow(clippy::excessive_precision)]
pub fn exp(mut x: f64) -> f64 {
    const HALF: [f64; 2] = [0.5, -0.5];
    const HUGE: f64 = 1.0e+300;
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2_HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2_LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INV_LN2: f64 = std::f64::consts::LOG2_E; // fdlibm invln2 = 1.44269504088896338700e+00, the same double
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const TWO_M1000: f64 = 9.33263618503218878990e-302;
    const TWO_1023: f64 = 8.988465674311579539e307;

    let mut hx = high(x) as u32;
    let xsb = (hx >> 31) as usize;
    hx &= 0x7fff_ffff;

    if hx >= 0x4086_2E42 {
        if hx >= 0x7ff0_0000 {
            if ((hx & 0x000f_ffff) | low(x)) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return f64::INFINITY;
        }
        if x < U_THRESHOLD {
            return 0.0;
        }
    }

    let mut hi = 0.0;
    let mut lo = 0.0;
    let k: i32 = if hx > 0x3fd6_2e42 {
        let k = if hx < 0x3FF0_A2B2 {
            // V8 special-cases exp(1) to return E (the reduction below gets its last bit wrong).
            if x == 1.0 {
                return std::f64::consts::E;
            }
            hi = x - LN2_HI[xsb];
            lo = LN2_LO[xsb];
            1 - (xsb as i32) - (xsb as i32)
        } else {
            let k = (INV_LN2 * x + HALF[xsb]) as i32;
            let t = f64::from(k);
            hi = x - t * LN2_HI[0];
            lo = t * LN2_LO[0];
            k
        };
        x = hi - lo;
        k
    } else if hx < 0x3e30_0000 {
        if HUGE + x > 1.0 {
            return 1.0 + x;
        }
        0
    } else {
        0
    };

    let t = x * x;
    let twopk = if k >= -1021 { with_high(0.0, 0x3ff0_0000 + (k << 20)) } else { with_high(0.0, 0x3ff0_0000 + ((k + 1000) << 20)) };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO_1023;
        }
        return y * twopk;
    }
    y * twopk * TWO_M1000
}

/// V8 `Math.log` (fdlibm `__ieee754_log`).
#[allow(clippy::excessive_precision)]
pub fn log(mut x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const TWO54: f64 = 1.80143985094819840000e+16;
    const LG1: f64 = 6.666666666666735130e-01;
    const LG2: f64 = 3.999999999940941908e-01;
    const LG3: f64 = 2.857142874366239149e-01;
    const LG4: f64 = 2.222219843214978396e-01;
    const LG5: f64 = 1.818357216161805012e-01;
    const LG6: f64 = 1.531383769920937332e-01;
    const LG7: f64 = 1.479819860511658591e-01;
    let mut hx = high(x);
    let lx = low(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7FFF_FFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7FF0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000F_FFFF;
    let i = (hx + 0x95F64) & 0x10_0000;
    x = with_high(x, hx | (i ^ 0x3FF0_0000));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000F_FFFF & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let mut i = hx - 0x6147A;
    let w = z * z;
    let j = 0x6B851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/// V8 `Math.log10` (fdlibm `__ieee754_log10` over `log`).
#[allow(clippy::excessive_precision, clippy::approx_constant)]
pub fn log10(mut x: f64) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16;
    const IVLN10: f64 = 4.34294481903251816668e-01;
    const LOG10_2HI: f64 = 3.01029995663611771306e-01;
    const LOG10_2LO: f64 = 3.69423907715893078616e-13;
    let mut hx = high(x);
    let mut lx = low(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if ((hx & 0x7FFF_FFFF) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
        lx = low(x);
    }
    if hx >= 0x7FF0_0000 {
        return x + x;
    }
    if hx == 0x3FF0_0000 && lx == 0 {
        return 0.0;
    }
    k += (hx >> 20) - 1023;
    let i = ((k as u32 & 0x8000_0000) >> 31) as i32;
    hx = (hx & 0x000F_FFFF) | ((0x3FF - i) << 20);
    let y = f64::from(k + i);
    x = with_low(with_high(x, hx), lx);
    let z = y * LOG10_2LO + IVLN10 * log(x);
    z + y * LOG10_2HI
}

/// V8 `Math.pow` / `**` (fdlibm `__ieee754_pow` as in V8's `ieee754::pow`).
#[allow(clippy::excessive_precision, clippy::approx_constant, clippy::eq_op, clippy::many_single_char_names, clippy::too_many_lines)]
pub fn pow(x: f64, y: f64) -> f64 {
    const BP: [f64; 2] = [1.0, 1.5];
    const DP_H: [f64; 2] = [0.0, 5.84962487220764160156e-01];
    const DP_L: [f64; 2] = [0.0, 1.35003920212974897128e-08];
    const TWO53: f64 = 9007199254740992.0;
    const HUGE: f64 = 1.0e300;
    const TINY: f64 = 1.0e-300;
    const L1: f64 = 5.99999999999994648725e-01;
    const L2: f64 = 4.28571428578550184252e-01;
    const L3: f64 = 3.33333329818377432918e-01;
    const L4: f64 = 2.72728123808534006489e-01;
    const L5: f64 = 2.30660745775561754067e-01;
    const L6: f64 = 2.06975017800338417784e-01;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const LG2: f64 = 6.93147180559945286227e-01;
    const LG2_H: f64 = 6.93147182464599609375e-01;
    const LG2_L: f64 = -1.90465429995776804525e-09;
    const OVT: f64 = 8.0085662595372944372e-0017;
    const CP: f64 = 9.61796693925975554329e-01;
    const CP_H: f64 = 9.61796700954437255859e-01;
    const CP_L: f64 = -7.02846165095275826516e-09;
    const IVLN2: f64 = 1.44269504088896338700e+00;
    const IVLN2_H: f64 = 1.44269502162933349609e+00;
    const IVLN2_L: f64 = 1.92596299112661746887e-08;

    let hx = high(x);
    let lx = low(x);
    let hy = high(y);
    let ly = low(y);
    let mut ix = hx & 0x7fff_ffff;
    let iy = hy & 0x7fff_ffff;

    if (iy as u32 | ly) == 0 {
        return 1.0;
    }
    if ix > 0x7ff0_0000 || (ix == 0x7ff0_0000 && lx != 0) || iy > 0x7ff0_0000 || (iy == 0x7ff0_0000 && ly != 0) {
        return x + y;
    }

    let mut yisint = 0;
    if hx < 0 {
        if iy >= 0x4340_0000 {
            yisint = 2;
        } else if iy >= 0x3ff0_0000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = ly >> (52 - k);
                if (j << (52 - k)) == ly {
                    yisint = 2 - (j & 1) as i32;
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    if ly == 0 {
        if iy == 0x7ff0_0000 {
            if ((ix - 0x3ff0_0000) as u32 | lx) == 0 {
                return y - y;
            } else if ix >= 0x3ff0_0000 {
                return if hy >= 0 { y } else { 0.0 };
            }
            return if hy < 0 { -y } else { 0.0 };
        }
        if iy == 0x3ff0_0000 {
            return if hy < 0 { 1.0 / x } else { x };
        }
        if hy == 0x4000_0000 {
            return x * x;
        }
        if hy == 0x3fe0_0000 && hx >= 0 {
            return x.sqrt();
        }
    }

    let mut ax = x.abs();
    if lx == 0 && (ix == 0x7ff0_0000 || ix == 0 || ix == 0x3ff0_0000) {
        let mut z = ax;
        if hy < 0 {
            z = 1.0 / z;
        }
        if hx < 0 {
            if ((ix - 0x3ff0_0000) | yisint) == 0 {
                z = f64::NAN;
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    let mut n: i32 = (hx >> 31) + 1;
    if (n | yisint) == 0 {
        return f64::NAN;
    }
    let mut s = 1.0;
    if (n | (yisint - 1)) == 0 {
        s = -1.0;
    }

    let (t1, t2);
    if iy > 0x41e0_0000 {
        if iy > 0x43f0_0000 {
            if ix <= 0x3fef_ffff {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3ff0_0000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        if ix < 0x3fef_ffff {
            return if hy < 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        if ix > 0x3ff0_0000 {
            return if hy > 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        let t = ax - 1.0;
        let w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        let u = IVLN2_H * t;
        let v = t * IVLN2_L - w * IVLN2;
        let mut t1v = u + v;
        t1v = with_low(t1v, 0);
        t1 = t1v;
        t2 = v - (t1v - u);
    } else {
        n = 0;
        if ix < 0x0010_0000 {
            ax *= TWO53;
            n -= 53;
            ix = high(ax);
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000f_ffff;
        ix = j | 0x3ff0_0000;
        let k: usize;
        if j <= 0x3988E {
            k = 0;
        } else if j < 0xBB67A {
            k = 1;
        } else {
            k = 0;
            n += 1;
            ix -= 0x0010_0000;
        }
        ax = with_high(ax, ix);

        let u = ax - BP[k];
        let v = 1.0 / (ax + BP[k]);
        let ss = u * v;
        let s_h = with_low(ss, 0);
        let t_h = with_high(0.0, ((ix >> 1) | 0x2000_0000) + 0x0008_0000 + ((k as i32) << 18));
        let t_l = ax - (t_h - BP[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        let mut s2 = ss * ss;
        let mut r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        let t_h = with_low(3.0 + s2 + r, 0);
        let t_l = r - ((t_h - 3.0) - s2);
        let u = s_h * t_h;
        let v = s_l * t_h + t_l * ss;
        let p_h = with_low(u + v, 0);
        let p_l = v - (p_h - u);
        let z_h = CP_H * p_h;
        let z_l = CP_L * p_h + p_l * CP + DP_L[k];
        let t = f64::from(n);
        let t1v = with_low(((z_h + z_l) + DP_H[k]) + t, 0);
        t1 = t1v;
        t2 = z_l - (((t1v - t) - DP_H[k]) - z_h);
    }

    let y1 = with_low(y, 0);
    let p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let mut z = p_l + p_h;
    let j = high(z);
    let i = low(z) as i32;
    if j >= 0x4090_0000 {
        if ((j - 0x4090_0000) | i) != 0 || p_l + OVT > z - p_h {
            return s * HUGE * HUGE;
        }
    } else if (j & 0x7fff_ffff) >= 0x4090_cc00 && ((j.wrapping_sub(0xc090_cc00_u32 as i32)) | i != 0 || p_l <= z - p_h) {
        return s * TINY * TINY;
    }

    let i = j & 0x7fff_ffff;
    let mut k = (i >> 20) - 0x3ff;
    n = 0;
    if i > 0x3fe0_0000 {
        n = j + (0x0010_0000 >> (k + 1));
        k = ((n & 0x7fff_ffff) >> 20) - 0x3ff;
        let t = with_high(0.0, n & !(0x000f_ffff >> k));
        n = ((n & 0x000f_ffff) | 0x0010_0000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = with_low(p_l + p_h, 0);
    let u = t * LG2_H;
    let v = (p_l - (t - p_h)) * LG2 + t * LG2_L;
    z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    let r = (z * t1) / ((t1 - 2.0) - (w + z * w));
    z = 1.0 - (r - z);
    let j = high(z).wrapping_add(((n as u32) << 20) as i32);
    if (j >> 20) <= 0 {
        z = scalbn(z, n);
    } else {
        z = with_high(z, high(z).wrapping_add(((n as u32) << 20) as i32));
    }
    s * z
}

/// V8 `Math.atan` (fdlibm `atan`, s_atan.c; V8 `ieee754::atan`).
#[allow(clippy::many_single_char_names)]
pub fn atan(x: f64) -> f64 {
    const ATAN_HI: [u64; 4] = [0x3FDD_AC67_0561_BB4F, 0x3FE9_21FB_5444_2D18, 0x3FEF_730B_D281_F69B, 0x3FF9_21FB_5444_2D18];
    const ATAN_LO: [u64; 4] = [0x3C7A_2B7F_222F_65E2, 0x3C81_A626_3314_5C07, 0x3C70_0788_7AF0_CBBD, 0x3C91_A626_3314_5C07];
    const AT: [u64; 11] = [
        0x3FD5_5555_5555_550D,
        0xBFC9_9999_9998_EBC4,
        0x3FC2_4924_9200_83FF,
        0xBFBC_71C6_FE23_1671,
        0x3FB7_45CD_C54C_206E,
        0xBFB3_B0F2_AF74_9A6D,
        0x3FB1_0D66_A0D0_3D51,
        0xBFAD_DE2D_52DE_FD9A,
        0x3FA9_7B4B_2476_0DEB,
        0xBFA2_B444_2C6A_6C2F,
        0x3F90_AD3A_E322_DA11,
    ];
    let hi = |i: usize| f64::from_bits(ATAN_HI[i]);
    let lo = |i: usize| f64::from_bits(ATAN_LO[i]);
    let at = |i: usize| f64::from_bits(AT[i]);
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    let mut x = x;
    let id: i32;
    if ix >= 0x4410_0000 {
        if ix > 0x7ff0_0000 || (ix == 0x7ff0_0000 && low(x) != 0) {
            return x + x;
        }
        return if hx > 0 { hi(3) + lo(3) } else { -hi(3) - lo(3) };
    }
    if ix < 0x3fdc_0000 {
        if ix < 0x3e40_0000 {
            return x;
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3ff3_0000 {
            if ix < 0x3fe6_0000 {
                id = 0;
                x = (2.0 * x - 1.0) / (2.0 + x);
            } else {
                id = 1;
                x = (x - 1.0) / (x + 1.0);
            }
        } else if ix < 0x4003_8000 {
            id = 2;
            x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (at(0) + w * (at(2) + w * (at(4) + w * (at(6) + w * (at(8) + w * at(10))))));
    let s2 = w * (at(1) + w * (at(3) + w * (at(5) + w * (at(7) + w * at(9)))));
    if id < 0 {
        return x - x * (s1 + s2);
    }
    let k = id as usize;
    let z = hi(k) - ((x * (s1 + s2) - lo(k)) - x);
    if hx < 0 {
        -z
    } else {
        z
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cbrt_matches_v8_bit_for_bit() {
        // Reference: node 24 Math.cbrt, bit patterns.
        let cases: [(f64, u64); 18] = [
            (5e-1, 0x3fe965fea53d6e3d),
            (1.5e+0, 0x3ff250bfe1b082f5),
            (2e+0, 0x3ff428a2f98d728b),
            (3e+0, 0x3ff7137449123ef6),
            (7.1e+0, 0x3ffec08049237535),
            (1e+1, 0x40013c484138704f),
            (2.7e+1, 0x4008000000000000),
            (1e-3, 0x3fb999999999999a),
            (1.23456789e+5, 0x4048e58dab7da808),
            (1e-300, 0x2b2bff2ee48e0530),
            (9.99999e+5, 0x4058ffff7430980c),
            (9.999999e-1, 0x3fefffffee1ab38f),
            (1.0000001e+0, 0x3ff0000008f2a62f),
            (9.965293069957826e-1, 0x3feff682ff59be5d),
            (8.058317981148171e-1, 0x3fedc736a1335b42),
            (3.333333333333333e-1, 0x3fe63003fbb4c375),
            (6.666666666666666e-1, 0x3febf45f04cef0b8),
            (4.9406564584e-314, 0x2a40d4de8fb11dad),
        ];
        for (x, bits) in cases {
            assert_eq!(cbrt(x).to_bits(), bits, "cbrt({x:e})");
            assert_eq!(cbrt(-x).to_bits(), bits | (1 << 63), "cbrt(-{x:e})");
        }
        assert_eq!(cbrt(0.0), 0.0);
        assert!(cbrt(f64::NAN).is_nan());
        assert_eq!(cbrt(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn known_values() {
        assert_eq!(pow(2.0, 10.0), 1024.0);
        assert_eq!(pow(9.0, 0.5), 3.0);
        assert_eq!(pow(-8.0, 3.0), -512.0);
        assert!(pow(-8.0, 0.5).is_nan());
        assert_eq!(pow(0.0, -1.0), f64::INFINITY);
        assert_eq!(pow(10.0, 400.0), f64::INFINITY);
        assert_eq!(pow(10.0, -400.0), 0.0);
        assert!(pow(10.0, -310.0) > 0.0);
        assert_eq!(log10(1000.0), 3.0);
        assert_eq!(log10(1.0), 0.0);
        assert_eq!(log10(0.0), f64::NEG_INFINITY);
        assert!(log10(-1.0).is_nan());
        assert!(log10(5e-324) < -323.0);
        assert_eq!(log(1.0), 0.0);
        assert!(log(5e-324) < -744.0);
        assert_eq!(hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(hypot(&[0.0, 0.0]), 0.0);
        assert_eq!(hypot(&[f64::NAN, f64::INFINITY]), f64::INFINITY);
        assert!(hypot(&[f64::NAN, 1.0]).is_nan());
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert!(round(f64::NAN).is_nan());
    }
}
