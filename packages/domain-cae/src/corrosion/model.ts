/** Access to and validation of the corrosion slice of the document (`CadDocument.corrosion`, plugin `physics-corrosion`). */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import type { CadDocument } from '@core/model/types';
import {
  ISOLATION_METHODS,
  SURFACE_CLASSES,
  type CorrosionModel,
  type Isolation,
  type MaterialGalvanic,
  type SurfaceSystem,
} from './types';

const EMPTY: CorrosionModel = { materials: {}, surfaceSystems: {}, isolations: {}, acceptances: {} };

export const corrosionOf = (doc: CadDocument): CorrosionModel => doc.corrosion ?? EMPTY;

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

export const withCorrosion = (doc: CadDocument, patch: Partial<CorrosionModel>): CadDocument => ({
  ...doc,
  corrosion: { ...corrosionOf(doc), ...patch },
});

export const materialGalvanicOf = (doc: CadDocument, material: string): MaterialGalvanic | undefined =>
  own(corrosionOf(doc).materials, material);
export const isolationOf = (doc: CadDocument, id: string): Isolation | undefined => own(corrosionOf(doc).isolations, id);

/** The surface system that covers `entityId`, or undefined (one system per entity). */
export const surfaceSystemOfEntity = (doc: CadDocument, entityId: string): SurfaceSystem | undefined =>
  Object.values(corrosionOf(doc).surfaceSystems).find((system) => system.entityIds.includes(entityId));

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
/** Ids and keys: bounded, no whitespace, never a reserved object key. */
const keySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine((key) => !RESERVED.has(key), 'reserved key');
const textSchema = z.string().max(2000);
const sourceSchema = z.strictObject({ citation: z.string().min(1).max(500), locator: textSchema.optional() });
const MAX_IDS = 10_000;

const materialSchema = z.strictObject({
  galvanicGroup: keySchema,
  anodicIndexV: z.number().min(-5).max(5).optional(),
  source: sourceSchema,
});

const surfaceSchema = z.strictObject({
  id: keySchema,
  entityIds: z.array(keySchema).max(MAX_IDS),
  layers: z
    .array(z.strictObject({ class: z.enum(SURFACE_CLASSES), spec: textSchema.optional(), galvanicGroup: keySchema.optional() }))
    .min(1)
    .max(8),
});

const isolationSchema = z.strictObject({
  id: keySchema,
  pair: z.tuple([keySchema, keySchema]).optional(),
  entityId: keySchema.optional(),
  method: z.enum(ISOLATION_METHODS),
  spec: textSchema.optional(),
  note: textSchema.optional(),
});

const acceptanceSchema = z.strictObject({
  itemKey: keySchema,
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
    environment: z
      .strictObject({
        scheme: z.enum(['anodic_index', 'mil_std_889d']),
        value: z.enum(['harsh', 'normal', 'controlled', 'artificial_seawater']),
      })
      .optional(),
    materials: z.record(keySchema, materialSchema),
    surfaceSystems: z.record(keySchema, surfaceSchema),
    isolations: z.record(keySchema, isolationSchema),
    acceptances: z.record(keySchema, acceptanceSchema),
  })
  .superRefine((slice, ctx) => {
    const bad = (path: (string | number)[], message: string): void => ctx.addIssue({ code: 'custom', path, message });
    const { environment } = slice;
    if (environment !== undefined && (environment.value === 'artificial_seawater') !== (environment.scheme === 'mil_std_889d'))
      bad(['environment', 'value'], `'${environment.value}' is not valid for scheme '${environment.scheme}'`);
    for (const [key, system] of Object.entries(slice.surfaceSystems)) {
      if (system.id !== key) bad(['surfaceSystems', key, 'id'], `must equal its key '${key}'`);
      system.layers.forEach((layer, index) => {
        if (layer.class === 'metallic_plating' && layer.galvanicGroup === undefined)
          bad(['surfaceSystems', key, 'layers', index, 'galvanicGroup'], 'a metallic_plating layer needs a galvanicGroup');
      });
    }
    for (const [key, isolation] of Object.entries(slice.isolations)) {
      if (isolation.id !== key) bad(['isolations', key, 'id'], `must equal its key '${key}'`);
      if ((isolation.pair === undefined) === (isolation.entityId === undefined))
        bad(['isolations', key], 'must name exactly one of pair / entityId');
    }
    for (const [key, acceptance] of Object.entries(slice.acceptances))
      if (acceptance.itemKey !== key) bad(['acceptances', key, 'itemKey'], `must equal its key '${key}'`);
  });

/** Value errors of the raw `corrosion` slice (persistence rejects the file when non-empty). */
export const corrosionErrors = (raw: Record<string, unknown>): string[] =>
  raw['corrosion'] === undefined ? [] : sliceSchemaErrors(sliceSchema, raw['corrosion'], 'corrosion');
