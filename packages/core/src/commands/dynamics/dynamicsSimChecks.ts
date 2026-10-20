/** Simulation-based items of check_dynamics: loop drift, cycle-energy closure, timestep sensitivity, propeller tip Mach. */

import { type CheckThreshold, findingKey } from '../../model/checkResult';
import type { SimulationData } from '../../dynamics/simulationReport';
import { type ReviewItem, reviewItem } from '../inspect/reviewEnvelope';
import { MAX_TIP_MACH } from './dynamicsStaticChecks';
import { phaseAlignedChange } from './phaseCompare';

/** Closure of the cycle energy: 0.5 % (named, FR-FPR-16). */
const ENERGY_GATE: CheckThreshold = {
  value: 0.005,
  unit: 'fraction',
  source: 'FR-FPR-16 cycle-energy closure gate 0.5 %',
  grade: 'C',
  defaulted: true,
};
/** Change of the key states when the timestep is halved: 1 % (named, FR-FPR-79). */
export const TIMESTEP_GATE: CheckThreshold = {
  value: 0.01,
  unit: 'fraction',
  source: 'FR-FPR-79 solution verification, named default 1 %',
  grade: 'C',
  defaulted: true,
};

/** What simulate_motion adds to SimulationData for loops and engines. */
export interface SimulationExtras {
  readonly loops?: {
    readonly count: number;
    readonly ids: string[];
    readonly residualM: number | null;
    readonly tier: 'pass' | 'warn' | 'fail';
    readonly passM: number;
    readonly failM: number;
  };
  readonly engineReport?: {
    readonly energyClosure: {
      readonly ratio: number | null;
      readonly gate: number;
      readonly crankSide: { readonly ratio: number } | null;
    } | null;
  } | null;
}
export type SimulationRun = SimulationData & SimulationExtras;

const item = (
  code: string,
  status: ReviewItem['status'],
  ids: readonly string[],
  remediation: string,
  extra?: Partial<ReviewItem>,
): ReviewItem => reviewItem('dynamics', code, status, ids, remediation, extra);

/** The simulation-based codes as not_run (no engine, a refused model, nothing moving), `loops` adds the drift item. */
export function notRunItems(why: string, loops: boolean): ReviewItem[] {
  const fix = `Run simulate_motion to see why (${why}); static items above still apply.`;
  return [
    ...(loops ? [item('FPR_LOOP_DRIFT', 'not_run', [], fix, { unverified: true, note: why })] : []),
    item('FPR_ENERGY_CLOSURE', 'not_run', [], fix, { unverified: true, note: why }),
    item('FPR_TIMESTEP_SENSITIVE', 'not_run', [], fix, { unverified: true, note: why }),
  ];
}

export function loopDriftItem(run: SimulationRun): ReviewItem[] {
  const loops = run.loops;
  if (loops === undefined) return [];
  const residual = loops.residualM ?? 0;
  const status = loops.tier === 'pass' ? 'pass' : loops.tier;
  const threshold: CheckThreshold = {
    value: (loops.tier === 'fail' ? loops.failM : loops.passM) * 1e6,
    unit: 'um',
    source: 'FR-FPR-15 loop residual gate (pass <= 1 um, warn <= 10 um, fail above)',
    grade: 'C',
    defaulted: true,
  };
  return [
    item(
      'FPR_LOOP_DRIFT',
      status,
      loops.ids,
      status === 'pass'
        ? 'None.'
        : 'Use a smaller timestep or set_dynamics_solver (loop time constant / impedance); reactions are approximate or unreliable meanwhile.',
      { values: { residualUm: residual * 1e6, loops: loops.count }, threshold, ...(status === 'pass' ? {} : { unverified: true }) },
    ),
  ];
}

export function energyItem(run: SimulationRun): ReviewItem {
  const closure = run.engineReport?.energyClosure ?? null;
  if (closure !== null && closure.ratio !== null) {
    const worst = Math.max(closure.ratio, closure.crankSide?.ratio ?? 0);
    const ok = worst <= closure.gate;
    return item(
      'FPR_ENERGY_CLOSURE',
      ok ? 'pass' : 'fail',
      [],
      ok ? 'None.' : 'Gas work on the simulated piston differs from the pressure model: use a smaller timestep or set_dynamics_solver.',
      { values: { closureFraction: worst }, threshold: { ...ENERGY_GATE, value: closure.gate } },
    );
  }
  const balance = run.energy?.balanceErrorFraction;
  if (balance === undefined)
    return item(
      'FPR_ENERGY_CLOSURE',
      'not_run',
      [],
      'The physics engine did not report the energy input; use simulate_motion energy: true to inspect the balance.',
      { unverified: true },
    );
  const ok = balance <= ENERGY_GATE.value;
  return item(
    'FPR_ENERGY_CLOSURE',
    ok ? 'pass' : 'warn',
    [],
    ok
      ? 'None.'
      : 'Energy in minus energy dissipated, absorbed and stored does not close: use a smaller timestep or a higher sampleRate (the integral is taken on the recorded samples).',
    {
      values: { balanceErrorFraction: balance, balanceErrorJ: run.energy?.balanceErrorJ ?? 0 },
      threshold: ENERGY_GATE,
      ...(ok ? {} : { unverified: true }),
      note: 'Energy balance of the whole run (initial + input - dissipated - propellers - final), integrated on the recorded samples; not the cycle integral of an engine.',
    },
  );
}

/** Largest relative change between two runs of the key states: final speed (of the peak speed) and final position of every joint. */
function stateChange(a: SimulationData, b: SimulationData): { change: number; worstJoint: string | null; moved: boolean } {
  let change = 0;
  let worstJoint: string | null = null;
  let moved = false;
  for (const [id, joint] of Object.entries(a.joints)) {
    const other = b.joints[id];
    if (other === undefined) continue;
    const speedScale = Math.max(joint.peakVelocity, other.peakVelocity);
    const positionScale = Math.max(Math.abs(joint.finalPosition), Math.abs(other.finalPosition));
    if (speedScale > 1e-9 || positionScale > 1e-9) moved = true;
    const speed = speedScale > 1e-9 ? Math.abs(joint.finalVelocity - other.finalVelocity) / speedScale : 0;
    const position = positionScale > 1e-9 ? Math.abs(joint.finalPosition - other.finalPosition) / positionScale : 0;
    const worst = Math.max(speed, position);
    if (worst > change) {
      change = worst;
      worstJoint = id;
    }
  }
  return { change, worstJoint, moved };
}

/**
 * The run is already at the finest allowed step, so no refinement exists to compare with: an info item with the reason (not a pass, not a
 * not_run: nothing failed to run). Engines get their convergence from check_timestep_convergence (brake torque and wrist-pin load).
 */
export function timestepFloorItem(timestepS: number, minimumS: number): ReviewItem {
  return item(
    'FPR_TIMESTEP_SENSITIVE',
    'info',
    [],
    'Nothing to do for this check; for an engine read check_timestep_convergence, otherwise set_dynamics_solver with a larger timestep to compare two steps.',
    {
      values: { timestepS, minimumTimestepS: minimumS },
      unverified: true,
      note: `The run is at the finest allowed timestep (${minimumS} s), so it cannot be halved; no refinement comparison was made here.`,
    },
  );
}

export function timestepItem(coarse: SimulationData, fine: SimulationData | null, why: string | null): ReviewItem {
  if (fine === null)
    return item(
      'FPR_TIMESTEP_SENSITIVE',
      'not_run',
      [],
      'The run at half the timestep did not complete; pass a larger timestep, or fix the model (simulate_motion).',
      { unverified: true, ...(why === null ? {} : { note: why }) },
    );
  const phase = phaseAlignedChange(coarse, fine);
  const { change, worstJoint, moved } = phase ?? stateChange(coarse, fine);
  if (!moved)
    return item(
      'FPR_TIMESTEP_SENSITIVE',
      'not_run',
      [],
      'No joint moved during the run, so nothing was compared: add a drive or an initial speed, or lengthen duration.',
      { unverified: true },
    );
  const ok = change <= TIMESTEP_GATE.value;
  return item(
    'FPR_TIMESTEP_SENSITIVE',
    ok ? 'pass' : 'warn',
    worstJoint === null ? [] : [worstJoint],
    ok ? 'None.' : 'Halving the timestep changes the result: use a smaller timestep (or set_dynamics_solver) for this mechanism.',
    {
      values: {
        maxChangeFraction: change,
        timestepS: coarse.timestep,
        halfTimestepS: fine.timestep,
        ...(phase === null ? {} : { comparedTurnDeg: (phase.spanRad * 180) / Math.PI }),
        ...(coarse.energy === undefined || fine.energy === undefined
          ? {}
          : { energyBalanceErrorCoarse: coarse.energy.balanceErrorFraction, energyBalanceErrorFine: fine.energy.balanceErrorFraction }),
      },
      threshold: TIMESTEP_GATE,
      ...(ok ? {} : { unverified: true }),
      note:
        phase === null
          ? 'Compared: final speed (relative to the peak speed) and final position of every joint, at dt and dt/2 (no joint turns a half turn, so there is no phase to align on).'
          : `Compared over the last turn of joint '${phase.drivingJoint}', both runs resampled at the same joint angle: RMS difference of speed and position of every joint (relative to the peak / excursion) and the cycle-mean |speed|; the energy-balance residual of each run is listed.`,
    },
  );
}

/** Tip Mach of each propeller from the run: a warn per propeller above the limit (the static figure-of-merit item is separate). */
export function tipMachItems(run: SimulationData): ReviewItem[] {
  return Object.entries(run.propellers)
    .filter(([, propeller]) => propeller.tipMach > MAX_TIP_MACH.value)
    .map(([id, propeller]) =>
      item(
        'FPR_UNREALISTIC',
        'warn',
        [id],
        'Reduce the propeller diameter or speed, or treat thrust and power as optimistic: compressibility is not modelled.',
        {
          values: { tipMach: propeller.tipMach },
          threshold: MAX_TIP_MACH,
          unverified: true,
          findingKey: `${findingKey('dynamics', 'FPR_UNREALISTIC', [id])}#tip_mach`,
        },
      ),
    );
}
