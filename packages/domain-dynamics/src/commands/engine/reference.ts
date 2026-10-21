/** Reference data to validate an engine model against (add_reference_data, FR-FPR-77). */

import { createPrototypeModel, REFERENCE_QUANTITIES, type ReferenceData } from '@core/model/prototype';
import { REFERENCE_PRESET_NAMES, REFERENCE_PRESETS } from '../../sim/engine/referencePresets';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { idOrNext, idTaken } from '@lib/explicitId';
import { changed, failer } from '@core/commands/noop';

const pointSchema = z.object({
  rpm: z.number().positive().optional().describe('Crank speed of the point, rpm (omit for a quantity that does not depend on speed).'),
  value: z.number().describe('Measured / datasheet value in the unit of the quantity; for a window point the window centre.'),
  min: z.number().optional().describe('Lower bound of a window point (e.g. the static rpm window): the model passes when inside min..max.'),
  max: z.number().optional().describe('Upper bound of a window point.'),
  uncertainty: z
    .number()
    .min(0)
    .optional()
    .describe('Reading / measurement uncertainty of `value`, same unit (digitised graphs: the reading error). Omit = unknown.'),
});

/**
 * @affects adds 1 reference record to doc.prototype.references (affected: [referenceId]); created with the preset name as id when a preset is used
 * @invariant points non-empty with finite values; source non-empty; bandRel > 0; calibrationRpm only lists point speeds; one record per id
 * @failure no points / no source / band <= 0 / unknown preset / calibration speed that is not a point / taken id -> no-op
 */
export const addReferenceData = defineCommand({
  name: 'add_reference_data',
  description:
    'Store measured or datasheet data an engine model is validated against (FR-FPR-77); compare_to_reference runs the model at each point and ' +
    'reports S (simulated), D (reference), E = S - D, E/D, the validation uncertainty and pass / fail against the band. Give a `preset` for the ' +
    'shipped public curves: "rotax_912uls_full_throttle" (brake torque 2500-5800 rpm, digitised from the OM-912 graph, +-1 N·m), ' +
    '"rotax_912is_power_table" (brake power kW, 5 points), "o320a_full_throttle" and "o320b_full_throttle" (Lycoming brake power kW, 2200-2800 rpm), ' +
    '"rotax_912_static_rpm_window" (fixed-pitch static full-throttle rpm 5100-5800); any field you add overrides the preset. Or give your own: ' +
    '`quantity` (brake_torque_Nm, brake_power_kW, bmep_bar, static_rpm, propeller_rpm, bsfc_g_per_kWh), `points`, `source` (required), `grade`. ' +
    '`calibrationRpm` lists the points you calibrate the model on (default practice: the rated point only; presets name theirs): those get ' +
    'origin "calibrated", are shown as information and never count as pass evidence; every other point is a hold-out prediction. `bandRel` ' +
    'is the relative pass band, default 0.05 [GT-Power calibration practice]. Returns the reference id in affected[0].',
  params: z.object({
    preset: z.enum(REFERENCE_PRESET_NAMES).optional().describe('Shipped public data set; its id is the preset name unless `id` is given.'),
    quantity: z
      .enum(REFERENCE_QUANTITIES)
      .optional()
      .describe('What the points are: brake_torque_Nm, brake_power_kW, bmep_bar, static_rpm, propeller_rpm or bsfc_g_per_kWh.'),
    points: z.array(pointSchema).optional().describe('Reference points; at least one. Required without a preset.'),
    throttle: z
      .enum(['full', 'propeller_curve'])
      .optional()
      .describe('Operating condition: "full" throttle (default) or along the "propeller_curve".'),
    altitudeM: z
      .number()
      .optional()
      .describe('Altitude of the measurement, m (default 0). llull does not model altitude: a non-zero value is reported as a warning.'),
    note: z.string().optional().describe('Free note on the condition (fuel, ignition, propeller).'),
    source: z.string().optional().describe('REQUIRED without a preset: document, figure or test the data comes from.'),
    grade: z
      .enum(['A', 'B', 'C'])
      .optional()
      .describe('Source grade: A measured / verified, B manufacturer data or digitised graph, C reconstructed. Default C.'),
    digitised: z
      .boolean()
      .optional()
      .describe('The points were read off a graph (the uncertainty is then the reading error). Default false.'),
    calibrationRpm: z
      .array(z.number())
      .optional()
      .describe('Speeds (rpm) of the points the model is calibrated on; they must be point speeds.'),
    bandRel: z.number().positive().optional().describe('Relative band of a pass, > 0 (default 0.05).'),
    id: z.string().optional().describe('Optional explicit reference id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_reference_data');
    const preset = params.preset === undefined ? undefined : REFERENCE_PRESETS[params.preset];
    const quantity = params.quantity ?? preset?.quantity;
    const points = params.points ?? preset?.points;
    const source = (params.source ?? preset?.source ?? '').trim();
    if (quantity === undefined) return fail('give a quantity (or a preset)');
    if (points === undefined || points.length === 0) return fail('give at least one point (or a preset)');
    if (source === '') return fail('a reference needs a source (document, figure or test it comes from)');
    const bandRel = params.bandRel ?? preset?.bandRel ?? 0.05;
    if (!(bandRel > 0)) return fail('bandRel must be > 0');
    const calibrationRpm = params.calibrationRpm ?? preset?.calibrationRpm ?? [];
    const speeds = points.flatMap((point) => (point.rpm === undefined ? [] : [point.rpm]));
    const stray = calibrationRpm.filter((rpm) => !speeds.some((speed) => Math.abs(speed - rpm) < 1e-9));
    if (stray.length > 0) return fail(`calibrationRpm ${stray.join(', ')} is not the speed of any point (${speeds.join(', ')})`);
    if (points.some((point) => (point.min !== undefined) !== (point.max !== undefined) || (point.min ?? 0) > (point.max ?? 0)))
      return fail('a window point needs both min and max with min <= max');
    const referenceId = params.id ?? params.preset ?? idOrNext(undefined, 'ref');
    const prototype = doc.prototype ?? createPrototypeModel();
    const references = prototype.references ?? {};
    if (idTaken(references, referenceId)) return fail(`reference '${referenceId}' already exists`);
    const condition = {
      throttle: params.throttle ?? preset?.condition.throttle ?? 'full',
      altitudeM: params.altitudeM ?? preset?.condition.altitudeM ?? 0,
      ...((params.note ?? preset?.condition.note) !== undefined ? { note: params.note ?? preset?.condition.note ?? '' } : {}),
    } as const;
    const record: ReferenceData = {
      id: referenceId,
      quantity,
      condition,
      points: points.map((point) => ({
        value: point.value,
        ...(point.rpm !== undefined ? { rpm: point.rpm } : {}),
        ...(point.min !== undefined ? { min: point.min } : {}),
        ...(point.max !== undefined ? { max: point.max } : {}),
        ...(point.uncertainty !== undefined ? { uncertainty: point.uncertainty } : {}),
      })),
      source,
      grade: params.grade ?? preset?.grade ?? 'C',
      digitised: params.digitised ?? preset?.digitised ?? false,
      calibrationRpm: [...calibrationRpm],
      bandRel,
    };
    const warning =
      condition.altitudeM !== 0 ? ` Note: altitude ${condition.altitudeM} m is not modelled (sea-level ambient pressure).` : '';
    return changed(
      { ...doc, prototype: { ...prototype, references: { ...references, [referenceId]: record } } },
      `add_reference_data: '${referenceId}' — ${quantity}, ${points.length} point(s)${speeds.length > 0 ? ` (${Math.min(...speeds)}..${Math.max(...speeds)} rpm)` : ''}, ` +
        `grade ${record.grade}${record.digitised ? ', digitised' : ''}, band ±${bandRel * 100} %, ` +
        `${calibrationRpm.length > 0 ? `calibration at ${calibrationRpm.join(', ')} rpm (the others are hold-out)` : 'no calibration point (all hold-out)'}; source: ${source}.${warning}`,
      [referenceId],
    );
  },
});
