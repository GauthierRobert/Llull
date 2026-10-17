/** Constitutive increments of the small-strain driver: elastic, J2, Prony viscoelastic, Norton / Garofalo creep (PHY-02 §5.3, §5.8). */

import { garofaloRate, nortonEffectiveTime } from './creep';
import type { CreepModel, SmallModel } from './driverModel';
import { initialJ2State, j2Update, totalBackStress, trialStress, workIncrement, type J2State } from './j2';
import { matVec } from './linalg';
import { solveDecreasing } from './scalar';
import { deviator, equivalent, mean3, zero6, type Vec6 } from './tensor';
import { pronyRecursion } from './viscoelastic';

interface ViscoState {
  readonly shear: readonly Vec6[];
  readonly bulk: readonly number[];
}

export interface PointState {
  readonly strain: Vec6;
  readonly stress: Vec6;
  readonly j2: J2State | null;
  readonly visco: ViscoState | null;
  readonly creepEq: number;
  readonly work: number;
}

export interface TimeSlice {
  /** Start and end time of the increment (s). */
  readonly t0: number;
  readonly t1: number;
}

export function initialState(model: SmallModel): PointState {
  return {
    strain: zero6(),
    stress: zero6(),
    j2: model.j2 === null ? null : initialJ2State(model.j2),
    visco: model.prony === null ? null : { shear: model.prony.shear.map(zero6), bulk: model.prony.bulk.map(() => 0) },
    creepEq: 0,
    work: 0,
  };
}

const addStrain = (a: readonly number[], b: readonly number[]): Vec6 => a.map((value, i) => value + (b[i] ?? 0));

/** Strain with the deviatoric part as TENSOR components (engineering shear halved). */
const deviatoricTensor = (strain: readonly number[]): Vec6 => {
  const e = deviator(strain);
  return [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0, (strain[3] ?? 0) / 2, (strain[4] ?? 0) / 2, (strain[5] ?? 0) / 2];
};

function viscoelasticUpdate(model: SmallModel, state: PointState, dEps: readonly number[], slice: TimeSlice): PointState {
  const prony = model.prony;
  const iso = model.elastic.iso;
  const visco = state.visco;
  if (prony === null || iso === null || visco === null) return state;
  const reduced = (slice.t1 - slice.t0) / prony.shiftFactor;
  const strain = addStrain(state.strain, dEps);
  const dDev = deviatoricTensor(dEps);
  const dVol = (dEps[0] ?? 0) + (dEps[1] ?? 0) + (dEps[2] ?? 0);
  const shear = visco.shear.map((q, i) => {
    const term = prony.shear[i];
    return q.map((value, c) => pronyRecursion(value, 2 * iso.G * (term?.g ?? 0) * (dDev[c] ?? 0), reduced, term?.tau ?? 1));
  });
  const bulk = visco.bulk.map((q, j) => {
    const term = prony.bulk[j];
    return pronyRecursion(q, iso.K * (term?.k ?? 0) * dVol, reduced, term?.tau ?? 1);
  });
  const sumG = prony.shear.reduce((sum, term) => sum + term.g, 0);
  const sumK = prony.bulk.reduce((sum, term) => sum + term.k, 0);
  const devTotal = deviatoricTensor(strain);
  const volTotal = (strain[0] ?? 0) + (strain[1] ?? 0) + (strain[2] ?? 0);
  const stress = zero6();
  const pressure = iso.K * (1 - sumK) * volTotal + bulk.reduce((sum, q) => sum + q, 0);
  for (let c = 0; c < 6; c += 1) {
    stress[c] = 2 * iso.G * (1 - sumG) * (devTotal[c] ?? 0) + shear.reduce((sum, q) => sum + (q[c] ?? 0), 0) + (c < 3 ? pressure : 0);
  }
  return { ...state, strain, stress, visco: { shear, bulk }, work: state.work + workIncrement(state.stress, stress, dEps) };
}

/** Equivalent creep strain increment of a Norton / Garofalo law at equivalent stress q (MPa) over the slice. */
function creepIncrement(creep: CreepModel, q: number, slice: TimeSlice): number {
  if (creep.kind === 'norton') {
    const effective = nortonEffectiveTime(creep.m, slice.t0 * creep.timePerSecond, slice.t1 * creep.timePerSecond);
    return creep.A * (q * creep.stressPerMPa) ** creep.n * effective;
  }
  return garofaloRate(creep.A, creep.alpha, creep.n, creep.activationEnergy, q, creep.temperature) * (slice.t1 - slice.t0);
}

function creepUpdate(model: SmallModel, state: PointState, dEps: readonly number[], slice: TimeSlice): PointState | null {
  const iso = model.elastic.iso;
  const creep = model.creep;
  if (iso === null || creep === null) return state;
  const trial = trialStress(iso.G, iso.K, state.stress, dEps);
  const qTrial = equivalent(deviator(trial));
  let q = qTrial;
  if (qTrial > 0) {
    const residual = (x: number): number => qTrial - x - 3 * iso.G * creepIncrement(creep, x, slice);
    const solved = solveDecreasing(residual, 0, qTrial, 1e-10 * Math.max(qTrial, model.referenceStress));
    if (solved === null) return null;
    q = solved.x;
  }
  const scale = qTrial > 0 ? q / qTrial : 1;
  const pressure = mean3(trial);
  const s = deviator(trial);
  const stress = s.map((value, i) => value * scale + (i < 3 ? pressure : 0));
  return {
    ...state,
    strain: addStrain(state.strain, dEps),
    stress,
    creepEq: state.creepEq + (qTrial - q) / (3 * iso.G),
    work: state.work + workIncrement(state.stress, stress, dEps),
  };
}

/**
 * One constitutive increment of a small-strain point.
 * @failure local Newton (J2 return mapping, creep) not converged -> null
 */
export function advance(model: SmallModel, state: PointState, dEps: readonly number[], slice: TimeSlice): PointState | null {
  if (model.prony !== null) return viscoelasticUpdate(model, state, dEps, slice);
  if (model.creep !== null) return creepUpdate(model, state, dEps, slice);
  const strain = addStrain(state.strain, dEps);
  if (model.j2 !== null && state.j2 !== null) {
    const update = j2Update(model.j2, state.j2, dEps, slice.t1 - slice.t0);
    if (update === null) return null;
    return {
      ...state,
      strain,
      stress: update.state.stress,
      j2: update.state,
      work: state.work + workIncrement(state.stress, update.state.stress, dEps),
    };
  }
  const increment = matVec(model.elastic.C, dEps);
  const stress = state.stress.map((value, i) => value + (increment[i] ?? 0));
  return { ...state, strain, stress, work: state.work + workIncrement(state.stress, stress, dEps) };
}

export const backStressOf = (state: PointState): Vec6 => (state.j2 === null ? zero6() : totalBackStress(state.j2));
