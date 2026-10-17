/** export_material_cards (PHY-02 §6): solver material cards of a constitutive set — the single implementation the deck writers reuse. */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { defaultCardName, isMaterialCardsRefusal, writeMaterialCards } from '../../model/materialLaws/cardWriter';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { matlRefusal } from '../document/materialModelRefusal';
import { isRefusal, selectSlots } from './setSelection';

const command = 'export_material_cards';

const DEFAULT_TEXT: Readonly<Record<string, { value: string | number | boolean; source: string }>> = {
  linearLawExtension: {
    value: 'up to the model validity maximum equivalent plastic strain',
    source: 'llull rule (TECHNICAL_SPEC §5.10); no validity => MATL_VALIDITY_MISSING',
  },
  voceTablePoints: { value: 21, source: 'llull choice: Voce hardening tabulated at 21 equally spaced plastic strains' },
};

const CARD_NAME = /^[A-Za-z0-9_]{1,80}$/;

/**
 * @affects nothing — read-only; data { lines[], header, target, name, unverified, unverifiedReasons, reviewRequired, warnings[], defaults[] }
 * @invariant one text for the UI, CLI and deck writers; numbers are the shortest round-trip decimal (integers with a trailing `.` in CalculiX)
 * @failure law the target cannot represent -> MATL_EXPORT_UNSUPPORTED (law and target named); model without validity -> MATL_VALIDITY_MISSING;
 *   broken set -> MATL_COMBINATION_INVALID; property-model refusals pass through
 */
export const exportMaterialCards = defineCommand({
  name: command,
  annotations: { readOnly: true },
  description:
    'Write the solver material cards of a constitutive set as text lines (data.lines) for CalculiX (*ELASTIC, *PLASTIC, *CYCLIC HARDENING, ' +
    '*DEFORMATION PLASTICITY, *HYPERELASTIC, *CREEP, *RATE DEPENDENT) or Nastran (MAT1 + MATS1). Stress is written in MPa, temperature in K; ' +
    'a stress-like parameter that references a property model is evaluated at each requested temperature. Linear and Voce hardening are ' +
    "tabulated up to the model's equivalent-plastic-strain validity. A law the target cannot represent is refused with MATL_EXPORT_UNSUPPORTED " +
    '(never dropped silently); every model must carry validity ranges (MATL_VALIDITY_MISSING). data.header is the provenance comment line ' +
    '(hash, unverified reasons) to put above the lines. Next: embed in the solver deck.',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    set: z.string().optional().describe('Constitutive set id (default: the material default set).'),
    target: z.enum(['calculix', 'nastran']).describe('Solver the cards are for.'),
    name: z.string().optional().describe('Card name (*MATERIAL,NAME=…; default <MATERIAL>_<SET> upper-cased).'),
    mid: z.number().int().positive().optional().describe('Nastran material id (default 1).'),
    forCertification: z
      .boolean()
      .optional()
      .describe('Refuse cards built on unverified data (MAT_VALUE_UNVERIFIED) and flag reviewRequired.'),
    temperatures: z
      .array(
        z.object({ value: z.number().describe('Temperature value.'), unit: z.string().describe("Temperature unit, e.g. 'K', 'degC'.") }),
      )
      .optional()
      .describe('Temperatures to write rows at (default: one row without a temperature column). Nastran: at most one.'),
  }),
  run: (doc, params): CommandResult => {
    const material = Object.hasOwn(doc.materials, params.material) ? doc.materials[params.material] : undefined;
    const refuse = (code: string, message: string, ids: readonly string[], path: string, remediation?: string): CommandResult => ({
      ...matlRefusal(doc, command, code, message, ids, path, remediation),
      data: { code, path, remediation: remediation ?? null },
    });
    if (material === undefined) return refuse('MAT_RECORD_NOT_FOUND', `no material '${params.material}'`, [params.material], 'material');
    const selection = selectSlots(material, params.material, params.set, undefined);
    if (isRefusal(selection)) return refuse(selection.code, selection.message, selection.ids, selection.path, selection.remediation);
    const temperaturesK: number[] = [];
    for (const [i, temperature] of (params.temperatures ?? []).entries()) {
      const kelvin = convertValue(temperature.value, temperature.unit, 'K');
      if (isUnitFailure(kelvin)) return refuse('MATL_LAW_PARAMS_INVALID', kelvin.message, [], `temperatures[${i}].unit`);
      temperaturesK.push(kelvin.value);
    }
    if (params.name !== undefined && !CARD_NAME.test(params.name))
      return refuse('MATL_LAW_PARAMS_INVALID', 'name must be 1-80 letters, digits or underscores', [], 'name', 'give a name like NL1_ISO');
    const name = params.name ?? defaultCardName(params.material, selection.setId);
    const record = { name: params.material, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
    const output = writeMaterialCards({
      record,
      materialId: params.material,
      setId: selection.setId,
      slots: selection.slots,
      target: params.target,
      name,
      mid: params.mid ?? 1,
      temperaturesK,
      ...(params.forCertification !== undefined ? { forCertification: params.forCertification } : {}),
    });
    if (isMaterialCardsRefusal(output)) {
      const ids = output.code === 'MATL_VALIDITY_MISSING' ? [output.path.split('.')[1] ?? ''] : [];
      const refused = refuse(output.code, output.message, ids, output.path, output.remediation);
      return output.unverifiedReasons === undefined
        ? refused
        : { ...refused, data: { code: output.code, reviewRequired: true, unverifiedReasons: output.unverifiedReasons } };
    }
    const { header, reviewRequired, unverified, unverifiedReasons: reasons } = output;
    const defaults = output.usedDefaults.flatMap((key) => {
      const text = DEFAULT_TEXT[key];
      return text === undefined ? [] : [{ name: key, value: text.value, source: text.source, defaulted: true as const }];
    });
    return report(
      doc,
      `${command} '${params.material}/${selection.setId}' for ${params.target}: ${output.lines.length} line(s)${unverified ? `; unverified (${reasons.join('; ')})` : ''}${reviewRequired ? '; review required' : ''}${
        output.warnings.length > 0 ? `; warnings: ${output.warnings.map((w) => w.code).join(', ')}` : ''
      }.`,
      {
        lines: output.lines,
        header,
        target: params.target,
        name,
        set: selection.setId,
        unverified,
        unverifiedReasons: reasons,
        reviewRequired,
        warnings: output.warnings,
        defaults,
      },
    );
  },
});
