/** Access to and load validation of the space-environment slice (`CadDocument.spaceEnvironment`, plugin `physics-environment`). */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import type { CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { SHIPPED_PROFILE_IDS } from './profiles';
import { OUTGASSING_QUANTITIES, type SpaceEnvironment } from './types';

const EMPTY: SpaceEnvironment = {};

export const spaceEnvironmentOf = (doc: CadDocument): SpaceEnvironment => doc.spaceEnvironment ?? EMPTY;

/** Id rule shared by the commands and the slice schema (`__proto__`, `constructor`, `prototype` refused). */
export const PROFILE_ID_PATTERN = /^(?!(?:constructor|prototype)$)[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** Caps against a hostile file: limits per profile, text lengths. */
export const MAX_LIMITS = 8;
const MAX_TEXT = 500;

const finite = z.number().refine(Number.isFinite, 'must be finite');
const text = z.string().min(1).max(MAX_TEXT);

const quantityOf = (dimension: 'time' | 'temperature'): z.ZodType<{ value: number; unit: string }> =>
  z.strictObject({ value: finite, unit: z.string().max(40) }).superRefine((quantity, ctx) => {
    const probe = dimension === 'time' ? 's' : 'K';
    if (isUnitFailure(convertValue(1, quantity.unit, probe)))
      ctx.addIssue({ code: 'custom', path: ['unit'], message: `must be a ${dimension} unit` });
  });

const limitSchema = z.strictObject({
  quantity: z.enum(OUTGASSING_QUANTITIES),
  op: z.enum(['<', '<=']),
  value: finite.refine((value) => value >= 0 && value <= 100, 'must be between 0 and 100 (percent)'),
  unit: z.literal('%'),
});

const profileSchema = z.strictObject({
  id: z.string().regex(PROFILE_ID_PATTERN),
  label: text,
  limits: z.array(limitSchema).min(1).max(MAX_LIMITS),
  testMethod: z.enum(['ASTM_E595', 'ECSS_Q_ST_70_02']),
  source: text,
  status: z.enum(['verified', 'secondary', 'company']),
});

const MAX_DEVIATIONS = 10000;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const itemKeySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((key) => !RESERVED.has(key), 'reserved key');

const deviationSchema = z.strictObject({
  itemKey: itemKeySchema,
  decision: z.enum(['accepted', 'rejected']),
  justification: z.string().min(1).max(4000),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  signer: z.string().min(1).max(256),
  signatureId: z.string().min(1).max(256),
  signature: z.unknown(),
  documentUid: z.string().min(1).max(256),
});

const sliceSchema = z
  .strictObject({
    deviations: z.record(itemKeySchema, deviationSchema).optional(),
    outgassingProfile: z
      .union([z.string().refine((id) => SHIPPED_PROFILE_IDS.includes(id), 'names no shipped profile'), profileSchema])
      .optional(),
    humidityExposure: z
      .strictObject({
        relativeHumidity: finite.refine((value) => value >= 0 && value <= 100, 'must be between 0 and 100 (percent)'),
        temperature: quantityOf('temperature'),
        duration: quantityOf('time').refine((quantity) => quantity.value >= 0, 'must be >= 0'),
        faces: z.enum(['both', 'one']),
        source: text,
      })
      .optional(),
    aoFluence: z
      .strictObject({
        value: finite.refine((value) => value >= 0, 'must be >= 0'),
        unit: z.enum(['atoms/cm^2', 'atoms/m^2']),
        source: text,
      })
      .optional(),
  })
  .superRefine((slice, ctx) => {
    const entries = Object.entries(slice.deviations ?? {});
    if (entries.length > MAX_DEVIATIONS)
      ctx.addIssue({ code: 'custom', path: ['deviations'], message: `at most ${MAX_DEVIATIONS} deviations` });
    for (const [key, deviation] of entries.slice(0, MAX_DEVIATIONS))
      if (deviation.itemKey !== key)
        ctx.addIssue({ code: 'custom', path: ['deviations', key, 'itemKey'], message: `must equal its key '${key}'` });
  });

/** Value errors of the raw `spaceEnvironment` slice (persistence rejects the file when non-empty). */
export const spaceEnvironmentErrors = (raw: Record<string, unknown>): string[] =>
  raw['spaceEnvironment'] === undefined ? [] : sliceSchemaErrors(sliceSchema, raw['spaceEnvironment'], 'spaceEnvironment');
