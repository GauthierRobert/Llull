/** Time-series reference data (PHY-23 DRV-M3): adding one to `dynamics.referenceSeries` and comparing the model with it. Engine curves stay in `engine/reference.ts`. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { z } from '@core/commands/schema';
import { changed, failer, report } from '@core/commands/noop';
import { dynamicsIdTaken } from '@core/model/dynamics';
import { MAX_TOTAL_POINTS, SERIES_QUANTITIES, type ReferenceSeries } from '@core/model/drives';
import { elementAt } from '@lib/elementAt';
import { idOrNext, idTaken } from '@lib/explicitId';
import { type ReviewItem, reviewItem, reviewResult, reviewSummary } from '@core/model/reviewEnvelope';
import { isDatasheetMotor } from '../../sim/actuators/machine';
import { compareSeries, type SeriesComparison } from '../../sim/seriesComparison';
import { refusalText, type RunData } from '../../sim/runData';
import { dynamicsOf, withDynamics } from '../bodies';
import { drivenTimestep, runSizing } from '../sizingRun';

const MAX_POINTS = 100_000;
const DEFAULT_BAND = 0.05;

export const seriesSchema = z.object({
  quantity: z
    .enum(SERIES_QUANTITIES)
    .describe(
      'What the values are: joint_position (rad or m), joint_velocity (rad/s or m/s), motor_current (A), motor_voltage (V), motor_torque (N*m at the driven joint), motor_speed (rad/s at the motor shaft), ledger_energy (J, one point at the end of the run).',
    ),
  target: z
    .string()
    .describe(
      'Joint id (joint_*), datasheet motor id (motor_*), or for ledger_energy the ledger entry: a kind (copper, electrical_input, transmission_loss, ...) or <element>/<kind>.',
    ),
  times: z
    .array(z.number())
    .min(1)
    .max(MAX_POINTS)
    .describe('Sample times, s, from the start of the run, strictly increasing (ledger_energy: the one end time).'),
  values: z.array(z.number()).min(1).max(MAX_POINTS).describe('One value per time, SI units of the quantity.'),
  uncertainty: z
    .number()
    .min(0)
    .optional()
    .describe('1 sigma of one reading, same unit as the values. Omit = unknown (the comparison then lists it as missing).'),
});

/** Why a series cannot be stored for this document, or null. */
function seriesProblem(doc: CadDocument, series: z.infer<typeof seriesSchema>): string | null {
  const dynamics = dynamicsOf(doc);
  if (series.times.length !== series.values.length) return 'times and values must have the same length';
  if (![...series.times, ...series.values].every(Number.isFinite)) return 'times and values must be finite';
  if (series.times.some((time, k) => time < 0 || (k > 0 && time <= (series.times[k - 1] ?? Number.NaN))))
    return 'times must be >= 0 and strictly increasing';
  if (series.quantity === 'ledger_energy' && series.times.length !== 1)
    return 'a ledger_energy series has exactly one point (the end of the run)';
  if (series.quantity.startsWith('joint_') && dynamics.joints[series.target] === undefined) return `no joint '${series.target}'`;
  const motor = dynamics.motors[series.target];
  if (series.quantity.startsWith('motor_') && (motor === undefined || !isDatasheetMotor(motor)))
    return `no datasheet motor '${series.target}': drive series exist only for add_motor kinds "dc", "pmsm", "stepper" and "induction"`;
  return null;
}

/** add_reference_data with `series`: one record in `dynamics.referenceSeries`. */
export function addSeriesReference(
  doc: CadDocument,
  params: {
    series: z.infer<typeof seriesSchema>;
    source?: string | undefined;
    grade?: 'A' | 'B' | 'C' | undefined;
    bandRel?: number | undefined;
    id?: string | undefined;
  },
): CommandResult {
  const fail = failer(doc, 'add_reference_data');
  const source = (params.source ?? '').trim();
  if (source === '') return fail('a reference needs a source (document, figure or test it comes from)');
  const problem = seriesProblem(doc, params.series);
  if (problem !== null) return fail(problem);
  const dynamics = dynamicsOf(doc);
  const held = Object.values(dynamics.referenceSeries ?? {}).reduce((sum, entry) => sum + entry.times.length, 0);
  if (held + params.series.times.length > MAX_TOTAL_POINTS)
    return fail(
      `the document would hold ${held + params.series.times.length} reference points (budget ${MAX_TOTAL_POINTS}): delete a series first`,
    );
  const id = params.id ?? idOrNext(undefined, 'ref');
  if (dynamicsIdTaken(dynamics, id) || idTaken(doc.prototype?.references ?? {}, id)) return fail(`id '${id}' is already used`);
  const record: ReferenceSeries = {
    id,
    quantity: params.series.quantity,
    target: params.series.target,
    times: [...params.series.times],
    values: [...params.series.values],
    source: { name: source, grade: params.grade ?? 'C' },
    ...(params.series.uncertainty === undefined ? {} : { uncertainty: params.series.uncertainty }),
    ...(params.bandRel === undefined ? {} : { bandRel: params.bandRel }),
  };
  const next = { ...dynamics, referenceSeries: { ...dynamics.referenceSeries, [id]: record } };
  return changed(
    withDynamics(doc, next),
    `add_reference_data: '${id}' — ${record.quantity} of ${record.target}, ${record.times.length} point(s) over ${record.times[0]}..${record.times[record.times.length - 1]} s, grade ${record.source.grade}, ` +
      `${record.uncertainty === undefined ? 'uncertainty unknown' : `reading uncertainty ${record.uncertainty}`}; source: ${source}.`,
    [id],
  );
}

const itemOf = (comparison: SeriesComparison, reference: ReferenceSeries): ReviewItem =>
  reviewItem(
    'dynamics',
    comparison.status === 'pass' ? 'DRV_REFERENCE_MATCH' : 'DRV_REFERENCE_MISMATCH',
    comparison.status,
    [reference.id, reference.target],
    comparison.status === 'pass'
      ? 'None.'
      : 'The model misses the measurement by more than the band: check the inputs the quantity depends on (fit_drive_parameters), or the reference.',
    {
      values: {
        rmsError: comparison.rmsError,
        peakError: comparison.peakError,
        relativeRms: comparison.relativeRms,
        points: comparison.points,
      },
      threshold: {
        value: comparison.band,
        unit: 'RMS error / largest reference value',
        source: `reference band of '${reference.id}'${reference.bandRel === undefined ? ' (named default 5 %)' : ''}`,
        grade: reference.source.grade,
        defaulted: reference.bandRel === undefined,
      },
      note: `${reference.quantity} of ${reference.target}: RMS ${comparison.rmsError.toPrecision(4)}, peak ${comparison.peakError.toPrecision(4)} against scale ${comparison.scale.toPrecision(4)}${
        comparison.uncertainty === null
          ? '; reading uncertainty unknown (validation uncertainty incomplete)'
          : `; peak error ${comparison.peakErrorOverUncertainty?.toPrecision(3) ?? 'n/a'} reading sigmas`
      }`,
      ...(comparison.status === 'pass' ? {} : { unverified: true }),
    },
  );

/** One review item per reference series against a run that covers them; a series the run cannot answer is a not_run item with the reason. */
export function referenceItems(references: readonly ReferenceSeries[], run: RunData): ReviewItem[] {
  return references.map((reference): ReviewItem => {
    const comparison = compareSeries(reference, run);
    return 'refusal' in comparison
      ? reviewItem(
          'dynamics',
          'DRV_REFERENCE_MISMATCH',
          'not_run',
          [reference.id, reference.target],
          'Make the reference and the model cover the same joint / motor and time span.',
          { unverified: true, note: comparison.refusal },
        )
      : itemOf(comparison, reference);
  });
}

/** Simulates once over the longest reference and compares every series with it: items, or the reason the simulation did not run. */
export function compareSeriesRun(
  doc: CadDocument,
  references: readonly ReferenceSeries[],
  ctx: ExecutionContext | undefined,
): { readonly items: ReviewItem[]; readonly run: RunData } | { readonly error: string } {
  const span = references.reduce((largest, reference) => Math.max(largest, elementAt(reference.times, reference.times.length - 1)), 0);
  if (!(span > 0)) return { error: 'the references end at t = 0: nothing to simulate' };
  const timestep = drivenTimestep(Object.values(dynamicsOf(doc).drives ?? {}));
  const run = runSizing(doc, { duration: Math.min(600, span), ...(timestep === undefined ? {} : { timestep }) }, ctx);
  if (run.data === null) return { error: `the simulation did not run: ${refusalText(run.result.summary)}` };
  return { items: referenceItems(references, run.data), run: run.data };
}

/** compare_to_reference on stored time series (`reference` = a series id or 'all_series'): one simulation, one review item per series. */
export function compareSeriesReferences(doc: CadDocument, reference: string, ctx: ExecutionContext | undefined): CommandResult {
  const NAME = 'compare_to_reference';
  const fail = failer(doc, NAME);
  const stored = Object.values(dynamicsOf(doc).referenceSeries ?? {});
  const selected = reference === 'all_series' ? stored : stored.filter((entry) => entry.id === reference);
  if (selected.length === 0) return fail('the document has no time-series reference data (add_reference_data with `series` first)');
  if (ctx?.physics === null || ctx?.physics === undefined)
    return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
  const compared = compareSeriesRun(doc, selected, ctx);
  if ('error' in compared) return fail(compared.error);
  const result = reviewResult(
    'dynamics',
    compared.items,
    {
      method:
        'simulate_motion over the longest reference; the simulated series interpolated at the reference times; RMS error against the largest reference value',
      engine: ctx.physics.name,
      tolerances: { bandRel: DEFAULT_BAND },
      params: { reference },
    },
    { references: selected, dynamics: doc.dynamics ?? null },
  );
  return report(
    doc,
    reviewSummary(NAME, result, 'Next: fix the inputs of the mismatching quantities (fit_drive_parameters), then re-run.'),
    result,
  );
}
