/** Load validation of `AnalysisCase.contact` (PHY-06 §3): shape by zod, then ids, order, names, references and pair rules. */

import { z } from '@core/commands/schema';
import type { ContactPair, ContactSettings } from '@core/model/contact';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { pairValueProblem } from './pairRules';
import { adjustSchema, behaviourSchema, formulationSchema, frictionSchema } from './pairSchema';

const point = z.tuple([z.number(), z.number(), z.number()]);
const targetSchema = z.object({
  entityId: z.string(),
  facesNear: z.array(point).min(1),
  edgesNear: z.array(point).optional(),
  pointsNear: z.array(point).optional(),
  intersectPlane: z.object({ point, normal: point }).optional(),
});

const pairSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  slave: targetSchema,
  master: targetSchema,
  behaviour: behaviourSchema,
  friction: frictionSchema.optional(),
  adjust: adjustSchema.optional(),
  smallSliding: z.boolean().optional(),
  activeSteps: z.array(z.string()).optional(),
  noSlipRequired: z.boolean().optional(),
});

const settingsSchema = z.object({
  formulation: formulationSchema,
  pairs: z.record(z.string(), pairSchema),
  pairOrder: z.array(z.string()),
});

const RESERVED: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Errors of the contact settings of one raw case (`where` = its path prefix).
 * @invariant only nonlinear_static cases carry contact; pair ids equal their keys, are listed once in pairOrder and are not reserved names;
 *   names unique; target entities exist; activeSteps name steps of the case; every pair satisfies the formulation / value rules
 */
export function contactErrors(analysisCase: Record<string, unknown>, where: string, entities: Readonly<Record<string, unknown>>): string[] {
  const raw = analysisCase['contact'];
  if (raw === undefined) return [];
  const at = `${where}.contact`;
  if (analysisCase['type'] !== 'nonlinear_static') return [`${at}: only nonlinear_static cases carry contact pairs`];
  const shape = sliceSchemaErrors(settingsSchema, raw, at);
  if (shape.length > 0) return shape;
  const settings = raw as ContactSettings;
  const errors: string[] = [];
  const keys = Object.keys(settings.pairs);
  if (new Set(settings.pairOrder).size !== settings.pairOrder.length) errors.push(`${at}.pairOrder: duplicate ids`);
  if (settings.pairOrder.length === 0)
    errors.push(`${at}: contact without pairs (delete_contact_pair removes the settings with the last pair)`);
  for (const id of settings.pairOrder)
    if (!Object.hasOwn(settings.pairs, id)) errors.push(`${at}.pairOrder: '${id}' is listed but missing`);
  const nonlinear = analysisCase['nonlinear'];
  const steps: object =
    typeof nonlinear === 'object' &&
    nonlinear !== null &&
    'steps' in nonlinear &&
    typeof nonlinear.steps === 'object' &&
    nonlinear.steps !== null
      ? nonlinear.steps
      : {};
  const names = new Set<string>();
  for (const key of keys) {
    const pair = settings.pairs[key] as ContactPair;
    const path = `${at}.pairs.${key}`;
    if (RESERVED.has(key)) errors.push(`${path}: reserved key`);
    if (pair.id !== key) errors.push(`${path}: id '${pair.id}' differs from its key`);
    if (!settings.pairOrder.includes(key)) errors.push(`${path}: missing from pairOrder`);
    if (names.has(pair.name)) errors.push(`${path}: name '${pair.name}' is used by another pair`);
    names.add(pair.name);
    for (const side of ['slave', 'master'] as const)
      if (!Object.hasOwn(entities, pair[side].entityId)) errors.push(`${path}.${side}: entity '${pair[side].entityId}' does not exist`);
    const bad = pairValueProblem(pair, settings.formulation);
    if (bad !== null) errors.push(`${path}.${bad.path}: ${bad.code} ${bad.message}`);
    for (const stepId of pair.activeSteps ?? [])
      if (!Object.hasOwn(steps, stepId)) errors.push(`${path}.activeSteps: '${stepId}' is not a step of the case`);
  }
  return errors;
}
