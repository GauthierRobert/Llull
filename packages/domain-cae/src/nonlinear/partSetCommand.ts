/** set_part_constitutive_set: which constitutive set of its material record a part uses in a nonlinear_static analysis. */

import { findSet } from '@core/model/materialLaws/combination';
import { SET_SLOTS } from '@core/model/materialModel';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { refuseNls } from './codes';
import { isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';

/** Behaviours a static nonlinear step cannot use. */
const STATIC_UNSUPPORTED = ['viscoelastic', 'creep', 'rate'] as const;

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.constitutiveSets (sets or re-sets the entry of one part; affected: [analysisId])
 * @invariant the stored id is always explicit (the record default is resolved and named in the summary); the deck writes that set's cards
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; entity not a part -> FEA_PART_NOT_IN_ANALYSIS;
 *   no material, no such set or no default -> NLS_MATERIAL_MODEL_MISSING; creep / viscoelastic / rate member -> NLS_MATERIAL_MODEL_UNSUPPORTED
 *   (refusals, unchanged doc)
 */
export const setPartConstitutiveSet = defineCommand({
  name: 'set_part_constitutive_set',
  description:
    'Choose the constitutive set (elastic + plastic / hyperelastic behaviour, from define_constitutive_set on the part material) that a ' +
    "part uses in a nonlinear_static analysis. The deck then carries that set's CalculiX cards (*ELASTIC, *PLASTIC, ...) exactly as " +
    'export_material_cards writes them; no stress-strain values are stored in the analysis. Omit constitutiveSetId to use the ' +
    "material's default set (the summary names it). Sets with creep, viscoelastic or rate laws are refused for a static step. " +
    'Parts that share a material must use the same set. Needs the part (set_part_idealization) and its assigned material.',
  annotations: { idempotent: true },
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z.string().describe('Id of a part of the analysis (set_part_idealization).'),
    constitutiveSetId: z
      .string()
      .optional()
      .describe("Id of a ConstitutiveSet of the part's material record (define_constitutive_set). Default: the material's default set."),
  }),
  run: (doc, { analysisId, entityId, constitutiveSetId }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseNls(doc, 'set_part_constitutive_set', code, message, [analysisId, entityId], paths);
    const found = nonlinearCase(doc, 'set_part_constitutive_set', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    if (!Object.hasOwn(analysis.parts, entityId))
      return fail('FEA_PART_NOT_IN_ANALYSIS', `entity '${entityId}' is not a part of '${analysisId}' (set_part_idealization first)`, [
        'entityId',
      ]);
    const materialId = doc.entities[entityId]?.materialId;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (material === undefined)
      return fail('NLS_MATERIAL_MODEL_MISSING', `part '${entityId}' has no material (assign_material)`, ['entityId']);
    const setId = constitutiveSetId ?? material.defaultConstitutiveSet;
    if (setId === undefined)
      return fail(
        'NLS_MATERIAL_MODEL_MISSING',
        `material '${materialId}' has no default constitutive set: pass constitutiveSetId or define_constitutive_set makeDefault`,
        ['constitutiveSetId'],
      );
    const set = findSet(material.constitutiveSets, setId);
    if (set === undefined)
      return fail('NLS_MATERIAL_MODEL_MISSING', `material '${materialId}' has no constitutive set '${setId}'`, ['constitutiveSetId']);
    const unsupported = STATIC_UNSUPPORTED.filter((slot) => set[slot] !== undefined);
    if (unsupported.length > 0)
      return fail(
        'NLS_MATERIAL_MODEL_UNSUPPORTED',
        `set '${setId}' of '${materialId}' contains ${unsupported.join(' / ')} law(s), not usable in a static step`,
        ['constitutiveSetId'],
      );
    const nonlinear = nonlinearOf(analysis);
    if (nonlinear.nlgeom === false && set.hyperelastic !== undefined)
      return fail(
        'NLS_CONTROL_INVALID',
        `set '${setId}' has a hyperelastic law, which CalculiX only runs with NLGEOM: call set_nonlinear_controls nlgeom=true first`,
        ['constitutiveSetId'],
      );
    const next = { ...nonlinear, constitutiveSets: { ...nonlinear.constitutiveSets, [entityId]: setId } };
    const behaviours = SET_SLOTS.filter((slot) => set[slot] !== undefined).join(' + ');
    return changed(
      withNonlinear(doc, analysis, next),
      `set_part_constitutive_set: part '${entityId}' of '${analysisId}' uses set '${setId}' of '${materialId}' (${behaviours})${constitutiveSetId === undefined ? ' - the material default' : ''}.`,
      [analysisId],
    );
  },
});
