//! Miner damage of rainflow cycles, a faithful port of `packages/domain-cae/src/fatigue/damage.ts`: stress-life with mean-stress
//! correction and Marin modifiers, strain-life with Neuber and SWT / Morrow. Same loop order, so the sums are bit-identical.

use crate::life::{
    cyclic_strain, equivalent_amplitude, js_max, js_sign, masing_strain_range, neuber_stress, strain_life_reversals, stress_life,
    swt_life_reversals, CyclicCurve, MeanModel, MeanStressInputs, StrainLifeCurve, StressLifeCurve,
};
use crate::rainflow::Cycle;
use serde::Deserialize;

/// Per-cycle flags, as a bit set (`static_failure` 1, `swt_nonpositive` 2, `no_life` 4).
pub const FLAG_STATIC_FAILURE: u32 = 1;
pub const FLAG_SWT_NONPOSITIVE: u32 = 2;
pub const FLAG_NO_LIFE: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DamageSum {
    pub damage: f64,
    pub cycles_counted: f64,
    pub extrapolated: bool,
    pub flags: u32,
    /// Largest equivalent amplitude seen (MPa).
    pub max_equivalent_amplitude: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StressLifeSetup {
    pub curve: StressLifeCurve,
    pub modifier_product: f64,
    pub mean: MeanStressInputs,
    pub ftu: Option<f64>,
    /// Elastic notch factor Kf applied to the nominal stresses (1 = none).
    pub stress_scale: f64,
}

/// The Miner sum of no cycles.
pub const EMPTY_SUM: DamageSum =
    DamageSum { damage: 0.0, cycles_counted: 0.0, extrapolated: false, flags: 0, max_equivalent_amplitude: 0.0 };

/// Miner sum of `cycles` (MPa) on a stress-life curve.
pub fn stress_life_damage(cycles: &[Cycle], setup: &StressLifeSetup) -> DamageSum {
    let mut sum = EMPTY_SUM;
    cycles.iter().for_each(|cycle| add_stress_life_cycle(&mut sum, cycle, setup));
    sum
}

/// Adds one cycle to a stress-life Miner sum (cycles added in counting order give `stress_life_damage` bit for bit).
#[inline]
pub fn add_stress_life_cycle(sum: &mut DamageSum, cycle: &Cycle, setup: &StressLifeSetup) {
    sum.cycles_counted += cycle.count;
    let sa = (cycle.range / 2.0) * setup.stress_scale;
    let sm = cycle.mean * setup.stress_scale;
    let Some(equivalent) = equivalent_amplitude(sa, sm, &setup.mean) else {
        sum.flags |= FLAG_NO_LIFE;
        return;
    };
    if setup.ftu.is_some_and(|ftu| sm + sa >= ftu) || !equivalent.is_finite() {
        sum.flags |= FLAG_STATIC_FAILURE;
        return;
    }
    if equivalent == 0.0 && (setup.mean.model == MeanModel::Swt || setup.mean.model == MeanModel::Walker) {
        sum.flags |= FLAG_SWT_NONPOSITIVE;
    }
    sum.max_equivalent_amplitude = js_max(sum.max_equivalent_amplitude, equivalent);
    let Some(life) = stress_life(&setup.curve, equivalent / setup.modifier_product) else {
        sum.flags |= FLAG_NO_LIFE;
        return;
    };
    sum.extrapolated = sum.extrapolated || life.extrapolated;
    if life.cycles.is_finite() {
        sum.damage += cycle.count / life.cycles;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrainMeanModel {
    None,
    Morrow,
    Swt,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrainLifeSetup {
    pub curve: StrainLifeCurve,
    pub cyclic: CyclicCurve,
    pub mean: StrainMeanModel,
    pub kf: Option<f64>,
}

struct LocalResponse {
    sigma_a: f64,
    eps_a: f64,
    sigma_max: f64,
    sigma_mean: f64,
}

fn local_response(curve: &CyclicCurve, sa: f64, sm: f64, kf: Option<f64>) -> LocalResponse {
    let Some(kf) = kf else {
        return LocalResponse { sigma_a: sa, eps_a: cyclic_strain(curve, sa), sigma_max: sm + sa, sigma_mean: sm };
    };
    let sigma_a = neuber_stress(curve, kf * sa);
    let peak = sm + sa;
    let sigma_max = js_sign(peak) * neuber_stress(curve, kf * peak.abs());
    LocalResponse { sigma_a, eps_a: masing_strain_range(curve, 2.0 * sigma_a) / 2.0, sigma_max, sigma_mean: sigma_max - sigma_a }
}

fn strain_life_at(curve: &StrainLifeCurve, response: &LocalResponse, mean: StrainMeanModel) -> Option<f64> {
    if mean == StrainMeanModel::Swt {
        return if response.sigma_max <= 0.0 { Some(f64::INFINITY) } else { swt_life_reversals(curve, response.sigma_max, response.eps_a) };
    }
    strain_life_reversals(curve, response.eps_a, if mean == StrainMeanModel::Morrow { response.sigma_mean } else { 0.0 })
}

/// Miner sum of nominal-stress `cycles` (MPa) on a strain-life curve.
pub fn strain_life_damage(cycles: &[Cycle], setup: &StrainLifeSetup) -> DamageSum {
    let mut sum = EMPTY_SUM;
    cycles.iter().for_each(|cycle| add_strain_life_cycle(&mut sum, cycle, setup));
    sum
}

/// Adds one cycle to a strain-life Miner sum (counting order gives `strain_life_damage` bit for bit).
pub fn add_strain_life_cycle(sum: &mut DamageSum, cycle: &Cycle, setup: &StrainLifeSetup) {
    sum.cycles_counted += cycle.count;
    let response = local_response(&setup.cyclic, cycle.range / 2.0, cycle.mean, setup.kf);
    sum.max_equivalent_amplitude = js_max(sum.max_equivalent_amplitude, response.sigma_a);
    match strain_life_at(&setup.curve, &response, setup.mean) {
        None => sum.flags |= FLAG_NO_LIFE,
        Some(reversals) if !reversals.is_finite() => sum.flags |= FLAG_SWT_NONPOSITIVE,
        Some(reversals) => sum.damage += cycle.count / (reversals / 2.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::{CompressiveMean, KneeSlope};
    use crate::rainflow::{count_cycles, CountingMethod, ResidueRule};

    fn mean(model: MeanModel) -> MeanStressInputs {
        MeanStressInputs { model, gamma: None, su: Some(500.0), sy: None, sigma_f: None, compressive_mean: CompressiveMean::NoBenefit }
    }

    #[test]
    fn stress_life_flags() {
        let cycles = count_cycles(&[-200.0, 300.0, -100.0, 600.0], CountingMethod::ThreePoint, ResidueRule::HalfCycles, 0.0);
        let setup = StressLifeSetup {
            curve: StressLifeCurve::SnPowerLaw {
                s_d: Some(100.0),
                k: 3.0,
                k2: Some(KneeSlope::Slope(5.0)),
                n_d: 2e6,
                tested_life_range: None,
            },
            modifier_product: 1.0,
            mean: mean(MeanModel::Goodman),
            ftu: Some(550.0),
            stress_scale: 1.0,
        };
        let sum = stress_life_damage(&cycles, &setup);
        assert_eq!(sum.flags & FLAG_STATIC_FAILURE, FLAG_STATIC_FAILURE);
        assert!(sum.damage > 0.0);
        let swt = StressLifeSetup { mean: mean(MeanModel::Swt), ftu: None, ..setup.clone() };
        let compressive = count_cycles(&[-300.0, -100.0, -300.0], CountingMethod::ThreePoint, ResidueRule::HalfCycles, 0.0);
        assert_eq!(stress_life_damage(&compressive, &swt).flags, FLAG_SWT_NONPOSITIVE);
        let soderberg = StressLifeSetup { mean: mean(MeanModel::Soderberg), ..setup.clone() };
        assert_eq!(stress_life_damage(&compressive, &soderberg).flags, FLAG_NO_LIFE);
        let broken = StressLifeSetup { curve: StressLifeCurve::SnTable { points: vec![] }, ftu: None, ..setup };
        assert_eq!(stress_life_damage(&cycles, &broken).flags, FLAG_NO_LIFE);
    }

    #[test]
    fn strain_life_damage_with_neuber() {
        let cycles = count_cycles(&[0.0, 375.0, 0.0], CountingMethod::ThreePoint, ResidueRule::Repeat, 0.0);
        let setup = StrainLifeSetup {
            curve: StrainLifeCurve { sigma_f: Some(1000.0), e: Some(210_000.0), b: -0.1, c: -0.6, eps_f: 0.5 },
            cyclic: CyclicCurve { e: 210_000.0, k_prime: 1060.0, n_prime: 0.14 },
            mean: StrainMeanModel::Swt,
            kf: Some(2.39),
        };
        let sum = strain_life_damage(&cycles, &setup);
        assert!(sum.damage > 0.0 && sum.flags == 0);
        let compressive = count_cycles(&[0.0, -375.0, 0.0], CountingMethod::ThreePoint, ResidueRule::Repeat, 0.0);
        assert_eq!(strain_life_damage(&compressive, &setup).flags, FLAG_SWT_NONPOSITIVE);
        let morrow = StrainLifeSetup { mean: StrainMeanModel::Morrow, kf: None, ..setup.clone() };
        assert!(strain_life_damage(&cycles, &morrow).damage > 0.0);
        let broken = StrainLifeSetup { curve: StrainLifeCurve { e: None, ..setup.curve }, mean: StrainMeanModel::None, ..setup };
        assert_eq!(strain_life_damage(&cycles, &broken).flags, FLAG_NO_LIFE);
    }
}
