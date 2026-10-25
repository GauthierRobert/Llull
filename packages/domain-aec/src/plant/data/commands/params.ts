/** Parameter schemas and result plumbing shared by the plant data commands. */

import { z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { refuseDat } from '../codes';

export const scalarSchema = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .describe('A text, a number, a boolean or null (null clears the value).');

export const valueSchema = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.object({
      value: z.number().describe('The number, expressed in `unit`.'),
      unit: z.string().describe('Unit of `value`, e.g. "bara", "kPag", "degF", "t", "m3/s"; converted into the unit of the property.'),
    }),
  ])
  .describe(
    'A property value: text, number (physical types in the unit of the property definition), boolean, null to clear, or { value, unit } to send another unit of the same family (a gauge pressure never converts to absolute).',
  );

export const provenanceSchema = z
  .object({
    source: z.enum(['pid', 'datasheet', 'calculation', 'agent', 'import', 'default']).describe('Where the value comes from.'),
    ref: z.string().optional().describe('Document, sheet or cell the value was read from.'),
    unverified: z
      .boolean()
      .optional()
      .describe('True while nobody has checked the value against its source: reports and check_plant_data flag it.'),
  })
  .describe('Provenance of one value (AF-32: an unverified value is never hidden).');

/** A refusal in the shape the commands return it. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly ids?: readonly string[];
  readonly paths?: readonly string[];
  readonly detail?: Readonly<Record<string, unknown>>;
}

export const refuse = (doc: CadDocument, command: string, refusal: Refusal): CommandResult =>
  refuseDat(doc, command, refusal.code, refusal.message, refusal.ids ?? [], refusal.paths ?? [], refusal.detail);

/** `{ ok: false }` carries a `Refusal`. */
export type Outcome<T> = ({ readonly ok: true } & T) | ({ readonly ok: false } & Refusal);

export const failure = (
  code: string,
  message: string,
  paths: readonly string[] = [],
  ids: readonly string[] = [],
  detail?: Readonly<Record<string, unknown>>,
): Outcome<never> => ({ ok: false, code, message, paths, ids, ...(detail === undefined ? {} : { detail }) });
