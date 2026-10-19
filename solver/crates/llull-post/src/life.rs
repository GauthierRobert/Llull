//! Fatigue life mathematics, a faithful port of `packages/domain-cae/src/fatigue/lifeMath.ts` (TR-FAT-10..13). Units: MPa. Every
//! `Math.pow` / `Math.log10` goes through `llull_jsmath`, so the numbers are bit-identical to the TypeScript reference.

use llull_jsmath::{exp, log, log10, pow};
use serde::Deserialize;

/// `Math.max(a, b)`: NaN when either is NaN (f64::max would drop it).
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.sign`: keeps zeros and NaN (f64::signum maps +0 to 1).
pub fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifeRange {
    pub min_cycles: f64,
    pub max_cycles: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum KneeSlope {
    Slope(f64),
    Named(KneeRule),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KneeRule {
    Cutoff,
}

/// An S-N curve with its stresses already in MPa (`None` = a unit the host could not convert, as `toMpa` returning null).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StressLifeCurve {
    SnBasquin {
        sigma_f: Option<f64>,
        b: f64,
        endurance_amplitude: Option<f64>,
        tested_life_range: Option<LifeRange>,
    },
    SnPowerLaw {
        s_d: Option<f64>,
        k: f64,
        k2: Option<KneeSlope>,
        n_d: f64,
        tested_life_range: Option<LifeRange>,
    },
    /// Points `[N, S]` of the first R family.
    SnTable {
        points: Vec<[f64; 2]>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurveLife {
    pub cycles: f64,
    pub extrapolated: bool,
}

fn outside_range(cycles: f64, range: Option<LifeRange>) -> bool {
    range.is_some_and(|r| cycles > r.max_cycles || cycles < r.min_cycles)
}

fn table_life(points: &[[f64; 2]], amplitude: f64) -> Option<CurveLife> {
    if points.len() < 2 {
        return None;
    }
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| {
        let difference = b[1] - a[1];
        if difference < 0.0 {
            std::cmp::Ordering::Less
        } else if difference > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let x = log10(amplitude);
    let mut segment = sorted.len() - 2;
    for i in 0..sorted.len() - 1 {
        if amplitude <= sorted[i][1] && amplitude >= sorted[i + 1][1] {
            segment = i;
            break;
        }
    }
    let [n0, s0] = sorted[segment];
    let [n1, s1] = sorted[segment + 1];
    let slope = (log10(n1) - log10(n0)) / (log10(s1) - log10(s0));
    let cycles = pow(10.0, log10(n0) + slope * (x - log10(s0)));
    let inside = amplitude <= sorted[0][1] && amplitude >= sorted[sorted.len() - 1][1];
    Some(CurveLife { cycles, extrapolated: !inside })
}

/// Cycles to failure at a fully reversed equivalent amplitude (MPa); `None` = a malformed curve.
pub fn stress_life(curve: &StressLifeCurve, amplitude: f64) -> Option<CurveLife> {
    if amplitude.is_nan() || amplitude <= 0.0 {
        return Some(CurveLife { cycles: f64::INFINITY, extrapolated: false });
    }
    match curve {
        StressLifeCurve::SnBasquin { sigma_f, b, endurance_amplitude, tested_life_range } => {
            let sigma_f = (*sigma_f)?;
            if sigma_f.is_nan() || sigma_f <= 0.0 || b.is_nan() || *b >= 0.0 {
                return None;
            }
            if let Some(endurance) = endurance_amplitude {
                if amplitude <= *endurance {
                    return Some(CurveLife { cycles: f64::INFINITY, extrapolated: false });
                }
            }
            let cycles = exp(log(amplitude / sigma_f) * (1.0 / b)) / 2.0;
            Some(CurveLife { cycles, extrapolated: outside_range(cycles, *tested_life_range) })
        }
        StressLifeCurve::SnPowerLaw { s_d, k, k2, n_d, tested_life_range } => {
            let s_d = (*s_d)?;
            if s_d.is_nan() || s_d <= 0.0 {
                return None;
            }
            let mut exponent = *k;
            if amplitude < s_d {
                match k2 {
                    Some(KneeSlope::Named(KneeRule::Cutoff)) => return Some(CurveLife { cycles: f64::INFINITY, extrapolated: false }),
                    Some(KneeSlope::Slope(slope)) => exponent = *slope,
                    None => {}
                }
            }
            let cycles = n_d * exp(log(amplitude / s_d) * -exponent);
            Some(CurveLife { cycles, extrapolated: outside_range(cycles, *tested_life_range) })
        }
        StressLifeCurve::SnTable { points } => table_life(points, amplitude),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeanModel {
    None,
    Goodman,
    Gerber,
    Soderberg,
    Morrow,
    Swt,
    Walker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressiveMean {
    NoBenefit,
    Formula,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeanStressInputs {
    pub model: MeanModel,
    pub gamma: Option<f64>,
    pub su: Option<f64>,
    pub sy: Option<f64>,
    pub sigma_f: Option<f64>,
    pub compressive_mean: CompressiveMean,
}

/// Equivalent fully reversed amplitude of (sa, sm); `None` = a strength the model needs is missing; infinity = static failure.
pub fn equivalent_amplitude(sa: f64, sm: f64, inputs: &MeanStressInputs) -> Option<f64> {
    let model = inputs.model;
    if model == MeanModel::None {
        return Some(sa);
    }
    let smax = sm + sa;
    if model == MeanModel::Swt || model == MeanModel::Walker {
        if smax <= 0.0 {
            return Some(0.0);
        }
        let gamma = if model == MeanModel::Swt { 0.5 } else { inputs.gamma.unwrap_or(f64::NAN) };
        return if gamma.is_finite() { Some(pow(smax, 1.0 - gamma) * pow(sa, gamma)) } else { None };
    }
    let strength = match model {
        MeanModel::Soderberg => inputs.sy,
        MeanModel::Morrow => inputs.sigma_f,
        _ => inputs.su,
    }?;
    if strength.is_nan() || strength <= 0.0 {
        return None;
    }
    if sm < 0.0 && inputs.compressive_mean == CompressiveMean::NoBenefit {
        return Some(sa);
    }
    let ratio = if model == MeanModel::Gerber { pow(sm / strength, 2.0) } else { sm / strength };
    Some(if ratio >= 1.0 { f64::INFINITY } else { sa / (1.0 - ratio) })
}

/// One term `coefficient * (2N)^exponent` of a strain-life equation.
#[derive(Debug, Clone, Copy)]
struct Term {
    coefficient: f64,
    exponent: f64,
}

fn terms_value(terms: &[Term], x: f64, target: f64) -> f64 {
    terms.iter().fold(0.0, |sum, term| sum + term.coefficient * pow(10.0, x * term.exponent)) - target
}

fn terms_slope(terms: &[Term], x: f64) -> f64 {
    std::f64::consts::LN_10 * terms.iter().fold(0.0, |sum, term| sum + term.coefficient * term.exponent * pow(10.0, x * term.exponent))
}

/// Reversals 2N with sum(term) = target: Newton on x = log10(2N) from x0 = 3 with a bisection fallback; `None` when not found.
fn solve_reversals(terms: &[Term], target: f64) -> Option<f64> {
    let mut x = 3.0;
    for _ in 0..200 {
        let step = terms_value(terms, x, target) / terms_slope(terms, x);
        if !step.is_finite() {
            break;
        }
        x -= step;
        if step.abs() < 1e-14 {
            return if terms_value(terms, x, target).abs() <= 1e-12 * js_max(target, 1e-300) { Some(pow(10.0, x)) } else { None };
        }
    }
    let (mut low, mut high) = (-3.0, 14.0);
    if terms_value(terms, low, target) * terms_value(terms, high, target) > 0.0 {
        return None;
    }
    for _ in 0..300 {
        let mid = (low + high) / 2.0;
        if terms_value(terms, mid, target) * terms_value(terms, low, target) > 0.0 {
            low = mid;
        } else {
            high = mid;
        }
    }
    Some(pow(10.0, (low + high) / 2.0))
}

/// A Coffin-Manson-Basquin curve with sigma'f and E in MPa (`None` = unconvertible unit).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrainLifeCurve {
    pub sigma_f: Option<f64>,
    #[serde(rename = "E")]
    pub e: Option<f64>,
    pub b: f64,
    pub c: f64,
    pub eps_f: f64,
}

fn constants_of(curve: &StrainLifeCurve) -> Option<(f64, f64)> {
    let (sigma_f, e) = (curve.sigma_f?, curve.e?);
    if sigma_f.is_nan() || sigma_f <= 0.0 || e.is_nan() || e <= 0.0 {
        None
    } else {
        Some((sigma_f, e))
    }
}

/// Reversals to failure at strain amplitude `eps_a`: Coffin-Manson-Basquin with the Morrow mean-stress term `sigma_m` (MPa).
pub fn strain_life_reversals(curve: &StrainLifeCurve, eps_a: f64, sigma_m: f64) -> Option<f64> {
    let (sigma_f, e) = constants_of(curve)?;
    solve_reversals(
        &[Term { coefficient: (sigma_f - sigma_m) / e, exponent: curve.b }, Term { coefficient: curve.eps_f, exponent: curve.c }],
        eps_a,
    )
}

/// Reversals to failure with the Smith-Watson-Topper parameter sigma_max * eps_a.
pub fn swt_life_reversals(curve: &StrainLifeCurve, sigma_max: f64, eps_a: f64) -> Option<f64> {
    let (sigma_f, e) = constants_of(curve)?;
    solve_reversals(
        &[
            Term { coefficient: pow(sigma_f, 2.0) / e, exponent: 2.0 * curve.b },
            Term { coefficient: sigma_f * curve.eps_f, exponent: curve.b + curve.c },
        ],
        sigma_max * eps_a,
    )
}

/// Cyclic Ramberg-Osgood curve (MPa).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CyclicCurve {
    #[serde(rename = "E")]
    pub e: f64,
    pub k_prime: f64,
    pub n_prime: f64,
}

/// Total strain on the cyclic curve at stress `sigma`.
pub fn cyclic_strain(curve: &CyclicCurve, sigma: f64) -> f64 {
    sigma / curve.e + pow(sigma / curve.k_prime, 1.0 / curve.n_prime)
}

/// Local stress of Neuber's rule for the elastic notch stress `elastic_local` = Kf S (bisection, 1e-13 relative).
pub fn neuber_stress(curve: &CyclicCurve, elastic_local: f64) -> f64 {
    if elastic_local.is_nan() || elastic_local <= 0.0 {
        return 0.0;
    }
    let target = pow(elastic_local, 2.0) / curve.e;
    let (mut low, mut high) = (0.0, elastic_local);
    let mut i = 0;
    while i < 200 && high - low > 1e-13 * elastic_local {
        let mid = (low + high) / 2.0;
        if mid * cyclic_strain(curve, mid) < target {
            low = mid;
        } else {
            high = mid;
        }
        i += 1;
    }
    (low + high) / 2.0
}

/// Masing hysteresis strain range for a stress range.
pub fn masing_strain_range(curve: &CyclicCurve, stress_range: f64) -> f64 {
    stress_range / curve.e + 2.0 * pow(stress_range / (2.0 * curve.k_prime), 1.0 / curve.n_prime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_helpers_keep_nan_and_zero() {
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert_eq!(js_max(2.0, 1.0), 2.0);
        assert_eq!(js_sign(0.0), 0.0);
        assert_eq!(js_sign(-3.0), -1.0);
    }

    #[test]
    fn basquin_and_power_law_lives() {
        let basquin = StressLifeCurve::SnBasquin { sigma_f: Some(1000.0), b: -0.1, endurance_amplitude: None, tested_life_range: None };
        let life = stress_life(&basquin, 500.0).unwrap();
        assert!((life.cycles - 0.5 * 2f64.powf(10.0)).abs() < 1e-9);
        assert_eq!(stress_life(&basquin, 0.0).unwrap().cycles, f64::INFINITY);
        let malformed = StressLifeCurve::SnBasquin { sigma_f: None, b: -0.1, endurance_amplitude: None, tested_life_range: None };
        assert!(stress_life(&malformed, 10.0).is_none());
        let cutoff = StressLifeCurve::SnPowerLaw {
            s_d: Some(100.0),
            k: 3.0,
            k2: Some(KneeSlope::Named(KneeRule::Cutoff)),
            n_d: 2e6,
            tested_life_range: None,
        };
        assert_eq!(stress_life(&cutoff, 50.0).unwrap().cycles, f64::INFINITY);
        // exp(ln(2) * -3) instead of 2 ** -3: equal to round-off (the TS formula is the same, so native stays bit-identical).
        assert!((stress_life(&cutoff, 200.0).unwrap().cycles / (2e6 / 8.0) - 1.0).abs() < 1e-14);
        let table = StressLifeCurve::SnTable { points: vec![[1e3, 400.0], [1e6, 100.0]] };
        assert!(!stress_life(&table, 200.0).unwrap().extrapolated);
        assert!(stress_life(&table, 50.0).unwrap().extrapolated);
        assert!(stress_life(&StressLifeCurve::SnTable { points: vec![] }, 50.0).is_none());
    }

    #[test]
    fn mean_stress_models() {
        let base = MeanStressInputs {
            model: MeanModel::Goodman,
            gamma: None,
            su: Some(500.0),
            sy: None,
            sigma_f: None,
            compressive_mean: CompressiveMean::NoBenefit,
        };
        assert_eq!(equivalent_amplitude(100.0, 250.0, &base), Some(200.0));
        assert_eq!(equivalent_amplitude(100.0, -250.0, &base), Some(100.0));
        assert_eq!(equivalent_amplitude(100.0, 600.0, &base), Some(f64::INFINITY));
        assert_eq!(equivalent_amplitude(100.0, 1.0, &MeanStressInputs { model: MeanModel::Soderberg, ..base }), None);
        assert_eq!(equivalent_amplitude(100.0, -200.0, &MeanStressInputs { model: MeanModel::Swt, ..base }), Some(0.0));
        assert_eq!(equivalent_amplitude(100.0, 100.0, &MeanStressInputs { model: MeanModel::Walker, ..base }), None);
        assert_eq!(equivalent_amplitude(7.0, 1.0, &MeanStressInputs { model: MeanModel::None, ..base }), Some(7.0));
    }

    #[test]
    fn strain_life_solves() {
        let curve = StrainLifeCurve { sigma_f: Some(1000.0), e: Some(200_000.0), b: -0.1, c: -0.6, eps_f: 0.5 };
        let reversals = strain_life_reversals(&curve, 0.0075, 0.0).unwrap();
        let back = 1000.0 / 200_000.0 * reversals.powf(-0.1) + 0.5 * reversals.powf(-0.6);
        assert!((back - 0.0075).abs() < 1e-12);
        assert!(swt_life_reversals(&curve, 400.0, 0.004).is_some());
        assert!(strain_life_reversals(&StrainLifeCurve { e: None, ..curve }, 0.01, 0.0).is_none());
        let cyclic = CyclicCurve { e: 210_000.0, k_prime: 1060.0, n_prime: 0.14 };
        let sigma = neuber_stress(&cyclic, 500.0);
        assert!((sigma * cyclic_strain(&cyclic, sigma) - 500.0 * 500.0 / 210_000.0).abs() < 1e-9);
        assert_eq!(neuber_stress(&cyclic, 0.0), 0.0);
        assert!(masing_strain_range(&cyclic, 400.0) > 400.0 / 210_000.0);
    }
}
