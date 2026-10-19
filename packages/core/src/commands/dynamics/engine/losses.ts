/** Engine mechanical losses on a crank (set_engine_losses, FR-FPR-71). */

import type { EngineLosses } from '../../../model/dynamics';
import { fmepBand } from '../../../dynamics/engine/engineLosses';
import { bandText } from '../../../dynamics/accuracy';
import type { CommandResult } from '../../types';
import { defineCommand, z } from '../../schema';
import { idOrNext } from '../../entity/explicitId';
import { changed, codedRejection, failer } from '../../noop';
import { dynamicsIdTaken, dynamicsOf, withDynamics } from '../bodies';

const modelSchema = z.object({
  kind: z
    .enum(['chen_flynn', 'fmep_table', 'component'])
    .describe(
      '"chen_flynn": FMEP = aPa + bRatio·p_max + cPaPerRpm·rpm + dPaPerRpm2·rpm² (fitted constants, stated accuracy 13 % mean / 35 % max [Chen-Flynn]). ' +
        '"fmep_table": FMEP (Pa) against rpm, linear between points, clamped outside (FPR_OUTSIDE_VALIDATED_RANGE). "component" (PNH / Sandoval-Heywood ' +
        'from bearings, valvetrain) is NOT supported: its equations are unchecked against a primary source, so it is refused rather than approximated.',
    ),
  aPa: z.number().optional().describe('chen_flynn: constant term, Pa (accessories, speed-independent losses).'),
  bRatio: z.number().optional().describe('chen_flynn: gas-load term, dimensionless: Pa of FMEP per Pa of ABSOLUTE peak cylinder pressure.'),
  cPaPerRpm: z.number().optional().describe('chen_flynn: linear speed term, Pa per rpm.'),
  dPaPerRpm2: z.number().optional().describe('chen_flynn: quadratic speed term, Pa per rpm².'),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe('fmep_table: [[rpm, FMEP in Pa], ...] with at least 2 points; 1 bar = 1e5 Pa.'),
  source: z.string().optional().describe('REQUIRED: where the constants or table come from (paper, datasheet, test). No source, no model.'),
});

/**
 * @affects adds 1 engine-loss record to doc.dynamics.losses (affected: [lossId], step-scoped id loss-<step>.<k>)
 * @invariant crank revolute, at most one record per crank; chen_flynn needs the four constants, fmep_table >= 2 points with strictly increasing rpm
 *            and FMEP >= 0; every model has a source; oilTempFactor > 0; component is never approximated
 * @failure unknown / prismatic crank, unknown or foreign cylinder id, a second record on the crank, missing constants / table / source,
 *          model component (FPR_LOSS_MODEL_UNSUPPORTED), taken id -> no-op
 */
export const setEngineLosses = defineCommand({
  name: 'set_engine_losses',
  description:
    'Mechanical losses of an engine (friction, FR-FPR-71): a torque on the crank opposite to its rotation, smoothed near zero speed, whose cycle ' +
    "average is FMEP·V_d/(4π) (four-stroke; 2π two-stroke) at the previous cycle's mean rpm, so simulate_motion reports BRAKE torque = indicated " +
    '- friction, BMEP = IMEP - FMEP and mechanical efficiency (data.engineReport.losses). Models: "chen_flynn" (A + B·p_max + C·n + D·n², give the four ' +
    'constants; 13 % mean error) or "fmep_table" (FMEP against rpm). Both need a `source`; no default constants exist because none were measured for ' +
    'your engine. "component" is refused (FPR_LOSS_MODEL_UNSUPPORTED): its equations are not checked against a primary source. `cylinders` lists the ' +
    'cylinder pressures whose displacement and peak pressure the friction reads; omit = every cylinder on the crank (also those added later). ' +
    '`oilTempFactor` multiplies FMEP (1 = hot oil, about 2.1 cold). Needed before add_cylinder_pressure with heat calibrate_brake. Returns the ' +
    'record id (loss-<step>.<k>) in affected[0].',
  params: z.object({
    crank: z.string().describe('Id of the revolute joint of the crankshaft (the joint the friction torque acts on).'),
    model: modelSchema.describe('Friction model and its constants; see the description.'),
    cylinders: z.array(z.string()).optional().describe('Cylinder pressure ids to read (add_cylinder_pressure). Omit = all on the crank.'),
    oilTempFactor: z.number().positive().optional().describe('Multiplier on FMEP: 1 = hot (default), about 2.1 cold.'),
    id: z.string().optional().describe('Optional explicit loss record id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'set_engine_losses');
    const dynamics = dynamicsOf(doc);
    const crank = dynamics.joints[params.crank];
    if (crank === undefined) return fail(`crank joint '${params.crank}' not found`);
    if (crank.kind !== 'revolute') return fail(`crank '${crank.id}' is ${crank.kind}; it must be a revolute joint`);
    const input = params.model;
    if (input.kind === 'component')
      return codedRejection(
        doc,
        'set_engine_losses',
        'FPR_LOSS_MODEL_UNSUPPORTED',
        'the component friction model (PNH / Sandoval-Heywood) is not available: its equations are not verified against a primary source, ' +
          'so it is refused rather than approximated',
        'Use model chen_flynn (give constants and a source) or fmep_table (measured FMEP against rpm).',
        [crank.id],
        ['model.kind'],
      );
    const existing = Object.values(dynamics.losses ?? {}).find((record) => record.crank === crank.id);
    if (existing !== undefined) return fail(`crank '${crank.id}' already has engine losses '${existing.id}' (delete_dynamics_item first)`);
    const cylinders = params.cylinders ?? [];
    for (const id of cylinders) {
      const cylinder = dynamics.cylinders?.[id];
      if (cylinder === undefined) return fail(`cylinder pressure '${id}' not found (add_cylinder_pressure first)`);
      if (cylinder.crank !== crank.id) return fail(`cylinder '${id}' is on crank '${cylinder.crank}', not '${crank.id}'`);
    }
    const source = input.source?.trim() ?? '';
    if (source === '') return fail(`${input.kind} needs a source (paper, datasheet or test the constants come from)`);
    let model: EngineLosses['model'];
    if (input.kind === 'chen_flynn') {
      const { aPa, bRatio, cPaPerRpm, dPaPerRpm2 } = input;
      if (aPa === undefined || bRatio === undefined || cPaPerRpm === undefined || dPaPerRpm2 === undefined)
        return fail('chen_flynn needs aPa, bRatio, cPaPerRpm and dPaPerRpm2');
      if (![aPa, bRatio, cPaPerRpm, dPaPerRpm2].every(Number.isFinite)) return fail('chen_flynn constants must be finite');
      model = { kind: 'chen_flynn', aPa, bRatio, cPaPerRpm, dPaPerRpm2, source };
    } else {
      const points = input.points;
      if (points === undefined || points.length < 2) return fail('fmep_table needs points [[rpm, FMEP Pa], ...] (at least 2)');
      if (points.some(([rpm, fmep], i) => !(fmep >= 0) || !Number.isFinite(rpm) || (i > 0 && rpm <= (points[i - 1]?.[0] ?? Infinity))))
        return fail('fmep_table needs strictly increasing finite rpm and FMEP >= 0');
      model = { kind: 'fmep_table', points, source };
    }
    const lossId = idOrNext(params.id, 'loss');
    if (dynamicsIdTaken(dynamics, lossId)) return fail(`id '${lossId}' is already used`);
    const record: EngineLosses = { id: lossId, crank: crank.id, cylinders, model, oilTempFactor: params.oilTempFactor ?? 1 };
    const { band, basis } = fmepBand(record);
    return changed(
      withDynamics(doc, { ...dynamics, losses: { ...(dynamics.losses ?? {}), [lossId]: record } }),
      `set_engine_losses: '${lossId}' — ${model.kind} on crank '${crank.id}' (${cylinders.length === 0 ? 'all its cylinders' : cylinders.join(', ')}), ` +
        `oil factor ${record.oilTempFactor}, accuracy ${bandText(band)} (${basis}). simulate_motion now reports brake torque, BMEP, FMEP and mechanical efficiency.`,
      [lossId],
    );
  },
});
