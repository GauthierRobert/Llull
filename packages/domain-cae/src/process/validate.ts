/** Load validation of `AnalysisCase.am` (PHY-16 §3): shape by zod, then the rules `am_build_setup`, `set_inherent_strain` and `add_release_step` enforce. */

import { z } from '@core/commands/schema';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { len3 } from '@lib/vec3';
import { support321 } from './support321';

const vector = z.tuple([z.number(), z.number(), z.number()]);
const part = z.enum(['plate', 'supports']);

const amSchema = z.object({
  buildDirection: vector,
  plateEntityId: z.string(),
  supportEntityIds: z.array(z.string()),
  layerHeight: z.number().positive().finite(),
  inherentStrain: z
    .object({
      exx: z.number().finite(),
      eyy: z.number().finite(),
      ezz: z.number().finite(),
      source: z.string().trim().min(1),
      calibrated: z.boolean(),
    })
    .optional(),
  releaseSteps: z.array(z.object({ name: z.string().min(1), remove: z.array(part).min(1), support321: z.tuple([vector, vector, vector]) })),
});

type Am = z.infer<typeof amSchema>;

/** Same bound as set_inherent_strain: a magnitude at or above it is a unit mistake. */
const STRAIN_LIMIT = 0.1;
const UNIT_TOLERANCE = 1e-6;

/**
 * Errors of the build set-up of one raw case (`where` = its path prefix).
 * @invariant only am_build_distortion cases carry one; the direction is a unit vector; the plate and the supports are distinct parts of the case and
 *   one part is left to build; |strain| < 0.1 with a non-blank source; release step names are unique, each part is removed once, supports only when the
 *   case has some, and every 3-2-1 support has non-collinear points
 */
export function amErrors(analysisCase: Record<string, unknown>, where: string): string[] {
  const raw = analysisCase['am'];
  if (raw === undefined) return [];
  const at = `${where}.am`;
  if (analysisCase['type'] !== 'am_build_distortion') return [`${at}: only am_build_distortion cases carry a build set-up`];
  const shape = sliceSchemaErrors(amSchema, raw, at);
  if (shape.length > 0) return shape;
  const am = raw as Am;
  const errors: string[] = [];
  const parts = Object.keys((analysisCase['parts'] ?? {}) as Record<string, unknown>);
  if (Math.abs(len3(am.buildDirection) - 1) > UNIT_TOLERANCE) errors.push(`${at}.buildDirection: not a unit vector`);
  if (!parts.includes(am.plateEntityId)) errors.push(`${at}.plateEntityId: '${am.plateEntityId}' is not a part of the case`);
  for (const id of am.supportEntityIds) if (!parts.includes(id)) errors.push(`${at}.supportEntityIds: '${id}' is not a part of the case`);
  if (am.supportEntityIds.includes(am.plateEntityId) || new Set(am.supportEntityIds).size !== am.supportEntityIds.length)
    errors.push(`${at}.supportEntityIds: the plate and the supports must be distinct`);
  if (!parts.some((id) => id !== am.plateEntityId && !am.supportEntityIds.includes(id))) errors.push(`${at}: no part is left to build`);
  const strain = am.inherentStrain;
  if (strain !== undefined && [strain.exx, strain.eyy, strain.ezz].some((value) => Math.abs(value) >= STRAIN_LIMIT))
    errors.push(`${at}.inherentStrain: a component is not below ${STRAIN_LIMIT} in magnitude`);
  const removed: string[] = [];
  const names = new Set<string>();
  am.releaseSteps.forEach((step, index) => {
    const here = `${at}.releaseSteps[${index}]`;
    if (names.has(step.name)) errors.push(`${here}.name: '${step.name}' is used twice`);
    names.add(step.name);
    if (new Set(step.remove).size !== step.remove.length) errors.push(`${here}.remove: lists a part twice`);
    for (const what of step.remove) {
      if (removed.includes(what)) errors.push(`${here}.remove: the ${what} is removed twice`);
      if (what === 'supports' && am.supportEntityIds.length === 0) errors.push(`${here}.remove: supports, but the case has none`);
      removed.push(what);
    }
    const dofs = support321(step.support321);
    if (typeof dofs === 'string') errors.push(`${here}.support321: ${dofs}`);
  });
  return errors;
}
