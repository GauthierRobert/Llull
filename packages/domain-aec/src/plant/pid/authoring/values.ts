/** Attribute params -> stored `PidValue`s. */

import { z } from '@core/commands/schema';
import type { PidValue } from '../model';

export const attributesParam = z
  .record(
    z.string().min(1),
    z.union([
      z.string(),
      z.object({ value: z.number().describe('Numeric value.'), unit: z.string().min(1).describe('Unit text, e.g. bar.') }),
    ]),
  )
  .optional()
  .describe(
    'Extra attributes by name (DEXPI attribute names, e.g. DesignPressure). A plain string is stored as text; { value, unit } as a quantity ' +
      '(e.g. { "value": 16, "unit": "bar" }). Names that are JavaScript object names (__proto__, constructor ...) are ignored.',
  );

type AttributeParam = Record<string, string | { value: number; unit: string }>;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

export function toValues(input: AttributeParam | undefined): Record<string, PidValue> {
  const out: Record<string, PidValue> = {};
  for (const [name, raw] of Object.entries(input ?? {})) {
    if (RESERVED.has(name)) continue;
    out[name] = typeof raw === 'string' ? { kind: 'text', value: raw } : { kind: 'quantity', value: raw.value, unit: raw.unit };
  }
  return out;
}
