/**
 * Parameter schemas of `add_pump` and the builder of its envelope: a shipped ISO 2858 / ASME B73.1 row or the user's own dimensions, the baseplate and
 * driver boxes, and the two nozzle records (suction, discharge) placed from the envelope. Every refusal is a coded issue with a param path.
 */

import { z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { npsToDn, parseNps } from '../../catalog/nominal';
import { b731PumpRow, isoPumpRow, PUMP_TABLE_SOURCE } from '../data/pumpEnvelopes';
import { nozzleProblem } from '../geometry/nozzleChecks';
import { parseRating } from '../geometry/nozzleHardware';
import { pumpLayout } from '../geometry/pumpLayout';
import type { NozzleRecord, PumpBox, PumpEnvelope, PumpTemplate } from '../plantData';
import { isNozzleIssue, nozzleRecord } from './nozzleParams';
import type { VesselIssue } from './vesselParams';

const boxSchema = z.object({
  length: z.number().positive().describe('Length along the shaft, document units.'),
  width: z.number().positive().describe('Width across the shaft, document units.'),
  height: z.number().positive().describe('Height, document units.'),
});

export const pumpShape = {
  standard: z
    .enum(['iso_2858', 'asme_b73_1', 'custom'])
    .describe(
      'iso_2858: end-suction pump of ISO 2858 / EN 733 (size "65-40-250"). asme_b73_1: ASME B73.1 chemical pump (designation "AA" or size "1.5x1-6"). custom: your own envelope.',
    ),
  size: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Size of a shipped table row: ISO "DNsuction-DNdischarge-impeller" (e.g. "65-40-250") or B73.1 designation (e.g. "AA"). Give size OR envelope.',
    ),
  envelope: z
    .object({
      a: z
        .number()
        .positive()
        .describe('Suction flange face to the discharge nozzle centre along the shaft (ISO 2858 dimension a), document units.'),
      f: z
        .number()
        .positive()
        .describe('Discharge nozzle centre to the free end of the bearing frame along the shaft (ISO 2858 dimension f), document units.'),
      h1: z.number().positive().describe('Shaft centre height above the foot plane (the baseplate top), document units.'),
      h2: z.number().positive().describe('Discharge flange face height above the shaft centre, document units.'),
      suctionDn: z.number().int().positive().describe('Suction nozzle DN.'),
      dischargeDn: z.number().int().positive().describe('Discharge nozzle DN.'),
      source: z.string().optional().describe('Where the dimensions come from (vendor datasheet, drawing number). Default "user input".'),
    })
    .optional()
    .describe('Explicit envelope dimensions from a vendor datasheet, for a size outside the shipped tables. Give size OR envelope.'),
  api610Type: z
    .string()
    .regex(/^(OH[1-6]|BB[1-5]|VS[1-7])$/)
    .optional()
    .describe('API 610 pump type (OH1..OH6, BB1..BB5, VS1..VS7), stored for the data sheet; not a geometry input.'),
  rating: z
    .string()
    .optional()
    .describe('Flange rating of both nozzles: CL150, PN16 ... Default PN16 (iso_2858) or CL150 (asme_b73_1); required for custom.'),
  driver: boxSchema
    .extend({
      couplingGap: z
        .number()
        .min(0)
        .optional()
        .describe('Gap between the bearing frame and the driver, document units. Default 100 mm (reported in defaulted).'),
    })
    .optional()
    .describe('Driver (motor) envelope box after the bearing frame. Vendor data: omit it and no driver is drawn (reported in defaulted).'),
  baseplate: boxSchema
    .optional()
    .describe(
      'Baseplate box, centred under the pump and driver. Default: the machine span + 100 mm each side, 150 mm high (reported in defaulted).',
    ),
  weightKg: z
    .number()
    .positive()
    .optional()
    .describe('Vendor weight of the pump set, kg. The standards give none: without it the weight is 0 and check_equipment warns.'),
};

const pumpInput = z.object(pumpShape);
export type PumpInput = z.infer<typeof pumpInput>;

const issue = (code: string, message: string, path: string): VesselIssue => ({ code, message, path });
const dnOfInches = (text: string): number | null => {
  const size = parseNps(Number(text));
  return size === null ? null : (npsToDn(size)?.value ?? null);
};

interface ResolvedEnvelope {
  readonly envelope: Omit<PumpEnvelope, 'rating'>;
  readonly size?: string;
  readonly defaulted: string[];
}

/** Envelope in document units from a table row or the user's dimensions. */
function resolveEnvelope(input: PumpInput, doc: Pick<CadDocument, 'units'>): ResolvedEnvelope | VesselIssue {
  const mm = (value: number): number => fromMm(doc, value);
  const { envelope, size, standard } = input;
  if (size !== undefined && envelope !== undefined) return issue('EQP_PARAM_INVALID', 'give size OR envelope, not both', 'envelope');
  if (envelope !== undefined)
    return {
      envelope: {
        a: envelope.a,
        f: envelope.f,
        h1: envelope.h1,
        h2: envelope.h2,
        suctionDn: envelope.suctionDn,
        dischargeDn: envelope.dischargeDn,
        grade: 'A',
        source: envelope.source ?? 'user input',
      },
      defaulted: envelope.source === undefined ? ['envelope.source'] : [],
    };
  const missing = (reason: string): VesselIssue => issue('EQP_PUMP_SIZE_UNKNOWN', reason, 'size');
  if (size === undefined) return issue('EQP_PUMP_SIZE_UNKNOWN', 'give size (a shipped table row) or envelope (vendor dimensions)', 'size');
  if (standard === 'iso_2858') {
    const row = isoPumpRow(size);
    if (row === undefined)
      return missing(
        `size '${size}' is not in the shipped ISO 2858 table; give envelope { a, f, h1, h2, suctionDn, dischargeDn } from the vendor datasheet`,
      );
    if (row.aMm === null || row.fMm === null)
      return missing(
        `the shipped ISO 2858 row ${row.size} is incomplete (a and f are not legible in the sources); give envelope from the vendor datasheet`,
      );
    const [suction, discharge] = row.size.split('-').map(Number) as [number, number];
    return {
      envelope: {
        a: mm(row.aMm),
        f: mm(row.fMm),
        h1: mm(row.h1Mm),
        h2: mm(row.h2Mm),
        suctionDn: suction,
        dischargeDn: discharge,
        grade: row.grade,
        source: `ISO 2858 row ${row.size}: ${row.sources.join('; ')} (${PUMP_TABLE_SOURCE})`,
      },
      size: row.size,
      defaulted: [],
    };
  }
  if (standard === 'asme_b73_1') {
    const row = b731PumpRow(size);
    if (row === undefined) return missing(`size '${size}' is not in the shipped ASME B73.1 table; give envelope from the vendor datasheet`);
    const [suctionText, rest] = row.size.split('x') as [string, string];
    const suctionDn = dnOfInches(suctionText);
    const dischargeDn = dnOfInches(rest.split('-')[0] as string);
    if (suctionDn === null || dischargeDn === null) return missing(`the nozzle sizes of B73.1 row ${row.designation} have no DN pairing`);
    return {
      envelope: {
        a: mm(row.cpMm) / 2,
        f: mm(row.cpMm) / 2,
        h1: mm(row.dMm),
        h2: mm(row.xMm),
        suctionDn,
        dischargeDn,
        grade: row.grade,
        source: `ASME B73.1 row ${row.designation} (${row.size}): ${row.sources.join('; ')} (${PUMP_TABLE_SOURCE})`,
      },
      size: row.designation,
      defaulted: ['envelope.a/f split (the B73.1 row gives only the overall length CP: the discharge centre is placed at CP / 2)'],
    };
  }
  return issue('EQP_PARAM_INVALID', 'a custom pump needs envelope, not size', 'envelope');
}

/** Rating default of the standard (reported in defaulted), or the issue for a custom pump without one. */
function ratingOf(input: PumpInput, defaulted: string[]): string | VesselIssue {
  if (input.rating !== undefined) return input.rating;
  if (input.standard === 'custom') return issue('EQP_PARAM_INVALID', 'a custom pump needs rating (CL150, PN16 ...)', 'rating');
  defaulted.push('rating');
  return input.standard === 'iso_2858' ? 'PN16' : 'CL150';
}

/**
 * Template and nozzle records of `input` (suction mark `SUC`, discharge mark `DIS`, free locations from the envelope), or the issue.
 * @failure no size and no envelope, size not in the table or row incomplete -> EQP_PUMP_SIZE_UNKNOWN; unknown rating / DN -> EQP_RATING_UNKNOWN; a neck shorter
 *   than its flange -> EQP_NOZZLE_PROJECTION_TOO_SHORT
 */
export function buildPumpTemplate(
  doc: CadDocument,
  input: PumpInput,
): { template: PumpTemplate; nozzles: NozzleRecord[]; defaulted: string[] } | VesselIssue {
  const resolved = resolveEnvelope(input, doc);
  if ('code' in resolved) return resolved;
  const defaulted = [...resolved.defaulted];
  const rating = ratingOf(input, defaulted);
  if (typeof rating !== 'string') return rating;
  const envelope: PumpEnvelope = { ...resolved.envelope, rating };
  const margin = fromMm(doc, 100);
  const gap = input.driver?.couplingGap ?? fromMm(doc, 100);
  if (input.driver === undefined) defaulted.push('driver');
  else if (input.driver.couplingGap === undefined) defaulted.push('driver.couplingGap');
  const machineLength = envelope.a + envelope.f + (input.driver === undefined ? 0 : gap + input.driver.length);
  const machineWidth = Math.max(envelope.h2, input.driver?.width ?? 0);
  const baseplate: PumpBox = input.baseplate ?? {
    length: machineLength + 2 * margin,
    width: machineWidth + 2 * margin,
    height: fromMm(doc, 150),
  };
  if (input.baseplate === undefined) defaulted.push('baseplate');
  const template: PumpTemplate = {
    kind: 'pump',
    standard: input.standard,
    ...(resolved.size === undefined ? {} : { size: resolved.size }),
    ...(input.api610Type === undefined ? {} : { api610Type: input.api610Type }),
    envelope,
    baseplate,
    ...(input.driver === undefined
      ? {}
      : { driver: { length: input.driver.length, width: input.driver.width, height: input.driver.height, gap } }),
    ...(input.weightKg === undefined ? {} : { weightKg: input.weightKg }),
    defaulted,
  };
  const layout = pumpLayout(template);
  const nozzles: NozzleRecord[] = [];
  for (const [mark, service, dn, port] of [
    ['SUC', 'suction', envelope.suctionDn, layout.suction],
    ['DIS', 'discharge', envelope.dischargeDn, layout.discharge],
  ] as const) {
    const record = nozzleRecord(
      doc,
      mark,
      {
        dn,
        rating,
        facing: 'RF',
        projection: port.projection,
        service,
        location: { on: 'free', position: port.position, direction: port.direction },
      },
      defaulted,
    );
    if (isNozzleIssue(record))
      return issue(
        record.code,
        `${service} nozzle: ${record.message}`,
        parseRating(rating) === null ? 'rating' : `envelope.${service === 'suction' ? 'suctionDn' : 'dischargeDn'}`,
      );
    const problem = nozzleProblem(template, record);
    if (problem !== null) return issue(problem.code, `${service} nozzle: ${problem.message}`, 'envelope');
    nozzles.push(record);
  }
  return { template, nozzles, defaulted };
}
