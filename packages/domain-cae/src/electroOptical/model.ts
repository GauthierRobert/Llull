/** Access to and validation of the electro-optical slice of the document (`CadDocument.electroOptical`, plugin `physics-electro-optical`). */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { convertValue, isUnitFailure } from '@lib/quantity';
import type { CadDocument } from '@core/model/types';
import {
  COATING_LOCATIONS,
  DISPOSITIONS,
  ELECTRICAL_EFFECTS,
  LIGHTNING_ZONES,
  type BondDisposition,
  type ElectroOpticalModel,
  type LightningZoneLabel,
} from './types';

const EMPTY: ElectroOpticalModel = { coatings: {}, bondPaths: {}, dispositions: {} };

export const electroOpticalOf = (doc: CadDocument): ElectroOpticalModel => doc.electroOptical ?? EMPTY;

export const withElectroOptical = (doc: CadDocument, patch: Partial<ElectroOpticalModel>): CadDocument => ({
  ...doc,
  electroOptical: { ...electroOpticalOf(doc), ...patch },
});

export const dispositionOf = (doc: CadDocument, id: string): BondDisposition | undefined => {
  const { dispositions } = electroOpticalOf(doc);
  return Object.hasOwn(dispositions, id) ? dispositions[id] : undefined;
};

/** The zone labels (none in a file written before set_lightning_zone). */
export const zonesOf = (doc: CadDocument): Readonly<Record<string, LightningZoneLabel>> => electroOpticalOf(doc).zones ?? {};

/** Length bounds of the slice's strings: the command params and the load schema share them, so whatever a command stores loads again. */
export const EOP_LIMITS = { citation: 500, locator: 2000, name: 256, key: 256, unit: 64, justification: 4000, elements: 256 } as const;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const keySchema = z
  .string()
  .min(1)
  .max(EOP_LIMITS.key)
  .regex(/^\S+$/)
  .refine((key) => !RESERVED.has(key), 'reserved key');
/** A reference to a document entity or material: its own key rules (a material name may hold spaces), bounded and never a prototype name. */
const refSchema = z
  .string()
  .min(1)
  .max(EOP_LIMITS.key)
  .refine((key) => !RESERVED.has(key), 'reserved key');

const textSchema = z.string().max(EOP_LIMITS.locator);
const sourceSchema = z.strictObject({ citation: z.string().min(1).max(EOP_LIMITS.citation), locator: textSchema.optional() });
const quantitySchema = z.strictObject({ value: z.number().finite(), unit: z.string().min(1).max(EOP_LIMITS.unit) });

/** The `source` parameter of every EOP command that stores one (bounded as on load; a blank citation is refused by the command with its own code). */
export const sourceParams = (citation: string): z.ZodObject<{ citation: z.ZodString; locator: z.ZodOptional<z.ZodString> }> =>
  z.object({
    citation: z.string().max(EOP_LIMITS.citation).describe(`${citation} (at most ${EOP_LIMITS.citation} characters).`),
    locator: z.string().max(EOP_LIMITS.locator).optional().describe(`Page / table / sheet (at most ${EOP_LIMITS.locator} characters).`),
  });

/** A stored `{ value, unit }` parameter (unit bounded as on load). */
export const quantityParams = (what: string, example: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z
    .object({
      value: z.number().describe(`${what}: positive, finite.`),
      unit: z.string().max(EOP_LIMITS.unit).describe(`Unit, e.g. '${example}'.`),
    })
    .describe(`${what} as { value, unit }.`);

const elementSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('joint'),
    resistance: quantitySchema,
    source: sourceSchema,
    interfaces: z.tuple([refSchema, refSchema]).optional(),
  }),
  z.strictObject({ kind: z.literal('strap'), material: refSchema, length: quantitySchema, crossSection: quantitySchema }),
]);

const limitSchema = z.strictObject({
  value: z.number().finite().positive(),
  unit: z.string().min(1).max(EOP_LIMITS.unit),
  ruleId: keySchema,
  source: sourceSchema,
  unverified: z.boolean(),
});

const pathSchema = z.strictObject({
  id: keySchema,
  name: z.string().min(1).max(EOP_LIMITS.name),
  from: refSchema,
  to: refSchema,
  elements: z.array(elementSchema).min(1).max(EOP_LIMITS.elements),
  limit: limitSchema.optional(),
  temperature: quantitySchema.optional(),
});

const coatingSchema = z.strictObject({
  id: keySchema,
  entityId: refSchema,
  coating: refSchema,
  location: z.enum(COATING_LOCATIONS),
  electrical: z.enum(ELECTRICAL_EFFECTS),
  source: sourceSchema.optional(),
});

const zoneSchema = z.strictObject({ id: keySchema, entityId: refSchema, zone: z.enum(LIGHTNING_ZONES), source: sourceSchema });

const dispositionSchema = z.strictObject({
  pathId: keySchema,
  decision: z.enum(DISPOSITIONS),
  justification: z.string().min(1).max(EOP_LIMITS.justification),
  inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
  signer: z.string().min(1).max(256),
  signatureId: z.string().min(1).max(256),
  signature: z.unknown(),
  documentUid: z.string().min(1).max(256),
});

/** A quantity whose unit does not parse or has the wrong dimension (`as` = a reference unit of that dimension). */
const badUnit = (quantity: { unit: string }, reference: string): boolean => isUnitFailure(convertValue(1, quantity.unit, reference));

const sliceSchema = z
  .strictObject({
    coatings: z.record(keySchema, coatingSchema),
    bondPaths: z.record(keySchema, pathSchema),
    dispositions: z.record(keySchema, dispositionSchema),
    zones: z.record(keySchema, zoneSchema).optional(),
  })
  .superRefine((slice, ctx) => {
    const bad = (path: (string | number)[], message: string): void => ctx.addIssue({ code: 'custom', path, message });
    for (const [key, coating] of Object.entries(slice.coatings))
      if (coating.id !== key) bad(['coatings', key, 'id'], `must equal its key '${key}'`);
    for (const [key, path] of Object.entries(slice.bondPaths)) {
      if (path.id !== key) bad(['bondPaths', key, 'id'], `must equal its key '${key}'`);
      path.elements.forEach((element, index) => {
        const at = ['bondPaths', key, 'elements', index];
        if (element.kind === 'joint') {
          if (element.resistance.value <= 0 || badUnit(element.resistance, 'ohm'))
            bad([...at, 'resistance'], 'must be a positive resistance');
        } else {
          if (element.length.value <= 0 || badUnit(element.length, 'm')) bad([...at, 'length'], 'must be a positive length');
          if (element.crossSection.value <= 0 || badUnit(element.crossSection, 'm^2'))
            bad([...at, 'crossSection'], 'must be a positive area');
        }
      });
      if (path.limit !== undefined && badUnit(path.limit, 'ohm')) bad(['bondPaths', key, 'limit', 'unit'], 'must be a resistance unit');
      if (path.temperature !== undefined && badUnit(path.temperature, 'K'))
        bad(['bondPaths', key, 'temperature', 'unit'], 'must be a temperature unit');
    }
    const zoned = new Set<string>();
    for (const [key, label] of Object.entries(slice.zones ?? {})) {
      if (label.id !== key) bad(['zones', key, 'id'], `must equal its key '${key}'`);
      if (zoned.has(label.entityId)) bad(['zones', key, 'entityId'], `'${label.entityId}' has more than one zone label`);
      zoned.add(label.entityId);
    }
    for (const [key, disposition] of Object.entries(slice.dispositions)) {
      if (disposition.pathId !== key) bad(['dispositions', key, 'pathId'], `must equal its key '${key}'`);
    }
  });

/** Value errors of the raw `electroOptical` slice (persistence rejects the file when non-empty). */
export const electroOpticalErrors = (raw: Record<string, unknown>): string[] =>
  raw['electroOptical'] === undefined ? [] : sliceSchemaErrors(sliceSchema, raw['electroOptical'], 'electroOptical');
