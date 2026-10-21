/** `*ORIENTATION` of a part with an orthotropic CTE (PHY-04 M4b, TR-TMC-25) and the `set_material_orientation` command. */

import type { MaterialOrientation, ThermoMechSetup } from '@core/model/analysis';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { Vec3 } from '@core/model/vectors';
import { safeName, type DeckContext, type DeckRefusal } from '../decks/context';
import { num, row } from '../decks/format';
import { caseOf, withCase } from '../shared/access';
import { analysisIdSchema } from '../shared/schemas';
import { isOrthotropicCte } from './orthoCte';
import { refuseTmc } from './refusal';
import { dot3, len3 } from '@lib/vec3';

/** Relative size of |a x b| below which two axes count as parallel. */
const PARALLEL_TOLERANCE = 1e-9;

/**
 * Unit `axis1` and the unit part of `axis2` orthogonal to it, or a reason string.
 * @invariant deterministic: Gram-Schmidt, no rounding beyond double precision
 */
export function orthonormalAxes(axis1: Vec3, axis2: Vec3): MaterialOrientation | string {
  const length1 = len3(axis1);
  if (![...axis1, ...axis2].every(Number.isFinite) || !(length1 > 0)) return 'axis1 must be a finite non-zero vector';
  const unit1: Vec3 = [axis1[0] / length1, axis1[1] / length1, axis1[2] / length1];
  const along = dot3(axis2, unit1);
  const rest: Vec3 = [axis2[0] - along * unit1[0], axis2[1] - along * unit1[1], axis2[2] - along * unit1[2]];
  const restLength = len3(rest);
  if (!(restLength > PARALLEL_TOLERANCE * Math.max(1, len3(axis2)))) return 'axis2 must be a finite vector not parallel to axis1';
  return { axis1: unit1, axis2: [rest[0] / restLength, rest[1] / restLength, rest[2] / restLength] };
}

/**
 * `*ORIENTATION` block and its name for a part of a thermo_static / coupled case, or null when the part needs none (isotropic CTE, or an
 * orthotropic one on the document axes).
 * @failure orthotropic CTE on a rotated part without `set_material_orientation` -> TMC_ORIENTATION_REQUIRED
 */
export function orientationBlock(
  ctx: DeckContext,
  entityId: string,
): { readonly name: string; readonly text: string } | DeckRefusal | null {
  const setup: ThermoMechSetup | undefined = ctx.analysis.thermomech;
  if (setup === undefined || !isOrthotropicCte(ctx.materialOf(entityId) ?? undefined)) return null;
  const given = Object.hasOwn(setup.orientations ?? {}, entityId) ? setup.orientations?.[entityId] : undefined;
  if (given === undefined) {
    const rotation = Object.hasOwn(ctx.doc.entities, entityId) ? (ctx.doc.entities[entityId]?.rotation ?? []) : [];
    return rotation.some((angle) => angle !== 0)
      ? {
          code: 'TMC_ORIENTATION_REQUIRED',
          message: `part '${entityId}' is rotated and has an orthotropic CTE: its material directions are the document X / Y / Z axes unless set_material_orientation gives them`,
          ids: [entityId],
        }
      : null;
  }
  const name = `OR_${safeName(entityId)}`;
  const text = `*ORIENTATION, NAME=${name}, SYSTEM=RECTANGULAR\n${row(...given.axis1, ...given.axis2)}\n`;
  return { name, text };
}

/**
 * @affects doc.analysis.cases[analysisId].thermomech.orientations[entityId] (affected: [analysisId])
 * @invariant the stored axes are orthonormalised (axis1 unit, axis2 the unit part orthogonal to it); omitting both axes removes the entry
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not thermo_static / coupled -> THM_CASE_TYPE; entity not a part of the case, one axis
 *   without the other, zero / non-finite / parallel axes -> TMC_ORIENTATION_INVALID (refusals, unchanged doc)
 */
export const setMaterialOrientation = defineCommand({
  name: 'set_material_orientation',
  description:
    'Set the material axes of a part of a thermo_static or coupled_temperature_displacement analysis whose material has an orthotropic CTE ' +
    '(cte / thermalStrain property models with direction 1, 2, 3). axis1 is material direction 1 and axis2 any vector in the 1-2 plane, both ' +
    'in the document frame; direction 3 is axis1 x axis2. Without an orientation the directions 1 / 2 / 3 are the document X / Y / Z ' +
    'axes, which is refused for a rotated part (TMC_ORIENTATION_REQUIRED). Omit axis1 and axis2 to remove the orientation of the part. ' +
    'Written as *ORIENTATION and the ORIENTATION= parameter of the part section.',
  annotations: { idempotent: true },
  params: z.object({
    analysisId: analysisIdSchema.describe('Id of a thermo_static or coupled_temperature_displacement analysis.'),
    entityId: z.string().describe('Id of a part of the analysis (set_part_idealization).'),
    axis1: vec3('Material direction 1 as [x, y, z] in the document frame (any non-zero length).').optional(),
    axis2: vec3('Any [x, y, z] vector in the material 1-2 plane, not parallel to axis1.').optional(),
  }),
  run: (doc, { analysisId, entityId, axis1, axis2 }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId]): CommandResult =>
      refuseTmc(doc, 'set_material_orientation', code, message, ids);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`);
    const setup = analysisCase.thermomech;
    if (setup === undefined)
      return fail(
        'THM_CASE_TYPE',
        `analysis '${analysisId}' is ${analysisCase.type}, not thermo_static / coupled_temperature_displacement`,
      );
    if (!Object.hasOwn(analysisCase.parts, entityId))
      return fail('TMC_ORIENTATION_INVALID', `'${entityId}' is not a part of analysis '${analysisId}'`, [analysisId, entityId]);
    if ((axis1 === undefined) !== (axis2 === undefined))
      return fail('TMC_ORIENTATION_INVALID', 'give both axis1 and axis2, or neither to remove the orientation', [analysisId, entityId]);
    const { [entityId]: removed, ...others } = setup.orientations ?? {};
    if (axis1 === undefined || axis2 === undefined) {
      const next: ThermoMechSetup = { ...setup, orientations: others };
      return changed(
        withCase(doc, { ...analysisCase, thermomech: next }),
        `set_material_orientation: '${entityId}' of '${analysisId}' uses the document axes${removed === undefined ? ' (it already did)' : ''}.`,
        [analysisId],
      );
    }
    const axes = orthonormalAxes(axis1, axis2);
    if (typeof axes === 'string') return fail('TMC_ORIENTATION_INVALID', axes, [analysisId, entityId]);
    const next: ThermoMechSetup = { ...setup, orientations: { ...others, [entityId]: axes } };
    return changed(
      withCase(doc, { ...analysisCase, thermomech: next }),
      `set_material_orientation: '${entityId}' of '${analysisId}' direction 1 = [${axes.axis1.map(num).join(', ')}], direction 2 = [${axes.axis2.map(num).join(', ')}].`,
      [analysisId],
    );
  },
});
