//! The first three Gauss-Legendre panels of the outer contour integral ([0, 1], [0, 0.5], [0.5, 1]: the 24 integrand values every edge
//! pair needs before `adaptive` can decide), evaluated as one batch (PERF1 §5 row 4). Each lane runs the operations of the scalar
//! `log_integral` and of `llull_jsmath::{log, atan}` in the same order, so every value is bit-identical; what differs is the shape: no
//! call and no branch per value, which lets the CPU overlap the divisions, square roots and polynomials of neighbouring lanes and the
//! compiler vectorise them (AVX2 through `pulp` where the CPU has it; Rust never contracts `a * b + c`, so the bits do not depend on the
//! instruction set). A lane outside the common branch of `log` / `atan` / `log_integral` (collinear edges, a point on the other edge,
//! |x| < 2^-27 or >= 2^66 for atan, a subnormal, non-finite or within 2^-20 of a power-of-two-normalised 1 for log) makes the batch
//! answer None and the caller runs the scalar path.

use crate::triangle::{add, cross, dot, scale, sub, Vec3};

pub(crate) const NODES: [f64; 4] = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
pub(crate) const WEIGHTS: [f64; 4] = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

/// Integrand values of the three first panels.
const LANES: usize = 24;
/// Integrand values of one panel.
const PANEL: usize = 8;

/// Abscissas of the first `N / 8` of the three panels in the order `gauss_legendre` evaluates them (`mid - node`, `mid + node` per
/// node), from the same expressions (`half = 0.5 * (hi - lo)`, `mid = 0.5 * (hi + lo)`).
const fn abscissas<const N: usize>() -> [f64; N] {
    let bounds = [(0.0, 1.0), (0.0, 0.5), (0.5, 1.0)];
    let mut out = [0.0; N];
    let mut panel = 0;
    while panel < N / PANEL {
        let (lo, hi) = bounds[panel];
        let half = 0.5 * (hi - lo);
        let mid = 0.5 * (hi + lo);
        let mut k = 0;
        while k < 4 {
            let node = NODES[k] * half;
            out[panel * PANEL + 2 * k] = mid - node;
            out[panel * PANEL + 2 * k + 1] = mid + node;
            k += 1;
        }
        panel += 1;
    }
    out
}

const ABSCISSAS: [f64; LANES] = abscissas();
/// The panel [0, 1] alone: the first eight of `ABSCISSAS`.
const WHOLE: [f64; PANEL] = abscissas();

/// The common branch of `llull_jsmath::log` (fdlibm `__ieee754_log`); the flag is true when `x` takes another branch there (x not a
/// positive normal number, or `f` within 2^-20 of 0) and the value must not be used.
#[inline(always)]
#[allow(clippy::excessive_precision)]
fn log_lane(x: f64) -> (f64, bool) {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const LG1: f64 = 6.666666666666735130e-01;
    const LG2: f64 = 3.999999999940941908e-01;
    const LG3: f64 = 2.857142874366239149e-01;
    const LG4: f64 = 2.222219843214978396e-01;
    const LG5: f64 = 1.818357216161805012e-01;
    const LG6: f64 = 1.531383769920937332e-01;
    const LG7: f64 = 1.479819860511658591e-01;
    let bits = x.to_bits();
    let top = (bits >> 32) as u32 as i32;
    let hx = top & 0x000F_FFFF;
    let other_branch = !(0x0010_0000..0x7FF0_0000).contains(&top) | ((0x000F_FFFF & (2 + hx)) < 3);
    let i = (hx + 0x95F64) & 0x10_0000;
    let mantissa = f64::from_bits((bits & 0x0000_0000_FFFF_FFFF) | (u64::from((hx | (i ^ 0x3FF0_0000)) as u32) << 32));
    let k = (top >> 20) - 1023 + (i >> 20);
    let f = mantissa - 1.0;
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    let w = z * z;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    let r = t2 + t1;
    let hfsq = 0.5 * f * f;
    let upper = if k == 0 { f - (hfsq - s * (hfsq + r)) } else { dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f) };
    let lower = if k == 0 { f - s * (f - r) } else { dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f) };
    (if ((hx - 0x6147A) | (0x6B851 - hx)) > 0 { upper } else { lower }, other_branch)
}

/// The five argument ranges of `llull_jsmath::atan` (fdlibm `atan`) between 2^-27 and 2^66; the flag is true outside (and for NaN).
#[inline(always)]
fn atan_lane(x: f64) -> (f64, bool) {
    const HI: [f64; 4] = [
        f64::from_bits(0x3FDD_AC67_0561_BB4F),
        f64::from_bits(0x3FE9_21FB_5444_2D18),
        f64::from_bits(0x3FEF_730B_D281_F69B),
        f64::from_bits(0x3FF9_21FB_5444_2D18),
    ];
    const LO: [f64; 4] = [
        f64::from_bits(0x3C7A_2B7F_222F_65E2),
        f64::from_bits(0x3C81_A626_3314_5C07),
        f64::from_bits(0x3C70_0788_7AF0_CBBD),
        f64::from_bits(0x3C91_A626_3314_5C07),
    ];
    const AT: [f64; 11] = [
        f64::from_bits(0x3FD5_5555_5555_550D),
        f64::from_bits(0xBFC9_9999_9998_EBC4),
        f64::from_bits(0x3FC2_4924_9200_83FF),
        f64::from_bits(0xBFBC_71C6_FE23_1671),
        f64::from_bits(0x3FB7_45CD_C54C_206E),
        f64::from_bits(0xBFB3_B0F2_AF74_9A6D),
        f64::from_bits(0x3FB1_0D66_A0D0_3D51),
        f64::from_bits(0xBFAD_DE2D_52DE_FD9A),
        f64::from_bits(0x3FA9_7B4B_2476_0DEB),
        f64::from_bits(0xBFA2_B444_2C6A_6C2F),
        f64::from_bits(0x3F90_AD3A_E322_DA11),
    ];
    let bits = x.to_bits();
    let ix = ((bits >> 32) & 0x7FFF_FFFF) as u32 as i32;
    let other_branch = !(0x3E40_0000..0x4410_0000).contains(&ix);
    let magnitude = x.abs();
    let (small, r0, r1, r2) = (ix < 0x3FDC_0000, ix < 0x3FE6_0000, ix < 0x3FF3_0000, ix < 0x4003_8000);
    // fdlibm reduces by one quotient per range; below 0.4375 the argument is kept (x / 1 is exact)
    let numerator = if small {
        x
    } else if r0 {
        2.0 * magnitude - 1.0
    } else if r1 {
        magnitude - 1.0
    } else if r2 {
        magnitude - 1.5
    } else {
        -1.0
    };
    let denominator = if small {
        1.0
    } else if r0 {
        2.0 + magnitude
    } else if r1 {
        magnitude + 1.0
    } else if r2 {
        1.0 + 1.5 * magnitude
    } else {
        magnitude
    };
    let (hi, lo) = if r0 {
        (HI[0], LO[0])
    } else if r1 {
        (HI[1], LO[1])
    } else if r2 {
        (HI[2], LO[2])
    } else {
        (HI[3], LO[3])
    };
    let reduced = numerator / denominator;
    let z = reduced * reduced;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    let near = reduced - reduced * (s1 + s2);
    let far = hi - ((reduced * (s1 + s2) - lo) - reduced);
    (
        if small {
            near
        } else if x.is_sign_negative() {
            -far
        } else {
            far
        },
        other_branch,
    )
}

#[inline(always)]
fn panel(values: &[f64], half: f64) -> f64 {
    let mut sum = 0.0;
    for k in 0..NODES.len() {
        sum += WEIGHTS[k] * (values[2 * k] + values[2 * k + 1]);
    }
    sum * half
}

/// s -> `log_integral((a + s u) - c, v)` at every abscissa, bit-identical to the scalar path; None when a lane leaves the common
/// branches. `v` must not be the zero vector.
#[inline(always)]
fn integrand<const N: usize>(abscissas: &[f64; N], a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3) -> Option<[f64; N]> {
    let vv = dot(v, v);
    let (mut q1, mut q0, mut x1, mut x0) = ([0.0; N], [0.0; N], [0.0; N], [0.0; N]);
    let (mut lead, mut atan_scale) = ([0.0; N], [0.0; N]);
    let mut common = true;
    // `antiderivative(t)` of `log_integral` at t = 1 and t = 0, written with its own expressions (t kept as a literal)
    for i in 0..N {
        let w = sub(&add(a, &scale(u, abscissas[i])), c);
        let wv = dot(&w, v);
        let c = cross(&w, v);
        let delta = 4.0 * dot(&c, &c);
        let b = -2.0 * wv;
        let root = delta.sqrt();
        let d1 = sub(&w, &scale(v, 1.0));
        let d0 = sub(&w, &scale(v, 0.0));
        q1[i] = dot(&d1, &d1);
        q0[i] = dot(&d0, &d0);
        // delta == 0: the collinear closed form; q <= 0 (or NaN): no log term
        common &= (delta != 0.0) & (q1[i] > 0.0) & (q0[i] > 0.0);
        x1[i] = (2.0 * vv * 1.0 + b) / root;
        x0[i] = (2.0 * vv * 0.0 + b) / root;
        lead[i] = b / (2.0 * vv);
        atan_scale[i] = root / vv;
    }
    if !common {
        return None;
    }
    let (mut log1, mut log0, mut atan1, mut atan0) = ([0.0; N], [0.0; N], [0.0; N], [0.0; N]);
    let mut flags = [false; N];
    for i in 0..N {
        let (value, flag) = log_lane(q1[i]);
        log1[i] = value;
        flags[i] = flag;
    }
    for i in 0..N {
        let (value, flag) = log_lane(q0[i]);
        log0[i] = value;
        flags[i] |= flag;
    }
    for i in 0..N {
        let (value, flag) = atan_lane(x1[i]);
        atan1[i] = value;
        flags[i] |= flag;
    }
    for i in 0..N {
        let (value, flag) = atan_lane(x0[i]);
        atan0[i] = value;
        flags[i] |= flag;
    }
    if flags.iter().any(|&flag| flag) {
        return None;
    }
    let mut values = [0.0; N];
    for i in 0..N {
        let at1 = (1.0 + lead[i]) * log1[i] - 2.0 * 1.0 + atan_scale[i] * atan1[i];
        let at0 = (0.0 + lead[i]) * log0[i] - 2.0 * 0.0 + atan_scale[i] * atan0[i];
        values[i] = 0.5 * (at1 - at0);
    }
    Some(values)
}

/// `gauss_legendre` of s -> `log_integral((a + s u) - c, v)` over [0, 1], [0, 0.5] and [0.5, 1], bit-identical to the scalar path;
/// None when a lane leaves the common branches (the caller then runs the scalar path). `v` must not be the zero vector.
#[inline(always)]
pub(crate) fn first_panels(a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3) -> Option<(f64, f64, f64)> {
    let values = integrand(&ABSCISSAS, a, u, c, v)?;
    Some((panel(&values[0..8], 0.5), panel(&values[8..16], 0.25), panel(&values[16..24], 0.25)))
}

/// The panel [0, 1] alone (`gauss_legendre(inner, 0, 1)`, the `whole` of `first_panels`, same bits) for a third of the values; None as
/// `first_panels`. `v` must not be the zero vector.
#[inline(always)]
pub(crate) fn whole_panel(a: &Vec3, u: &Vec3, c: &Vec3, v: &Vec3) -> Option<f64> {
    let values = integrand(&WHOLE, a, u, c, v)?;
    Some(panel(&values, 0.5))
}

#[cfg(test)]
mod tests {
    use super::*;
    use llull_jsmath::{atan, log};

    /// xorshift64*: a fixed stream of bit patterns.
    fn stream(seed: u64) -> impl FnMut() -> u64 {
        let mut state = seed;
        move || {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            state.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
    }

    /// Random doubles over every exponent, plus the neighbourhoods of the branch boundaries of both functions.
    fn samples() -> Vec<f64> {
        let mut next = stream(0x9E37_79B9_7F4A_7C15);
        let mut out: Vec<f64> = (0..400_000).map(|_| f64::from_bits(next())).collect();
        let boundaries = [
            0.0,
            f64::MIN_POSITIVE,
            1.0,
            2.0,
            0.5,
            0.4375,
            0.6875,
            1.1875,
            2.4375,
            7.450580596923828e-9,
            73786976294838206464.0,
            std::f64::consts::SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
            1.0 + 9.5367431640625e-7,
            f64::MAX,
        ];
        for value in boundaries {
            for step in -40i64..=40 {
                let near = f64::from_bits(value.to_bits().wrapping_add_signed(step));
                out.extend([near, -near]);
            }
        }
        out.extend((0..400_000).map(|k| 1e-3 + f64::from(k) * 2.5e-5));
        out.extend([f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.0, 5e-324]);
        out
    }

    #[test]
    fn log_lane_is_the_v8_log_or_says_so() {
        let mut used = 0;
        for x in samples() {
            let (value, other_branch) = log_lane(x);
            if !other_branch {
                used += 1;
                assert_eq!(value.to_bits(), log(x).to_bits(), "log({x:e})");
            }
        }
        assert!(used > 500_000, "{used}");
        assert!(log_lane(1.0).1 && log_lane(0.0).1 && log_lane(-1.0).1 && log_lane(f64::NAN).1 && log_lane(5e-324).1);
        assert!(!log_lane(3.0).1 && !log_lane(0.3).1);
    }

    #[test]
    fn atan_lane_is_the_v8_atan_or_says_so() {
        let mut used = 0;
        for x in samples() {
            let (value, other_branch) = atan_lane(x);
            if !other_branch {
                used += 1;
                assert_eq!(value.to_bits(), atan(x).to_bits(), "atan({x:e})");
            }
        }
        assert!(used > 400_000, "{used}");
        assert!(atan_lane(0.0).1 && atan_lane(1e-9).1 && atan_lane(1e20).1 && atan_lane(f64::NAN).1 && atan_lane(f64::INFINITY).1);
        for x in [0.3, -0.3, 0.5, -0.9, 2.0, -2.0, 100.0, -1e19] {
            assert!(!atan_lane(x).1, "{x}");
        }
    }

    #[test]
    fn the_abscissas_are_those_of_the_scalar_rule() {
        let mut expected = Vec::new();
        for (lo, hi) in [(0.0, 1.0), (0.0, 0.5), (0.5, 1.0)] {
            let (half, mid) = (0.5 * (hi - lo), 0.5 * (hi + lo));
            for node in NODES {
                expected.extend([mid - node * half, mid + node * half]);
            }
        }
        assert_eq!(ABSCISSAS.to_vec(), expected);
        assert_eq!(WHOLE.to_vec(), expected[0..8]);
    }
}
