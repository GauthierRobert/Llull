/** Validation of the engine model against stored reference data (compare_to_reference, FR-FPR-77 / 78, TR-FPR-18). */

import type { DynamicsModel } from '../../../model/dynamics';
import type { ReferenceData, ReferencePoint } from '../../../model/prototype';
import { comparePoint, summariseComparison, type PointComparison } from '../../../dynamics/engine/referenceComparison';
import type { AccuracyBand } from '../../../dynamics/accuracy';
import type { CommandResult } from '../../types';
import { defineCommand, z } from '../../schema';
import { codedRejection, failer, report } from '../../noop';
import { currentContext } from '../../context';
import { type ReviewItem, reviewItem, reviewResult } from '../../inspect/reviewEnvelope';
import { dynamicsOf } from '../bodies';
import { crankOf, runOperatingPoint, type PointRun } from './operatingPoint';

const NAME = 'compare_to_reference';
/** Operating points per call (TECHNICAL_SPEC 8 budget: Rotax curve of 9 points in under 30 s). */
const MAX_POINTS = 12;
/** Mean speed of the last quarter against the one before it above which a free run is reported as not settled. */
const SETTLED_DRIFT = 0.02;
const BRAKE_KEYS = { brake_torque_Nm: 'brakeTorqueNm', brake_power_kW: 'brakePowerKW', bmep_bar: 'bmepBar' } as const;

interface Work {
  readonly reference: ReferenceData;
  readonly point: ReferencePoint;
}

const statusOf = (comparison: PointComparison): ReviewItem['status'] => comparison.status;

/** Speed ratio (driven / driver) from `crank` to `joint` through the gear couplings; 1 when they are the same joint, null when unconnected. */
function ratioFromCrank(dynamics: DynamicsModel, crank: string, joint: string): number | null {
  let [current, ratio] = [crank, 1];
  for (let guard = 0; guard <= Object.keys(dynamics.gears).length; guard++) {
    if (current === joint) return ratio;
    const gear = Object.values(dynamics.gears).find((candidate) => candidate.driver === current);
    if (gear === undefined) return null;
    [current, ratio] = [gear.driven, ratio * gear.ratio];
  }
  return null;
}

/**
 * @affects nothing — read-only; data { review envelope, points[], summary, numerical }
 * @invariant same document back, affected []; calibration points are `info` with origin calibrated and never pass evidence; a missing term
 *            of U_val is listed, never taken as 0
 * @failure no references / unknown reference id, no physics engine, no cylinder pressure, a brake quantity without set_engine_losses
 *          (FPR_NO_LOSSES), more than 12 operating points (FPR_BUDGET_EXCEEDED), a run that fails -> no-op or not_run item
 */
export const compareToReference = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'Validate the engine model against reference data (add_reference_data) by running it at each operating point and comparing: for every ' +
    'point S (simulated), D (reference), E = S - D, E/D, the validation uncertainty U_val = sqrt(U_num² + U_input² + U_D²) over the terms that ' +
    'are known (the missing ones are listed), the pass band (default ±5 %), the origin ("calibrated" for the reference\'s calibration points, ' +
    '"predicted" for hold-out points) and the status. Brake torque / power / BMEP references run the engine at full throttle governed at the ' +
    "point's rpm (one settling cycle + `cycles` measured) and read the BRAKE value (indicated minus friction), so they need set_engine_losses " +
    '(else FPR_NO_LOSSES: indicated against brake would mislead); static_rpm / propeller_rpm references run the engine free against its propeller ' +
    'from the window centre and read the equilibrium rpm. Statuses: calibration point = info (matched by construction, never pass evidence); ' +
    'hold-out point inside the band = pass; outside = fail (FPR_REFERENCE_MISMATCH) for a grade A / B reference, warn for grade C; window point ' +
    '(static rpm) passes inside min..max. The timestep-halving change of the brake torque at the calibration point gives U_num (FR-FPR-79, ' +
    'skip with timestepHalving false). The summary lists calibration and hold-out points separately and states the validation level ' +
    '(a model calibrated on every point is level 1: no predictive evidence). Away from the calibration point a miss is expected without a ' +
    'breathing model: the torque-curve shape comes only from friction, heat loss and burn scaling. Needs the physics engine. Read-only. ' +
    'At most 12 points per call. Computed by llull, not approved: a qualified engineer must review.',
  params: z.object({
    reference: z.string().describe('Reference id (add_reference_data), or "all" for every stored reference.'),
    points: z
      .array(z.number().positive())
      .max(MAX_POINTS)
      .optional()
      .describe('Only these rpm points of the reference(s). Default every point.'),
    cycles: z.number().int().min(1).max(6).optional().describe('Measured cycles per governed point after one settling cycle. Default 2.'),
    durationS: z
      .number()
      .positive()
      .max(30)
      .optional()
      .describe('Simulated seconds of a free-equilibrium run (static_rpm / propeller_rpm). Default 2.'),
    timestepHalving: z.boolean().optional().describe('Repeat one governed point at half the timestep to estimate U_num. Default true.'),
    engineCylinders: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Number of identical cylinders of the REAL engine the model stands for when the model has fewer (a single-cylinder demonstrator of a 4-cylinder engine): brake torque and power are multiplied by it; BMEP, being per displacement, is not. Default 1 (the model is the whole engine).',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, NAME);
    const context = ctx ?? currentContext();
    const references = doc.prototype?.references ?? {};
    const selected =
      params.reference === 'all' ? Object.values(references) : [references[params.reference]].flatMap((r) => (r === undefined ? [] : [r]));
    if (selected.length === 0)
      return fail(
        params.reference === 'all'
          ? 'the document has no reference data (add_reference_data first)'
          : `reference '${params.reference}' not found (add_reference_data first)`,
      );
    if (context.physics === null || context.physics === undefined)
      return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
    const dynamics = dynamicsOf(doc);
    const crank = crankOf(dynamics);
    if (crank === undefined) return fail('the model has no cylinder pressure (add_cylinder_pressure first)');
    const losses = Object.values(dynamics.losses ?? {}).find((record) => record.crank === crank);
    const wanted = (point: ReferencePoint): boolean =>
      params.points === undefined || (point.rpm !== undefined && params.points.some((rpm) => Math.abs(rpm - (point.rpm ?? NaN)) < 0.5));
    const work: Work[] = selected.flatMap((reference) => reference.points.filter(wanted).map((point) => ({ reference, point })));
    if (work.length === 0) return fail('no reference point matches the requested rpm points');
    if (work.length > MAX_POINTS)
      return codedRejection(
        doc,
        NAME,
        'FPR_BUDGET_EXCEEDED',
        `${work.length} operating points exceed the limit of ${MAX_POINTS} per call`,
        'Narrow the request with `points` (rpm list) or a single reference id.',
        [],
        ['points'],
      );
    const needsLosses = work.some(({ reference }) => reference.quantity in BRAKE_KEYS);
    if (needsLosses && losses === undefined)
      return codedRejection(
        doc,
        NAME,
        'FPR_NO_LOSSES',
        'a brake quantity needs the engine losses: indicated torque compared with brake data would mislead',
        'Run set_engine_losses on the crank (chen_flynn or fmep_table with a source), calibrate the heat release to a brake point, then retry.',
        [crank],
      );
    const cycles = params.cycles ?? 2;
    const governed = new Map<number, PointRun | { error: string }>();
    const governedAt = (rpm: number, timestepS?: number): PointRun | { error: string } =>
      runOperatingPoint(doc, { mode: 'governed', rpm, cycles, ...(timestepS !== undefined ? { timestepS } : {}) }, context);
    const items: ReviewItem[] = [];
    const comparisons: PointComparison[] = [];
    // U_num: the brake torque at the calibration point (else the first governed point) at dt and dt/2
    let numericalRel: number | null = null;
    let numerical: { rpm: number; timestepS: number; halfTimestepS: number; brakeTorqueChange: number } | null = null;
    const brakeWork = work.filter(({ reference, point }) => reference.quantity in BRAKE_KEYS && point.rpm !== undefined);
    const anchor = brakeWork.find(({ reference, point }) => reference.calibrationRpm.includes(point.rpm ?? NaN)) ?? brakeWork[0];
    if (params.timestepHalving !== false && anchor?.point.rpm !== undefined) {
      const base = governedAt(anchor.point.rpm);
      governed.set(anchor.point.rpm, base);
      const baseBrake = 'error' in base ? undefined : base.report.realism?.losses?.brakeTorqueNm;
      if (!('error' in base) && baseBrake !== undefined) {
        const fine = governedAt(anchor.point.rpm, base.timestepS / 2);
        const fineBrake = 'error' in fine ? undefined : fine.report.realism?.losses?.brakeTorqueNm;
        if (fineBrake !== undefined && baseBrake !== 0) {
          numericalRel = Math.abs(fineBrake - baseBrake) / Math.abs(baseBrake);
          numerical = {
            rpm: anchor.point.rpm,
            timestepS: base.timestepS,
            halfTimestepS: base.timestepS / 2,
            brakeTorqueChange: numericalRel,
          };
        }
      }
    }
    const notRun = (entry: Work, why: string): void => {
      items.push(
        reviewItem(
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
        ),
      );
    };
    for (const entry of work) {
      const { reference, point } = entry;
      let simulated: number;
      let inputBand: AccuracyBand = null;
      let outside = false;
      let drifted: number | null = null;
      const key = BRAKE_KEYS[reference.quantity as keyof typeof BRAKE_KEYS];
      if (key !== undefined) {
        if (point.rpm === undefined) {
          notRun(entry, `a ${reference.quantity} point needs an rpm`);
          continue;
        }
        const run = governed.get(point.rpm) ?? governedAt(point.rpm);
        governed.set(point.rpm, run);
        if ('error' in run) {
          notRun(entry, `the run at ${point.rpm} rpm failed: ${run.error}`);
          continue;
        }
        const loss = run.report.realism?.losses;
        if (loss === null || loss === undefined) {
          notRun(entry, `no brake figures at ${point.rpm} rpm`);
          continue;
        }
        simulated = loss[key] * (key === 'bmepBar' ? 1 : (params.engineCylinders ?? 1));
        inputBand = run.report.realism?.accuracy[key]?.band ?? null;
        outside = loss.outsideValidatedRange;
      } else if (reference.quantity === 'static_rpm' || reference.quantity === 'propeller_rpm') {
        const propeller = Object.values(dynamics.propellers)[0];
        if (propeller === undefined) {
          notRun(entry, `${reference.quantity} needs a propeller on the engine (add_propeller)`);
          continue;
        }
        const start = point.value;
        const run = runOperatingPoint(
          doc,
          { mode: 'free', rpm: start, cycles: Math.max(1, Math.ceil(((params.durationS ?? 2) * start) / 120)) },
          context,
        );
        if ('error' in run) {
          notRun(entry, `the free run failed: ${run.error}`);
          continue;
        }
        const ratio = reference.quantity === 'propeller_rpm' ? ratioFromCrank(dynamics, crank, propeller.joint) : 1;
        if (ratio === null) {
          notRun(entry, `propeller joint '${propeller.joint}' is not coupled to the crank '${crank}' by gears`);
          continue;
        }
        simulated = run.meanRpm * Math.abs(ratio);
        drifted = run.drift;
      } else {
        notRun(entry, `${reference.quantity} is not modelled (no fuel model)`);
        continue;
      }
      // U_num comes from halving at a governed brake point: it does not describe a free-equilibrium rpm (listed missing there)
      const pointNumerical = reference.quantity in BRAKE_KEYS ? numericalRel : null;
      const comparison = comparePoint({ reference, point, simulated, numericalRel: pointNumerical, inputBand });
      comparisons.push(comparison);
      const where = point.rpm === undefined ? '' : `@${point.rpm}`;
      items.push(
        reviewItem(
          'dynamics',
          comparison.status === 'pass' || comparison.status === 'info' ? 'FPR_REFERENCE_MATCH' : 'FPR_REFERENCE_MISMATCH',
          statusOf(comparison),
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
        ),
      );
      if (outside || (drifted !== null && drifted > SETTLED_DRIFT))
        items.push(
          reviewItem(
            'dynamics',
            'FPR_OUTSIDE_VALIDATED_RANGE',
            'warn',
            [reference.id],
            outside
              ? 'The friction table does not cover this speed: add FMEP data for it or restrict the points.'
              : 'The free run has not settled: lengthen durationS.',
            { values: point.rpm === undefined ? {} : { rpm: point.rpm }, unverified: true },
          ),
        );
    }
    const summary = summariseComparison(comparisons);
    const result = reviewResult(
      'dynamics',
      items,
      {
        method:
          'simulate_motion at full throttle, governed at the point rpm (brake quantities) or free against the propeller (static rpm); E = S - D, U_val = sqrt(U_num² + U_input² + U_D²)',
        engine: context.physics.name,
        tolerances: { bandRel: selected[0]?.bandRel ?? 0.05, timestepHalvingGate: 0.01, calibrationTolerance: 0.001 },
        params: { ...params },
      },
      { references: selected, dynamics: doc.dynamics ?? null },
    );
    const worst = items.filter((entry) => entry.status === 'fail' || entry.status === 'warn').length;
    const text =
      `${NAME}: ${result.status} — ${comparisons.length} point(s) compared, ${summary.statement}; ${worst} outside the band or flagged` +
      `${numerical === null ? '' : `; timestep halving at ${numerical.rpm} rpm changes the brake torque by ${(numerical.brakeTorqueChange * 100).toFixed(3)} %`}. ` +
      `Validation level ${summary.validationLevel}/4. Computed by llull, not approved — needs a qualified engineer.`;
    return report(doc, text, { ...result, points: comparisons, comparison: summary, numerical });
  },
});
