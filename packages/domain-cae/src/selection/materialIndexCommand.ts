/** material_index (PHY-12 FR-SEL-01, 02): performance indices of materials, base units, with inputs, basis and the unverified flag. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { basesOf, mixedBasesWarning, unverifiedSummary } from './bases';
import { issue, REVIEW_SENTENCE, refuseSel } from './codes';
import { evaluateIndex, isExcluded } from './indices';
import { INDEX_RULES, ruleOf } from './indexRules';
import {
  directionSchema,
  optionsProblem,
  resolveOptionsOf,
  strengthSchema,
  temperatureSchema,
  thicknessSchema,
  unique,
  unknownMaterials,
} from './inputs';
import { INDEX_CASES, type Excluded, type IndexResult } from './types';

const COMMAND = 'material_index';

/**
 * @affects nothing - read-only; data { results[], excluded[], basesUsed[], warnings[], unverified, reviewRequired }
 * @invariant values in base units (E GPa, strength MPa, density Mg/m^3) with the unit string generated from the exponent; request order kept; no property imputed, no NaN
 * @failure unknown material SEL_MATERIAL_NOT_FOUND, strength index without strengthProperty SEL_STRENGTH_PROPERTY_UNSET, bad quantity SEL_PARAMS_INVALID
 *   (refusals, unchanged doc); a material without a required value -> excluded[] (SEL_PROPERTY_MISSING / SEL_PROPERTY_AMBIGUOUS / PHY-01 code)
 */
export const materialIndex = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Compute Ashby performance indices P^n / rho of materials of the document, to rank them for a loading case (higher is better: lighter for the same performance). ' +
    `Indices: ${INDEX_RULES.map((entry) => `${entry.case} = ${entry.index}`).join(', ')} (tie = bar in tension, beam / panel = bending with a free section side / thickness, ` +
    'column_buckling = Euler column). Name the loading case: the right index depends on how the part is loaded. Strength indices need strengthProperty (Fty, Ftu or Fcy, no default). ' +
    'Values come from the stored sourced properties (density, E, Fty ...; set_material_property / import_material_library), converted to base units: E in GPa, strength in MPa, density in Mg/m^3, ' +
    'so a result reads e.g. 3.013 GPa^(1/2)/(Mg/m^3). Returns data { results: [{ material, case, value, unit, inputs: [{ property, value, unit, basis, propertyValueId, provenance }], unverified, unverifiedReasons, warnings }], ' +
    'excluded: [{ material, code, reason, missing }], basesUsed, warnings, unverified, reviewRequired }. A material that lacks a required value is listed in excluded (SEL_PROPERTY_MISSING, never imputed); ' +
    'typical / supplier / legacy inputs make the result unverified (SEL_VALUE_UNVERIFIED), and several bases in one call give SEL_BASIS_MIXED. Read-only. Next: compare_materials to rank with constraints, substitute_material to test a swap.',
  params: z.object({
    materials: z
      .array(z.string())
      .describe(
        'Material ids of the document (get_material lists a material; import_material_library adds library records). Unknown ids are refused.',
      ),
    indices: z.array(z.enum(INDEX_CASES)).describe('Loading cases to evaluate, e.g. ["beam_stiffness", "tie_strength"].'),
    strengthProperty: strengthSchema.optional(),
    direction: directionSchema.optional(),
    thickness: thicknessSchema.optional(),
    temperature: temperatureSchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const materials = unique(params.materials);
    const indices = unique(params.indices);
    if (materials.length === 0 || indices.length === 0)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_PARAMS_INVALID',
        'give at least one material and one index',
        [],
        [materials.length === 0 ? 'materials' : 'indices'],
      );
    const problem = optionsProblem(params);
    if (problem !== null) return refuseSel(doc, COMMAND, 'SEL_PARAMS_INVALID', problem, [], [problem.split(/[.:]/)[0] ?? 'params']);
    const unknown = unknownMaterials(doc, materials);
    if (unknown.length > 0)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_MATERIAL_NOT_FOUND',
        `no material ${unknown.map((id) => `'${id}'`).join(', ')}`,
        unknown,
        ['materials'],
        { known: Object.keys(doc.materials) },
      );
    const needsStrength = indices.filter((entry) => ruleOf(entry)?.property === 'strength');
    if (needsStrength.length > 0 && params.strengthProperty === undefined)
      return refuseSel(
        doc,
        COMMAND,
        'SEL_STRENGTH_PROPERTY_UNSET',
        `${needsStrength.join(', ')} need a strength property`,
        [],
        ['strengthProperty'],
      );
    const options = { ...resolveOptionsOf(params), strengthProperty: params.strengthProperty };
    const results: IndexResult[] = [];
    const excluded: Excluded[] = [];
    for (const material of materials) {
      for (const indexCase of indices) {
        const rule = ruleOf(indexCase);
        if (rule === undefined) continue;
        const evaluated = evaluateIndex(doc, material, rule, options);
        if (isExcluded(evaluated)) excluded.push(evaluated);
        else results.push(evaluated);
      }
    }
    const bases = basesOf(results.flatMap((result) => result.inputs));
    const warnings = [
      ...unverifiedSummary(
        unique(results.filter((result) => result.unverified).map((result) => result.material)),
        results.flatMap((result) => result.unverifiedReasons.map((reason) => `${result.material} ${reason}`)),
      ),
      ...mixedBasesWarning(bases, materials),
      ...excluded.map((entry) => issue(entry.code, 'warning', `'${entry.material}' excluded: ${entry.reason}`, [entry.material])),
    ];
    const unverified = results.some((result) => result.unverified);
    const leaders = indices.flatMap((indexCase) => {
      const leader = results
        .filter((result) => result.case === indexCase)
        .sort((a, b) => b.value - a.value || a.material.localeCompare(b.material))[0];
      return leader === undefined ? [] : [`${indexCase}: ${leader.material} ${Number(leader.value.toPrecision(6))} ${leader.unit}`];
    });
    return report(
      doc,
      `${COMMAND}: ${results.length} index value(s) for ${materials.length} material(s), ${excluded.length} excluded` +
        `${leaders.length > 0 ? `; best ${leaders.join('; ')}` : ''}${unverified ? '; UNVERIFIED inputs (typical / supplier / legacy values)' : ''}; ${REVIEW_SENTENCE}.`,
      { results, excluded, basesUsed: bases, warnings, unverified, reviewRequired: true },
    );
  },
});
