/** compare_to_reference phases: run each reference point on the engine model, compare it, and turn the outcome into review items. */

import type { DynamicsModel } from '@core/model/dynamics';
import type { ReferenceData, ReferencePoint } from '@core/model/prototype';
import { couplingsOf } from '@core/model/transmissions';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { type ReviewItem, reviewItem } from '@core/model/reviewEnvelope';
import { comparePoint, type PointComparison } from '../../sim/engine/referenceComparison';
import type { AccuracyBand } from '../../sim/accuracy';
import { runOperatingPoint, type PointRefusal, type PointRun } from './operatingPoint';

/** Mean speed of the last quarter against the one before it above which a free run is reported as not settled. */
const SETTLED_DRIFT = 0.02;
export const BRAKE_KEYS = { brake_torque_Nm: 'brakeTorqueNm', brake_power_kW: 'brakePowerKW', bmep_bar: 'bmepBar' } as const;

export interface Work {
  readonly reference: ReferenceData;
  readonly point: ReferencePoint;
}

export interface CompareParams {
  readonly points?: number[] | undefined;
  readonly cycles?: number | undefined;
  readonly durationS?: number | undefined;
  readonly timestepHalving?: boolean | undefined;
  readonly engineCylinders?: number | undefined;
}

export interface Numerical {
  rpm: number;
  timestepS: number;
  halfTimestepS: number;
  brakeTorqueChange: number;
}

/** What every point run needs: the document, parameters, execution context, engine model and its crank, plus the governed-run cache. */
export interface PointEnv {
  readonly doc: CadDocument;
  readonly params: CompareParams;
  readonly context: ExecutionContext;
  readonly dynamics: DynamicsModel;
  readonly crank: string;
  readonly governed: Map<number, PointRun | PointRefusal>;
  readonly governedAt: (rpm: number, timestepS?: number) => PointRun | PointRefusal;
}

export function pointEnv(
  doc: CadDocument,
  params: CompareParams,
  context: ExecutionContext,
  dynamics: DynamicsModel,
  crank: string,
): PointEnv {
  const cycles = params.cycles ?? 2;
  return {
    doc,
    params,
    context,
    dynamics,
    crank,
    governed: new Map<number, PointRun | PointRefusal>(),
    governedAt: (rpm, timestepS) =>
      runOperatingPoint(doc, { mode: 'governed', rpm, cycles, ...(timestepS !== undefined ? { timestepS } : {}) }, context),
  };
}

/** The reference points of `selected` that match the requested rpm list (every point without one). */
export function workOf(selected: readonly ReferenceData[], requested: readonly number[] | undefined): Work[] {
  const wanted = (point: ReferencePoint): boolean =>
    requested === undefined || (point.rpm !== undefined && requested.some((rpm) => Math.abs(rpm - (point.rpm ?? NaN)) < 0.5));
  return selected.flatMap((reference) => reference.points.filter(wanted).map((point) => ({ reference, point })));
}

/** Speed ratio (driven / driver) from `crank` to `joint` through the gear couplings; 1 when they are the same joint, null when unconnected. */
function ratioFromCrank(dynamics: DynamicsModel, crank: string, joint: string): number | null {
  let [current, ratio] = [crank, 1];
  const couplings = couplingsOf(dynamics);
  for (let guard = 0; guard <= couplings.length; guard++) {
    if (current === joint) return ratio;
    const gear = couplings.find((candidate) => candidate.driver === current);
    if (gear === undefined) return null;
    [current, ratio] = [gear.driven, ratio * gear.ratio];
  }
  return null;
}

/** U_num: the brake torque at the calibration point (else the first governed point) at dt and dt/2. */
export function timestepNumerical(env: PointEnv, work: readonly Work[]): { rel: number | null; numerical: Numerical | null } {
  const none = { rel: null, numerical: null };
  const brakeWork = work.filter(({ reference, point }) => reference.quantity in BRAKE_KEYS && point.rpm !== undefined);
  const anchor = brakeWork.find(({ reference, point }) => reference.calibrationRpm.includes(point.rpm ?? NaN)) ?? brakeWork[0];
  if (env.params.timestepHalving === false || anchor?.point.rpm === undefined) return none;
  const base = env.governedAt(anchor.point.rpm);
  env.governed.set(anchor.point.rpm, base);
  const baseBrake = 'error' in base ? undefined : base.report.realism?.losses?.brakeTorqueNm;
  if ('error' in base || baseBrake === undefined) return none;
  const fine = env.governedAt(anchor.point.rpm, base.timestepS / 2);
  const fineBrake = 'error' in fine ? undefined : fine.report.realism?.losses?.brakeTorqueNm;
  if (fineBrake === undefined || baseBrake === 0) return none;
  const rel = Math.abs(fineBrake - baseBrake) / Math.abs(baseBrake);
  return {
    rel,
    numerical: { rpm: anchor.point.rpm, timestepS: base.timestepS, halfTimestepS: base.timestepS / 2, brakeTorqueChange: rel },
  };
}

interface Simulated {
  readonly simulated: number;
  readonly inputBand: AccuracyBand;
  readonly outside: boolean;
  readonly drifted: number | null;
}

interface NotRun {
  readonly notRun: string;
}

function brakeOutcome({ reference, point }: Work, key: (typeof BRAKE_KEYS)[keyof typeof BRAKE_KEYS], env: PointEnv): Simulated | NotRun {
  if (point.rpm === undefined) return { notRun: `a ${reference.quantity} point needs an rpm` };
  const run = env.governed.get(point.rpm) ?? env.governedAt(point.rpm);
  env.governed.set(point.rpm, run);
  if ('error' in run) return { notRun: `the run at ${point.rpm} rpm failed: ${run.error}` };
  const loss = run.report.realism?.losses;
  if (loss === null || loss === undefined) return { notRun: `no brake figures at ${point.rpm} rpm` };
  return {
    simulated: loss[key] * (key === 'bmepBar' ? 1 : (env.params.engineCylinders ?? 1)),
    inputBand: run.report.realism?.accuracy[key]?.band ?? null,
    outside: loss.outsideValidatedRange,
    drifted: null,
  };
}

function freeOutcome({ reference, point }: Work, env: PointEnv): Simulated | NotRun {
  const propeller = Object.values(env.dynamics.propellers)[0];
  if (propeller === undefined) return { notRun: `${reference.quantity} needs a propeller on the engine (add_propeller)` };
  const start = point.value;
  const run = runOperatingPoint(
    env.doc,
    { mode: 'free', rpm: start, cycles: Math.max(1, Math.ceil(((env.params.durationS ?? 2) * start) / 120)) },
    env.context,
  );
  if ('error' in run) return { notRun: `the free run failed: ${run.error}` };
  const ratio = reference.quantity === 'propeller_rpm' ? ratioFromCrank(env.dynamics, env.crank, propeller.joint) : 1;
  if (ratio === null) return { notRun: `propeller joint '${propeller.joint}' is not coupled to the crank '${env.crank}' by gears` };
  return { simulated: run.meanRpm * Math.abs(ratio), inputBand: null, outside: false, drifted: run.drift };
}

function simulateEntry(entry: Work, env: PointEnv): Simulated | NotRun {
  const quantity = entry.reference.quantity;
  const key = BRAKE_KEYS[quantity as keyof typeof BRAKE_KEYS];
  if (key !== undefined) return brakeOutcome(entry, key, env);
  if (quantity === 'static_rpm' || quantity === 'propeller_rpm') return freeOutcome(entry, env);
  return { notRun: `${quantity} is not modelled (no fuel model)` };
}

function notRunItem(entry: Work, why: string): ReviewItem {
  return reviewItem(
    'dynamics',
    'FPR_REFERENCE_MISMATCH',
    'not_run',
    [entry.reference.id],
    `${why}: fix the model or the point, then retry.`,
    {
      values: entry.point.rpm === undefined ? {} : { rpm: entry.point.rpm },
      unverified: true,
      note: why,
      findingKey: `dynamics:FPR_REFERENCE_MISMATCH:${entry.reference.id}@${entry.point.rpm ?? 'n/a'}`,
    },
  );
}

function comparisonItem({ reference, point }: Work, comparison: PointComparison): ReviewItem {
  const where = point.rpm === undefined ? '' : `@${point.rpm}`;
  return reviewItem(
    'dynamics',
    comparison.status === 'pass' || comparison.status === 'info' ? 'FPR_REFERENCE_MATCH' : 'FPR_REFERENCE_MISMATCH',
    comparison.status,
    [reference.id],
    comparison.status === 'fail' || comparison.status === 'warn'
      ? 'Review the model input with the largest band (friction constants, heat release, burn phasing); away from the calibration point the torque-curve shape is a prediction without a breathing model.'
      : 'None.',
    {
      values: {
        ...(point.rpm === undefined ? {} : { rpm: point.rpm }),
        simulated: comparison.simulated,
        reference: comparison.reference,
        error: comparison.error,
        errorRel: comparison.errorRel,
        bandRel: comparison.bandRel,
        ...(comparison.uncertainty.validation === null ? {} : { validationUncertainty: comparison.uncertainty.validation }),
      },
      findingKey: `dynamics:${comparison.status === 'pass' || comparison.status === 'info' ? 'FPR_REFERENCE_MATCH' : 'FPR_REFERENCE_MISMATCH'}:${reference.id}${where}`,
      unverified: comparison.origin === 'calibrated',
      note: `${comparison.origin}${comparison.uncertainty.missing.length > 0 ? `; missing: ${comparison.uncertainty.missing.join(', ')}` : ''}`,
    },
  );
}

function rangeWarning({ reference, point }: Work, outside: boolean): ReviewItem {
  return reviewItem(
    'dynamics',
    'FPR_OUTSIDE_VALIDATED_RANGE',
    'warn',
    [reference.id],
    outside
      ? 'The friction table does not cover this speed: add FMEP data for it or restrict the points.'
      : 'The free run has not settled: lengthen durationS.',
    { values: point.rpm === undefined ? {} : { rpm: point.rpm }, unverified: true },
  );
}

/** Run and compare every point in order; a point that cannot run becomes a not_run item. */
export function compareWork(
  env: PointEnv,
  work: readonly Work[],
  numericalRel: number | null,
): { items: ReviewItem[]; comparisons: PointComparison[] } {
  const items: ReviewItem[] = [];
  const comparisons: PointComparison[] = [];
  for (const entry of work) {
    const { reference, point } = entry;
    const outcome = simulateEntry(entry, env);
    if ('notRun' in outcome) {
      items.push(notRunItem(entry, outcome.notRun));
      continue;
    }
    // U_num comes from halving at a governed brake point: it does not describe a free-equilibrium rpm (listed missing there)
    const pointNumerical = reference.quantity in BRAKE_KEYS ? numericalRel : null;
    const comparison = comparePoint({
      reference,
      point,
      simulated: outcome.simulated,
      numericalRel: pointNumerical,
      inputBand: outcome.inputBand,
    });
    comparisons.push(comparison);
    items.push(comparisonItem(entry, comparison));
    if (outcome.outside || (outcome.drifted !== null && outcome.drifted > SETTLED_DRIFT)) items.push(rangeWarning(entry, outcome.outside));
  }
  return { items, comparisons };
}
