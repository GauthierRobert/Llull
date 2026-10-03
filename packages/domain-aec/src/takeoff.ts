/**
 * Quantity takeoff, schedules and cost estimate commands (read-only except set_cost_rates).
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { getBuilding } from './model';
import { noop } from '@core/commands/noop';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { priceTakeoff } from './costing';
import { computeTakeoff } from './takeoffCompute';
import { buildSchedule, toCsv, type ScheduleKind } from './scheduleBuild';

const UNIT_LABEL = { m: 'm', m2: 'm²', m3: 'm³', ea: 'ea', kg: 'kg' } as const;

/**
 * @command quantity_takeoff
 * @pure read-only
 * @affects none; data = { lines: TakeoffLine[], csv }
 */
export const quantityTakeoff = defineCommand({
  name: 'quantity_takeoff',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only bill of quantities of the building model, metric: wall length / net face area / volume, ' +
    'slab area / volume, column and beam volume, stair volume, door and window counts and areas, room ' +
    'floor area — grouped by category and material. Each line has a key like "wall.concrete.m3" used by ' +
    'estimate_cost. data.csv is spreadsheet-ready.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const lines = computeTakeoff(doc);
    if (lines.length === 0) {
      return {
        document: doc,
        summary: 'Quantity takeoff: the building model is empty (add walls, slabs, columns…).',
        affected: [],
        data: { lines, csv: toCsv(['Key', 'Description', 'Quantity', 'Unit'], []) },
      };
    }
    const csv = toCsv(
      ['Key', 'Description', 'Quantity', 'Unit'],
      lines.map((line) => [line.key, line.description, line.quantity, UNIT_LABEL[line.unit]]),
    );
    const highlights = lines
      .filter((line) => line.unit === 'm3' || line.unit === 'ea' || line.unit === 'kg')
      .map(
        (line) => `${line.description.split(' — ')[0]}: ${line.quantity} ${UNIT_LABEL[line.unit]}`,
      );
    return {
      document: doc,
      summary: `Quantity takeoff (${lines.length} lines). ${highlights.join('; ')}.`,
      affected: [],
      data: { lines, csv },
    };
  },
});

const SCHEDULE_KINDS = [
  'wall',
  'door',
  'window',
  'room',
  'slab',
  'column',
  'beam',
  'stair',
  'member',
  'footing',
  'panel',
  'equipment',
  'pipe',
  'tray',
  'plate',
  'connection',
] as const satisfies ReadonlyArray<ScheduleKind>;

/**
 * @command building_schedule
 * @pure read-only
 * @affects none; data = { kind, columns, rows, csv }
 * @failure unknown kind -> no data
 */
export const buildingSchedule = defineCommand({
  name: 'building_schedule',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only schedule table (like Revit schedules) for one element category: wall, door, window, room, ' +
    'slab, column, beam, stair, member (steel cut list), footing, panel, equipment or pipe — one row per element with mark, level, dimensions, material and ' +
    'quantities. data.csv is spreadsheet-ready.',
  params: z.object({ kind: z.enum(SCHEDULE_KINDS).describe('Which schedule to produce.') }),
  run: (doc, { kind }): CommandResult => {
    const schedule = buildSchedule(doc, kind);
    return {
      document: doc,
      summary: `${kind[0]?.toUpperCase()}${kind.slice(1)} schedule: ${schedule.rows.length} row(s).`,
      affected: [],
      data: { ...schedule, csv: toCsv(schedule.columns, schedule.rows) },
    };
  },
});

function validRates(rates: unknown): rates is Record<string, number> {
  return (
    typeof rates === 'object' &&
    rates !== null &&
    !Array.isArray(rates) &&
    Object.values(rates).every((rate) => isFiniteNumber(rate) && rate >= 0)
  );
}

/**
 * @command set_cost_rates
 * @pure
 * @failure rates not a map of numbers >= 0 -> no-op
 */
export const setCostRates = defineCommand({
  name: 'set_cost_rates',
  description:
    'Store unit rates (price per unit) in the project for estimate_cost. Keys are takeoff keys ' +
    '"<category>.<material>.<unit>" (e.g. "wall.concrete.m3": 180, "door.timber.ea": 450) or wildcards ' +
    '"wall.*.m2", "slab-roof.*.m3" (slab groups: slab-floor, slab-roof, slab-foundation) or "*.concrete.m3". Price ONE unit per category to avoid double counting.',
  params: z.object({
    rates: z.looseObject({}).describe('Map of rate key → price per unit (>= 0).'),
    currency: z
      .string()
      .optional()
      .describe('ISO currency code, e.g. "EUR". Default kept / "EUR".'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace all stored rates instead of merging. Default false.'),
  }),
  run: (doc, { rates, currency, replace = false }): CommandResult => {
    if (!validRates(rates) || Object.keys(rates).length === 0) {
      return noop(
        doc,
        'set_cost_rates failed: rates must be a non-empty map of key → number >= 0.',
      );
    }
    const building = getBuilding(doc);
    const costRates = replace ? { ...rates } : { ...(building.costRates ?? {}), ...rates };
    const resolvedCurrency = currency?.trim() || building.currency || 'EUR';
    return {
      document: { ...doc, building: { ...building, costRates, currency: resolvedCurrency } },
      summary: `Stored ${Object.keys(costRates).length} cost rate(s) in ${resolvedCurrency}.`,
      affected: [],
    };
  },
});

/**
 * @command estimate_cost
 * @pure read-only
 * @affects none; data = { currency, lines: CostLine[], total, unpriced, csv }
 * @failure invalid rates -> no data
 */
export const estimateCost = defineCommand({
  name: 'estimate_cost',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only priced bill of quantities: multiplies each quantity_takeoff line by its unit rate ' +
    '(stored rates from set_cost_rates, overridden by the rates param) and totals the estimate. Lines ' +
    'without a rate are listed as unpriced.',
  params: z.object({
    rates: z
      .looseObject({})
      .optional()
      .describe('Optional extra / overriding rates, same keys as set_cost_rates.'),
    currency: z
      .string()
      .optional()
      .describe('Currency label. Default: the stored currency or EUR.'),
  }),
  run: (doc, { rates, currency }): CommandResult => {
    if (rates !== undefined && !validRates(rates)) {
      return noop(doc, 'estimate_cost failed: rates must be a map of key → number >= 0.');
    }
    const building = getBuilding(doc);
    const resolvedCurrency = currency?.trim() || building.currency || 'EUR';
    const priced = priceTakeoff(computeTakeoff(doc), {
      ...(building.costRates ?? {}),
      ...(rates ?? {}),
    });
    const csv = toCsv(
      [
        'Key',
        'Description',
        'Quantity',
        'Unit',
        `Rate (${resolvedCurrency})`,
        `Amount (${resolvedCurrency})`,
      ],
      [
        ...priced.lines.map((line) => [
          line.key,
          line.description,
          line.quantity,
          UNIT_LABEL[line.unit],
          line.rate ?? '',
          line.amount ?? '',
        ]),
        ['TOTAL', '', '', '', '', priced.total],
      ],
    );
    return {
      document: doc,
      summary:
        `Estimate: ${priced.total.toFixed(2)} ${resolvedCurrency} over ${priced.lines.length - priced.unpriced.length} priced line(s)` +
        (priced.unpriced.length > 0 ? `; unpriced: ${priced.unpriced.join(', ')}.` : '.'),
      affected: [],
      data: { currency: resolvedCurrency, ...priced, csv },
    };
  },
});
