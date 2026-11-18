/** Validation of the engine model against stored reference data (compare_to_reference, FR-FPR-77 / 78, TR-FPR-18). */

import { summariseComparison } from '../../sim/engine/referenceComparison';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, failer, report } from '@core/commands/noop';
import { reviewResult } from '@core/model/reviewEnvelope';
import { dynamicsOf } from '../bodies';
import { crankOf } from './operatingPoint';
import { BRAKE_KEYS, compareWork, pointEnv, timestepNumerical, workOf } from './compareReferencePoints';
import { compareSeriesReferences } from './referenceSeries';

const NAME = 'compare_to_reference';
/** Operating points per call (TECHNICAL_SPEC 8 budget: Rotax curve of 9 points in under 30 s). */
const MAX_POINTS = 12;

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
    reference: z
      .string()
      .describe(
        'Reference id (add_reference_data), "all" for every stored ENGINE reference, or "all_series" for every stored TIME-SERIES reference. A time-series id (add_reference_data with `series`) simulates the model over its time span and reports the RMS and peak error of the joint / drive quantity against it.',
      ),
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
    if (
      params.reference === 'all_series' ||
      (doc.prototype?.references?.[params.reference] === undefined && dynamicsOf(doc).referenceSeries?.[params.reference] !== undefined)
    )
      return compareSeriesReferences(doc, params.reference, ctx);
    const references = doc.prototype?.references ?? {};
    const selected =
      params.reference === 'all' ? Object.values(references) : [references[params.reference]].flatMap((r) => (r === undefined ? [] : [r]));
    if (selected.length === 0)
      return fail(
        params.reference === 'all'
          ? 'the document has no reference data (add_reference_data first)'
          : `reference '${params.reference}' not found (add_reference_data first)`,
      );
    if (ctx?.physics === null || ctx?.physics === undefined)
      return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
    const context = ctx;
    const engineName = ctx.physics.name;
    const dynamics = dynamicsOf(doc);
    const crank = crankOf(dynamics);
    if (crank === undefined) return fail('the model has no cylinder pressure (add_cylinder_pressure first)');
    const losses = Object.values(dynamics.losses ?? {}).find((record) => record.crank === crank);
    const work = workOf(selected, params.points);
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
    const env = pointEnv(doc, params, context, dynamics, crank);
    const { rel: numericalRel, numerical } = timestepNumerical(env, work);
    const { items, comparisons } = compareWork(env, work, numericalRel);
    const summary = summariseComparison(comparisons);
    const result = reviewResult(
      'dynamics',
      items,
      {
        method:
          'simulate_motion at full throttle, governed at the point rpm (brake quantities) or free against the propeller (static rpm); E = S - D, U_val = sqrt(U_num² + U_input² + U_D²)',
        engine: engineName,
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
