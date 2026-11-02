/** `thermal_growth`: free thermal expansion of a straight pipe length (07 PST M1, TR-PST-10). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { isCteRefusal, materialCteProvider, type CteBasis } from '@core/model/materialCte';
import { CARBON_STEEL_C1_ID, TABLE_SOURCE } from '../data/carbonSteelC1';
import { carbonSteelStrain, TABLE_RANGE_C } from '../code/thermalStrain';
import { refuse } from '../codes';

const KELVIN = 273.15;

const CODE_OF_CAUSE: Readonly<Record<string, string>> = {
  MAT_RECORD_NOT_FOUND: 'PST_MATERIAL_NOT_FOUND',
  TMC_PROPERTY_OUT_OF_RANGE: 'PST_TEMPERATURE_OUT_OF_TABLE',
};

/**
 * @affects none; data = { growthMm, mmPerM, meanCtePerK, strain, source, grade, warnings, reviewRequired, provenance }
 * @invariant read-only; growth = L x strain between the two temperatures (signed: cooling shrinks); the table is interpolated, never extrapolated
 * @failure none of / more than one of table, materialId, meanCtePerK -> PST_PARAM_INVALID; unknown material -> PST_MATERIAL_NOT_FOUND;
 *   no thermalStrain / cte model -> PST_MATERIAL_NO_DATA; temperature outside the table or the model validity -> PST_TEMPERATURE_OUT_OF_TABLE
 */
export const thermalGrowth = defineCommand({
  name: 'thermal_growth',
  description:
    'Free thermal growth of a straight pipe length between two metal temperatures, no model needed: growth = length x thermal strain. Give exactly one strain source: ' +
    'table "carbon-steel-c1" (carbon steel mean expansion from 70 degF, tabulated 21.1 to 482 degC; example 30 m from 21.1 to 204.4 degC grows 67.52 mm = 2.25 mm/m), ' +
    'materialId (a document material with a thermalStrain or cte property model; the model validity range applies), or meanCtePerK (a constant secant coefficient you supply, in 1/K). ' +
    'Temperatures in degC, length in m, growth in mm. Cooling gives negative growth. Refuses temperatures outside the table or model range (no extrapolation). ' +
    'Read-only; reviewRequired is always true; table rows other than the 400 degF row are grade B and the result names the grade. Next: guided_cantilever to check a leg absorbing this growth.',
  params: z.object({
    table: z
      .literal(CARBON_STEEL_C1_ID)
      .describe('Built-in strain table: carbon steel mean expansion from 70 degF (B31.3 Table C-1 group as quoted by PSI).')
      .optional(),
    materialId: z
      .string()
      .min(1)
      .describe('Name of a document material that has a thermalStrain (preferred) or cte property model.')
      .optional(),
    meanCtePerK: z
      .number()
      .describe('Constant secant thermal expansion coefficient in 1/K (steel about 1.2e-5). Unverified, caller supplied.')
      .optional(),
    cteReferenceC: z
      .number()
      .describe(
        'Only with materialId whose model is a secant cte: the reference temperature of the coefficient in degC. Omit for thermalStrain models.',
      )
      .optional(),
    fromC: z.number().min(-273.15).describe('Starting (installation) metal temperature in degC.'),
    toC: z.number().min(-273.15).describe('Final (operating) metal temperature in degC.'),
    lengthM: z.number().positive().describe('Straight pipe length in metres.'),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuse(doc, 'thermal_growth', code, message, [], paths);
    const given = [params.table, params.materialId, params.meanCtePerK].filter((value) => value !== undefined).length;
    if (given !== 1) return fail('PST_PARAM_INVALID', 'give exactly one of table, materialId, meanCtePerK', ['table']);
    if (params.cteReferenceC !== undefined && params.materialId === undefined)
      return fail('PST_PARAM_INVALID', 'cteReferenceC applies only with materialId', ['cteReferenceC']);
    const deltaK = params.toC - params.fromC;
    const warnings: { code: string; message: string }[] = [];
    let strain: number;
    let source: string;
    let grade: 'A' | 'B' | 'C';
    if (params.table !== undefined) {
      const from = carbonSteelStrain(params.fromC);
      const to = carbonSteelStrain(params.toC);
      if (from === null || to === null) {
        const [path, value] = from === null ? ['fromC', params.fromC] : ['toC', params.toC];
        return fail(
          'PST_TEMPERATURE_OUT_OF_TABLE',
          `${value} degC is outside the ${params.table} table (${TABLE_RANGE_C.minC.toFixed(1)} to ${TABLE_RANGE_C.maxC.toFixed(1)} degC)`,
          [path as string],
        );
      }
      strain = to.strain - from.strain;
      source = TABLE_SOURCE;
      grade = from.grade === 'A' && to.grade === 'A' ? 'A' : 'B';
      if (from.snapped || to.snapped)
        warnings.push({ code: 'PST_TABLE_EDGE_SNAPPED', message: 'a temperature within 0.25 K of a table row was taken at the row' });
    } else if (params.materialId !== undefined) {
      const basis: CteBasis =
        params.cteReferenceC === undefined ? { kind: 'unstated' } : { kind: 'secant', referenceKelvin: params.cteReferenceC + KELVIN };
      const provider = materialCteProvider(doc.materials, params.materialId, basis, 'materialId');
      if (isCteRefusal(provider))
        return fail(CODE_OF_CAUSE[provider.code] ?? 'PST_MATERIAL_NO_DATA', `${provider.reason} (${provider.code})`, [provider.path]);
      const result = provider.strainAt(params.toC + KELVIN, params.fromC + KELVIN);
      if (isCteRefusal(result))
        return fail(CODE_OF_CAUSE[result.code] ?? 'PST_MATERIAL_NO_DATA', `${result.reason} (${result.code})`, [result.path]);
      strain = result.strain;
      source = provider.source;
      grade = 'C';
      if (result.unverifiedReasons.length > 0)
        warnings.push({ code: 'PST_MATERIAL_UNVERIFIED', message: `unverified: ${result.unverifiedReasons.join('; ')}` });
    } else {
      strain = (params.meanCtePerK ?? 0) * deltaK;
      source = 'caller-supplied constant secant coefficient';
      grade = 'C';
      warnings.push({ code: 'PST_MATERIAL_UNVERIFIED', message: 'meanCtePerK is not a sourced material record' });
    }
    const meanAlpha = deltaK === 0 ? null : strain / deltaK;
    if (meanAlpha !== null && (Math.abs(meanAlpha) < 1e-6 || Math.abs(meanAlpha) > 5e-5))
      warnings.push({
        code: 'PST_CTE_IMPLAUSIBLE',
        message: `mean coefficient ${meanAlpha.toExponential(2)} /K is outside 1e-6..5e-5 /K (metals): check the unit`,
      });
    const growthMm = params.lengthM * 1000 * strain;
    return report(
      doc,
      `thermal_growth: ${params.lengthM} m from ${params.fromC} to ${params.toC} degC grows ${growthMm.toFixed(2)} mm (${(growthMm / params.lengthM).toFixed(4)} mm/m), grade ${grade}, ${source}.`,
      {
        growthMm,
        mmPerM: growthMm / params.lengthM,
        meanCtePerK: meanAlpha,
        strain,
        source,
        grade,
        warnings,
        reviewRequired: true,
        provenance: { method: 'length x thermal strain', source, inputs: params, defaulted: [] },
      },
    );
  },
});
