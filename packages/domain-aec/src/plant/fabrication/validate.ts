/** Load-time validation of `plant.fabrication` (the plugin's `DocumentExtension.validate`, plant 05 ISO §6.2): a zod schema plus the cross-reference checks. */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { isRecord } from '@lib/isRecord';
import { PCF_COMPONENT_TYPES } from './model';

const vec3 = z.array(z.number()).length(3);
const textRecord = z.record(z.string(), z.string());
const unit = z.enum(['MM', 'INCH']);

const point = z.object({ xyz: vec3, boreMm: z.number(), endType: z.string().optional() });

const component = z.object({
  id: z.string().min(1),
  type: z.enum(PCF_COMPONENT_TYPES),
  ends: z.array(point).max(2),
  branch: point.optional(),
  centre: vec3.optional(),
  coords: vec3.optional(),
  skey: z.string().optional(),
  itemCode: z.string().optional(),
  description: z.string().optional(),
  weight: z.number().optional(),
  category: z.enum(['fabrication', 'erection', 'offshore']).optional(),
  weldKind: z.enum(['shop', 'site', 'field_fit']).optional(),
  derived: z.literal(true).optional(),
  unverified: z.literal(true).optional(),
  extra: textRecord.optional(),
});

const line = z.object({
  lineId: z.string(),
  header: textRecord,
  units: z.object({ bore: unit, coords: unit, boltDia: unit.optional(), boltLength: unit.optional() }),
  attributes: textRecord,
  components: z.array(component),
  materials: z.array(z.object({ itemCode: z.string(), fields: textRecord })),
  unknownRecords: z.array(z.object({ type: z.string(), line: z.number().int(), after: z.number().int(), text: z.array(z.string()) })),
});

const quantity = z.object({ value: z.number(), source: z.string() });
const rules = z.object({
  weldGapMm: quantity.optional(),
  fieldFitAllowanceMm: quantity.optional(),
  minCutPieceMm: quantity.optional(),
  maxSpool: z
    .object({
      lengthMm: z.number().optional(),
      widthMm: z.number().optional(),
      heightMm: z.number().optional(),
      weightKg: z.number().optional(),
      pieces: z.number().optional(),
      source: z.string(),
    })
    .optional(),
  weldPrefix: z.object({ fabrication: z.string().optional(), erection: z.string().optional() }).optional(),
  spoolPrefix: z.string().optional(),
});
const fieldWeld = z.object({ id: z.string().min(1), lineId: z.string(), xyz: vec3, type: z.enum(['site', 'field_fit']) });
const weld = z.object({
  id: z.string().min(1),
  lineId: z.string(),
  n: z.number().int().min(1),
  number: z.string().min(1),
  kind: z.enum(['shop', 'site', 'field_fit']),
  kindSet: z.boolean(),
  joint: z.object({ xyz: vec3, componentIds: z.array(z.string()), boreMm: z.number(), endType: z.string() }),
  status: z.enum(['active', 'orphaned']),
});

const fabrication = z.object({
  version: z.literal(1),
  pcfLines: z.record(z.string(), line),
  rules: rules.optional(),
  fieldWelds: z.record(z.string(), fieldWeld).optional(),
  welds: z.record(z.string(), weld).optional(),
  highestWeldNumber: z.record(z.string(), z.number().int().min(0)).optional(),
  spoolBreaks: z.record(z.string(), z.array(z.enum(['field_welds', 'flanged_joints', 'line_ends']))).optional(),
});

const ROOT = 'plant.fabrication';

/** A line's id equals its key and its component ids are unique; tolerant of a malformed shape (the schema reports that). */
function crossErrors(pcfLines: unknown): string[] {
  if (!isRecord(pcfLines)) return [];
  return Object.entries(pcfLines).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    const path = `${ROOT}.pcfLines.${key}`;
    const errors = value['lineId'] === key ? [] : [`${path}.lineId: must equal its key`];
    const seen = new Set<string>();
    const components: unknown[] = Array.isArray(value['components']) ? value['components'] : [];
    components.forEach((entry, index) => {
      const id = isRecord(entry) ? entry['id'] : undefined;
      if (typeof id !== 'string' || id === '') return;
      if (seen.has(id)) errors.push(`${path}.components[${index}].id: ${id} is used twice`);
      seen.add(id);
    });
    return errors;
  });
}

/** Weld records: the key equals the id and is `<lineId>#<n>`, a number is used once per line. */
function weldErrors(welds: unknown, fieldWelds: unknown): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (isRecord(welds))
    for (const [key, value] of Object.entries(welds)) {
      if (!isRecord(value)) continue;
      const path = `${ROOT}.welds.${key}`;
      if (value['id'] !== key) errors.push(`${path}.id: must equal its key`);
      if (key !== `${String(value['lineId'])}#${String(value['n'])}`) errors.push(`${path}: key must be <lineId>#<n>`);
      const number = `${String(value['lineId'])}/${String(value['number'])}`;
      if (seen.has(number)) errors.push(`${path}.number: ${String(value['number'])} is used twice on the line`);
      seen.add(number);
    }
  if (isRecord(fieldWelds))
    for (const [key, value] of Object.entries(fieldWelds))
      if (isRecord(value) && value['id'] !== key) errors.push(`${ROOT}.fieldWelds.${key}.id: must equal its key`);
  return errors;
}

/** Problems of a raw `plant.fabrication` (empty = valid or absent). */
export function fabricationErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  const shape = sliceSchemaErrors(fabrication, raw, ROOT);
  return isRecord(raw) ? [...shape, ...crossErrors(raw['pcfLines']), ...weldErrors(raw['welds'], raw['fieldWelds'])] : shape;
}
