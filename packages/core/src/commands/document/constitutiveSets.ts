/** define_constitutive_set (PHY-02 §3.4): a named combination of the material's models that an analysis or a query picks. */

import { combinationIssues } from '../../model/materialLaws/combination';
import { SET_SLOTS, type ConstitutiveSet } from '../../model/materialModel';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { editableMaterial } from './libraryReadonly';
import { matlRefusal } from './materialModelRefusal';

const command = 'define_constitutive_set';

/**
 * @affects CadDocument.materials[material].constitutiveSets (adds or replaces one set), defaultConstitutiveSet (with makeDefault)
 * @invariant the combination rules of §3.4 hold: one of elastic / hyperelastic (Ramberg-Osgood carries E, ν), plasticity on isotropic
 *   elasticity, creep on elastic, viscoelastic on elastic or hyperelastic, Johnson-Cook rate on Johnson-Cook hardening, no durability kinds
 * @failure unknown material -> MAT_RECORD_NOT_FOUND; library record -> MAT_RECORD_READONLY; unknown model id -> MATL_MODEL_NOT_FOUND; rule broken -> MATL_COMBINATION_INVALID;
 *   duplicate set id without replace -> MATL_MODEL_EXISTS (all rejections, document unchanged)
 */
export const defineConstitutiveSet = defineCommand({
  name: command,
  description:
    'Define a constitutive set on a material: a named combination of its material models (add_material_model first) that fills the slots ' +
    'elastic / hyperelastic / plastic / viscoelastic / creep / rate. Rules: exactly one of elastic and hyperelastic (a ramberg_osgood plastic ' +
    'model carries E and ν itself and forbids both); j2_plasticity needs elastic_isotropic (elastic_orthotropic only with perfect or linear ' +
    'hardening); creep needs an elastic model; viscoelastic needs elastic or hyperelastic; rate_johnson_cook needs johnson_cook hardening; ' +
    'fatigue and crack-growth models are never members. material_point_response and export_material_cards take the set id.',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    set: z
      .object({
        id: z.string().min(1).describe('Set id, unique on the material, e.g. "iso_hardening".'),
        elastic: z.string().optional().describe('Id of the elastic model.'),
        hyperelastic: z.string().optional().describe('Id of the hyperelastic model.'),
        plastic: z.string().optional().describe('Id of the j2_plasticity or ramberg_osgood model.'),
        viscoelastic: z.string().optional().describe('Id of the visco_prony model.'),
        creep: z.string().optional().describe('Id of the creep_norton or creep_garofalo model.'),
        rate: z.string().optional().describe('Id of the rate_johnson_cook or rate_cowper_symonds model.'),
      })
      .describe('The set: its id and the model id of each slot it fills.'),
    makeDefault: z.boolean().optional().describe('Make this the default set of the material (used when a query names none).'),
    replace: z.boolean().optional().describe('Replace an existing set with the same id (default false: refused with MATL_MODEL_EXISTS).'),
  }),
  run: (doc, { material: materialId, set: input, makeDefault, replace }): CommandResult => {
    const editable = editableMaterial(doc, command, materialId, matlRefusal);
    if ('refusal' in editable) return editable.refusal;
    const { material } = editable;
    const set: ConstitutiveSet = {
      id: input.id,
      ...Object.fromEntries(SET_SLOTS.flatMap((slot) => (input[slot] === undefined ? [] : [[slot, input[slot]]]))),
    };
    const sets = material.constitutiveSets ?? [];
    const index = sets.findIndex((candidate) => candidate.id === set.id);
    if (index >= 0 && replace !== true)
      return matlRefusal(
        doc,
        command,
        'MATL_MODEL_EXISTS',
        `'${materialId}' already has a constitutive set '${set.id}'`,
        [set.id],
        'set.id',
      );
    const issue = combinationIssues(set, material.materialModels ?? [])[0];
    if (issue !== undefined) return matlRefusal(doc, command, issue.code, issue.message, [set.id], issue.path);
    const next = index >= 0 ? sets.map((candidate) => (candidate.id === set.id ? set : candidate)) : [...sets, set];
    const nextDefault = makeDefault === true ? set.id : material.defaultConstitutiveSet;
    const document: CadDocument = {
      ...doc,
      materials: {
        ...doc.materials,
        [materialId]: {
          ...material,
          constitutiveSets: next,
          ...(nextDefault !== undefined ? { defaultConstitutiveSet: nextDefault } : {}),
        },
      },
    };
    const slots = SET_SLOTS.filter((slot) => set[slot] !== undefined).map((slot) => `${slot}=${set[slot]}`);
    return changed(
      document,
      `define_constitutive_set '${materialId}/${set.id}': ${slots.join(', ')}${index >= 0 ? ' (replaced)' : ''}${makeDefault === true ? '; default set' : ''}.`,
      [],
    );
  },
});
