/** Access to and validation of the electro-optical slice of the document (`CadDocument.electroOptical`, plugin `physics-electro-optical`). */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { convertValue, isUnitFailure } from '@lib/quantity';
import type { CadDocument } from '@core/model/types';
import { COATING_LOCATIONS, DISPOSITIONS, ELECTRICAL_EFFECTS, type BondDisposition, type ElectroOpticalModel } from './types';

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

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const keySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine((key) => !RESERVED.has(key), 'reserved key');
const textSchema = z.string().max(2000);
const sourceSchema = z.strictObject({ citation: z.string().min(1).max(500), locator: textSchema.optional() });
const quantitySchema = z.strictObject({ value: z.number().finite(), unit: z.string().min(1).max(64) });
const MAX_ELEMENTS = 256;

const elementSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('joint'),
    resistance: quantitySchema,
    source: sourceSchema,
    interfaces: z.tuple([keySchema, keySchema]).optional(),
  }),
  z.strictObject({ kind: z.literal('strap'), material: keySchema, length: quantitySchema, crossSection: quantitySchema }),
]);

const limitSchema = z.strictObject({
  value: z.number().finite().positive(),
  unit: z.string().min(1).max(64),
  ruleId: keySchema,
  source: sourceSchema,
  unverified: z.boolean(),
});

const pathSchema = z.strictObject({
  id: keySchema,
  name: z.string().min(1).max(256),
  from: keySchema,
  to: keySchema,
  elements: z.array(elementSchema).min(1).max(MAX_ELEMENTS),
  limit: limitSchema.optional(),
  temperature: quantitySchema.optional(),
});

const coatingSchema = z.strictObject({
  id: keySchema,
  entityId: keySchema,
  coating: keySchema,
  location: z.enum(COATING_LOCATIONS),
  electrical: z.enum(ELECTRICAL_EFFECTS),
  source: sourceSchema.optional(),
});

const dispositionSchema = z.strictObject({
  pathId: keySchema,
  decision: z.enum(DISPOSITIONS),
  justification: z.string().min(1).max(4000),
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
    for (const [key, disposition] of Object.entries(slice.dispositions)) {
      if (disposition.pathId !== key) bad(['dispositions', key, 'pathId'], `must equal its key '${key}'`);
    }
  });

/** Value errors of the raw `electroOptical` slice (persistence rejects the file when non-empty). */
export const electroOpticalErrors = (raw: Record<string, unknown>): string[] =>
  raw['electroOptical'] === undefined ? [] : sliceSchemaErrors(sliceSchema, raw['electroOptical'], 'electroOptical');
