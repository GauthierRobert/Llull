//! `llull-compute post fatigue <job-folder>` (PHY-07 TR-FAT-41): superposition, scalar measure, rainflow, mean-stress correction and
//! Miner damage on EVERY node. The host (`server/src/native/fatigueField.ts`) writes `job.json` + `tensors.f64` from the pure
//! TypeScript builder `fatigue/feField.ts`; this job writes `field.f64`. Nodes run in parallel (rayon) but every node's numbers come
//! from its own sequential loop and land at its own index, so the output is identical for any thread count (RS1 §2 rule 3).

use crate::damage::{add_strain_life_cycle, add_stress_life_cycle, StrainLifeSetup, StressLifeSetup, EMPTY_SUM, FLAG_STATIC_FAILURE};
use crate::rainflow::{for_each_cycle, CountingMethod, ResidueRule};
use crate::stress::{node_series, Measure, Tensor};
use crate::JobError;
use rayon::prelude::*;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counting {
    pub method: CountingMethod,
    pub residue: ResidueRule,
    pub gate: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum DamageSetup {
    StressLife(StressLifeSetup),
    StrainLife(StrainLifeSetup),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FatigueJob {
    pub node_count: usize,
    pub load_cases: usize,
    pub steps: usize,
    /// `histories[k][t]`: factor of load case k at step t (already times the mapping scale).
    pub histories: Vec<Vec<f64>>,
    pub measure: Measure,
    pub counting: Counting,
    pub damage: DamageSetup,
}

/// Values per node in `field.f64`, in this order.
pub const FIELD_COMPONENTS: usize = 4;
/// Bit of the flags value (component 3) set when a cycle fell outside the tested life range of the curve.
pub const FLAG_EXTRAPOLATED: u32 = 8;

/// Per-thread buffers reused from node to node (no per-node allocation on the hot path).
#[derive(Default)]
struct Scratch {
    series: Vec<f64>,
    stack: Vec<f64>,
    tensors: Vec<Tensor>,
}

/// `[damagePerBlock, cyclesCounted, maxEquivalentAmplitude, flags]` of one node (flags: damage flags | FLAG_EXTRAPOLATED). Cycles go
/// straight from the counter into the Miner sum in counting order, which is the order of `count_cycles` + `*_damage`, so the sum is the same.
fn node_field(job: &FatigueJob, scratch: &mut Scratch) -> [f64; FIELD_COMPONENTS] {
    let Scratch { series, stack, tensors } = scratch;
    node_series(tensors, &job.histories, job.steps, job.measure, series);
    let Counting { method, residue, gate } = job.counting;
    let mut sum = EMPTY_SUM;
    match &job.damage {
        DamageSetup::StressLife(setup) => {
            for_each_cycle(series, method, residue, gate, stack, |c| add_stress_life_cycle(&mut sum, &c, setup))
        }
        DamageSetup::StrainLife(setup) => {
            for_each_cycle(series, method, residue, gate, stack, |c| add_strain_life_cycle(&mut sum, &c, setup))
        }
    }
    let flags = sum.flags | if sum.extrapolated { FLAG_EXTRAPOLATED } else { 0 };
    [sum.damage, sum.cycles_counted, sum.max_equivalent_amplitude, f64::from(flags)]
}

/// Validates the job against the tensor buffer (`node_count * load_cases * 6` values, node-major).
pub fn check(job: &FatigueJob, tensors: &[f64]) -> Result<(), JobError> {
    let expected = job.node_count.checked_mul(job.load_cases).and_then(|v| v.checked_mul(6));
    if expected != Some(tensors.len()) {
        return Err(JobError::input(format!(
            "tensors.f64 holds {} values, expected node_count {} x load_cases {} x 6",
            tensors.len(),
            job.node_count,
            job.load_cases
        )));
    }
    if job.histories.len() != job.load_cases || job.histories.iter().any(|h| h.len() != job.steps) {
        return Err(JobError::input(format!("histories must be {} load cases x {} steps", job.load_cases, job.steps)));
    }
    if job.load_cases == 0 || job.steps < 2 {
        return Err(JobError::input("a fatigue job needs >= 1 load case and >= 2 steps".to_string()));
    }
    if let Measure::Component { index } = job.measure {
        if index > 5 {
            return Err(JobError::input(format!("component index {index} is not 0..5")));
        }
    }
    Ok(())
}

/// The field of every node, node order kept: `node_count * FIELD_COMPONENTS` values.
pub fn run(job: &FatigueJob, tensors: &[f64]) -> Result<Vec<f64>, JobError> {
    check(job, tensors)?;
    let per_node = job.load_cases * 6;
    let mut field = vec![0.0f64; job.node_count * FIELD_COMPONENTS];
    field.par_chunks_mut(FIELD_COMPONENTS).enumerate().for_each_init(Scratch::default, |scratch, (node, out)| {
        scratch.tensors.clear();
        let values = &tensors[node * per_node..(node + 1) * per_node];
        scratch.tensors.extend(values.chunks_exact(6).map(|c| [c[0], c[1], c[2], c[3], c[4], c[5]]));
        out.copy_from_slice(&node_field(job, scratch));
    });
    Ok(field)
}

/// Nodes whose flags carry a static failure (for the job's progress message).
pub fn static_failures(field: &[f64]) -> usize {
    field.chunks_exact(FIELD_COMPONENTS).filter(|node| (node[3] as u32) & FLAG_STATIC_FAILURE != 0).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::life::{CompressiveMean, MeanModel, MeanStressInputs, StressLifeCurve};

    fn job(node_count: usize) -> FatigueJob {
        FatigueJob {
            node_count,
            load_cases: 1,
            steps: 3,
            histories: vec![vec![0.0, 1.0, 0.0]],
            measure: Measure::SignedVonMises,
            counting: Counting { method: CountingMethod::ThreePoint, residue: ResidueRule::Repeat, gate: 0.0 },
            damage: DamageSetup::StressLife(StressLifeSetup {
                curve: StressLifeCurve::SnBasquin { sigma_f: Some(1000.0), b: -0.1, endurance_amplitude: None, tested_life_range: None },
                modifier_product: 1.0,
                mean: MeanStressInputs {
                    model: MeanModel::None,
                    gamma: None,
                    su: None,
                    sy: None,
                    sigma_f: None,
                    compressive_mean: CompressiveMean::NoBenefit,
                },
                ftu: Some(450.0),
                stress_scale: 1.0,
            }),
        }
    }

    #[test]
    fn damages_every_node_in_order() {
        let tensors = [100.0, 0.0, 0.0, 0.0, 0.0, 0.0, 200.0, 0.0, 0.0, 0.0, 0.0, 0.0, 500.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let field = run(&job(3), &tensors).unwrap();
        assert_eq!(field.len(), 12);
        assert!(field[4] > field[0]);
        assert_eq!(field[1], 1.0);
        assert_eq!(field[11], 1.0, "the 500 MPa node reaches Ftu: static failure flag");
        assert_eq!(static_failures(&field), 1);
    }

    #[test]
    fn refuses_inconsistent_inputs() {
        assert!(run(&job(2), &[0.0; 6]).is_err());
        let mut bad = job(1);
        bad.histories = vec![vec![0.0, 1.0]];
        assert!(run(&bad, &[0.0; 6]).is_err());
        bad = job(1);
        bad.measure = Measure::Component { index: 7 };
        assert!(run(&bad, &[0.0; 6]).is_err());
        bad = job(1);
        bad.steps = 1;
        bad.histories = vec![vec![0.0]];
        assert!(run(&bad, &[0.0; 6]).is_err());
    }
}
