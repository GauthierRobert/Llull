/** Load validation of `AnalysisCase.pretension` (PHY-06 FR-CNT-03): shape by zod, then ids, order, names, the part, the preload and the step. */

import { z } from '@core/commands/schema';
import type { BoltPretension, PretensionSettings } from '@core/model/contact';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { pretensionValueProblem } from './pretensionRules';

const vector = z.tuple([z.number(), z.number(), z.number()]);

const boltSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  entityId: z.string(),
  section: z.object({ point: vector, normal: vector }),
  preload: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('force'), value: z.number() }),
    z.object({ kind: z.literal('torque'), torque: z.number(), nutFactor: z.number(), diameter: z.number(), nutFactorSource: z.string() }),
  ]),
  preloadStepId: z.string(),
  lockAfter: z.boolean(),
});

const settingsSchema = z.object({ bolts: z.record(z.string(), boltSchema), order: z.array(z.string()) });

const RESERVED: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Errors of the bolt pretensions of one raw case (`where` = its path prefix).
 * @invariant only nonlinear_static cases carry pretensions; bolt ids equal their keys, are listed once in order and are not reserved names; names
 *   unique; parts exist; preloads and section vectors valid; the preload step is the first step of the case
 */
export function pretensionErrors(
  analysisCase: Record<string, unknown>,
  where: string,
  entities: Readonly<Record<string, unknown>>,
): string[] {
  const raw = analysisCase['pretension'];
  if (raw === undefined) return [];
  const at = `${where}.pretension`;
  if (analysisCase['type'] !== 'nonlinear_static') return [`${at}: only nonlinear_static cases carry bolt pretensions`];
  const shape = sliceSchemaErrors(settingsSchema, raw, at);
  if (shape.length > 0) return shape;
  const settings = raw as PretensionSettings;
  const errors: string[] = [];
  if (new Set(settings.order).size !== settings.order.length) errors.push(`${at}.order: duplicate ids`);
  if (settings.order.length === 0)
    errors.push(`${at}: pretension without bolts (delete_bolt_pretension removes the settings with the last bolt)`);
  for (const id of settings.order) if (!Object.hasOwn(settings.bolts, id)) errors.push(`${at}.order: '${id}' is listed but missing`);
  const nonlinear = analysisCase['nonlinear'];
  const stepOrder: readonly unknown[] =
    typeof nonlinear === 'object' && nonlinear !== null && 'stepOrder' in nonlinear && Array.isArray(nonlinear.stepOrder)
      ? nonlinear.stepOrder
      : [];
  const listed = new Set(settings.order);
  const names = new Set<string>();
  for (const key of Object.keys(settings.bolts)) {
    const bolt = settings.bolts[key] as BoltPretension;
    const path = `${at}.bolts.${key}`;
    if (RESERVED.has(key)) errors.push(`${path}: reserved key`);
    if (bolt.id !== key) errors.push(`${path}: id '${bolt.id}' differs from its key`);
    if (!listed.has(key)) errors.push(`${path}: missing from order`);
    if (names.has(bolt.name)) errors.push(`${path}: name '${bolt.name}' is used by another bolt`);
    names.add(bolt.name);
    if (!Object.hasOwn(entities, bolt.entityId)) errors.push(`${path}.entityId: entity '${bolt.entityId}' does not exist`);
    const bad = pretensionValueProblem(bolt);
    if (bad !== null) errors.push(`${path}.${bad.path}: ${bad.code} ${bad.message}`);
    if (stepOrder[0] !== bolt.preloadStepId)
      errors.push(`${path}.preloadStepId: '${bolt.preloadStepId}' is not the first step of the case`);
  }
  return errors;
}
