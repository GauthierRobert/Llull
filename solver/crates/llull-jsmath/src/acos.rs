//! V8 `Math.acos` (fdlibm 5.3 `e_acos.c`; V8 `ieee754::acos`), bit for bit for every argument.
//!
//! fdlibm notice (kept as its licence requires): Copyright (C) 1993-2004 by Sun Microsystems, Inc. All rights reserved.
//! Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is preserved.

#![allow(clippy::excessive_precision)]

const PI: f64 = std::f64::consts::PI;
const PIO2_HI: f64 = std::f64::consts::FRAC_PI_2;
const PIO2_LO: f64 = 6.123_233_995_736_766_035_87e-17;
const P_S0: f64 = 1.666_666_666_666_666_574_15e-01;
const P_S1: f64 = -3.255_658_186_224_009_154_05e-01;
const P_S2: f64 = 2.012_125_321_348_629_258_81e-01;
const P_S3: f64 = -4.005_553_450_067_941_140_27e-02;
const P_S4: f64 = 7.915_349_942_898_145_321_76e-04;
const P_S5: f64 = 3.479_331_075_960_211_675_70e-05;
const Q_S1: f64 = -2.403_394_911_734_414_218_78e+00;
const Q_S2: f64 = 2.020_945_760_233_505_694_71e+00;
const Q_S3: f64 = -6.882_839_716_054_532_930_30e-01;
const Q_S4: f64 = 7.703_815_055_590_193_527_91e-02;

/// `p / q` of the rational approximation of `(asin(x) - x) / x^3` in `z = x^2`.
fn ratio(z: f64) -> f64 {
    let p = z * (P_S0 + z * (P_S1 + z * (P_S2 + z * (P_S3 + z * (P_S4 + z * P_S5)))));
    let q = 1.0 + z * (Q_S1 + z * (Q_S2 + z * (Q_S3 + z * Q_S4)));
    p / q
}

/// V8 `Math.acos`.
pub fn acos(x: f64) -> f64 {
    let bits = x.to_bits();
    let hx = (bits >> 32) as u32 as i32;
    let lx = bits as u32;
    let ix = hx & 0x7fff_ffff;
    if ix >= 0x3ff0_0000 {
        if ((ix - 0x3ff0_0000) as u32 | lx) == 0 {
            return if hx > 0 { 0.0 } else { PI + 2.0 * PIO2_LO };
        }
        return f64::NAN;
    }
    if ix < 0x3fe0_0000 {
        if ix <= 0x3c60_0000 {
            return PIO2_HI + PIO2_LO;
        }
        let r = ratio(x * x);
        return PIO2_HI - (x - (PIO2_LO - x * r));
    }
    if hx < 0 {
        let z = (1.0 + x) * 0.5;
        let s = z.sqrt();
        let w = ratio(z) * s - PIO2_LO;
        return PI - 2.0 * (s + w);
    }
    let z = (1.0 - x) * 0.5;
    let s = z.sqrt();
    let df = f64::from_bits(s.to_bits() & 0xffff_ffff_0000_0000);
    let c = (z - df * df) / (s + df);
    let w = ratio(z) * s + c;
    2.0 * (df + w)
}
