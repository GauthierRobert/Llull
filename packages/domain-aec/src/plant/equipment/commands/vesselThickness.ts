import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { asmeThickness, type AsmeResult, type ComponentResult } from '../codecheck/asme';
import { refuse } from '../model';
import { equipmentRefParam, findEquipment } from './equipmentRef';
import { pressureSchema } from './vesselParams';

export const REVIEW_REASON = 'ASME VIII-1 thickness computed by llull from the cited formulas; not a stamped design';

const FORMULA_SOURCE =
  'ASME BPVC VIII-1 UG-27(c), UG-32, UG-99(b): formulas as printed in public sources S6-S12 (validation/sources.md); the Code itself is paywalled';

/** The components of an `AsmeResult` that were computed, keyed by part. */
export const computedParts = (result: AsmeResult): ComponentResult[] =>
  result.parts.flatMap((part) => ('result' in part ? [part.result] : []));

/** MAWP of the vessel (minimum over parts) and the part that governs it. */
export function governingMawp(components: readonly ComponentResult[]): { mawpMPa: number; component: string } {
  const applicable = components.filter((component) => component.mawpUnverified !== true);
  let best = (applicable[0] ?? components[0]) as ComponentResult;
  for (const component of applicable) if (component.mawpMPa < best.mawpMPa) best = component;
  return { mawpMPa: best.mawpMPa, component: best.key };
}

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant corroded dimensions (R + CA, D + 2 CA, L + CA; available = nominal - CA) unless corrodedDimensions:false; S and E are never
 *   defaulted; MAWP is the minimum over the parts, at the top; hydrotest = 1.3 x MAWP x (S_test / S_design, 1 and defaulted when S_test is
 *   absent); reviewRequired is always true; an unsourced S sets unverified (grade B/C head standards are not covered, so they refuse instead)
 * @failure no equipment -> EQP_NOT_FOUND; legacy block -> EQP_NOT_PARAMETRIC; no P / S / E -> EQP_DESIGN_DATA_MISSING / EQP_ALLOWABLE_MISSING;
 *   P > 0.385 S E, required t > R/2, hemispherical t > 0.356 L with P > 0.665 S E -> EQP_FORMULA_OUT_OF_RANGE; head type without a formula -> EQP_HEAD_NOT_COVERED; refusals leave the document unchanged
 */
export const vesselThickness = defineCommand({
  name: 'vessel_thickness',
  description:
    'Query: ASME VIII-1 internal-pressure thickness of a parametric vessel (tag or id): required thickness, available thickness and MAWP of the shell ' +
    '(UG-27(c)(1) circumferential, longitudinal UG-27(c)(2) reported) and of each head (UG-32: 2:1 ellipsoidal, ASME flanged-and-dished torispherical, ' +
    'hemispherical), the vessel MAWP (minimum over parts, at the top; staticHeadMPa reports the operating-liquid column) and the UG-99(b) ' +
    'hydrotest pressure (1.3 x MAWP x S_test/S_design). Uses design.pressure, design.allowableStress and design.jointEfficiency of the vessel; S and ' +
    'E are NEVER defaulted. Dimensions are corroded by default (R + CA); corrodedDimensions:false reproduces sources that use the uncorroded radius. ' +
    '`pressure` overrides the design pressure for this call only. Returns components{shell, headBottom/headTop or headLeft/headRight}{ ' +
    'requiredThicknessMm (with CA), requiredCorrodedThicknessMm, nominalThicknessMm, availableThicknessMm (nominal - CA), mawpMPa, status, failures, ' +
    'formula, clause, inputs}, mawpMPa, governingComponent, hydrotestPressureMPa, status (fail | pass_with_review), warnings, unverified, ' +
    'reviewRequired (always true: a computed check is not a stamped design) and provenance. Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC, ' +
    'EQP_DESIGN_DATA_MISSING, EQP_ALLOWABLE_MISSING, EQP_FORMULA_OUT_OF_RANGE (P > 0.385 S E, required t > R/2, hemisphere limits: needs an engineer; a shell thicker than R/2 only flags its MAWP mawpUnverified), EQP_HEAD_NOT_COVERED. ' +
    'Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    equipment: equipmentRefParam,
    corrodedDimensions: z
      .boolean()
      .optional()
      .describe(
        'Default true: radius R + CA and available thickness nominal - CA. false: the uncorroded radius (some published examples).',
      ),
    pressure: pressureSchema.optional().describe('Internal design pressure, gauge, replacing design.pressure for this call (what-if).'),
  }),
  run: (doc, { equipment, corrodedDimensions, pressure }): CommandResult => {
    const element = findEquipment(getBuilding(doc), equipment);
    if (element === undefined)
      return refuse(doc, 'vessel_thickness', 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    if (element.plant?.template.kind !== 'vessel')
      return refuse(
        doc,
        'vessel_thickness',
        'EQP_NOT_PARAMETRIC',
        `${element.mark} (${element.id}) is not a parametric vessel`,
        [element.id],
        ['equipment'],
      );
    const corroded = corrodedDimensions ?? true;
    const result = asmeThickness(element.plant, { mmPerUnit: MM_PER_UNIT[doc.units], corroded, pressure });
    if ('refusal' in result)
      return refuse(
        doc,
        'vessel_thickness',
        result.refusal.code,
        `vessel_thickness: ${result.refusal.message}`,
        [element.id],
        result.refusal.paths,
      );
    const refused = result.parts.find((part) => 'refusal' in part);
    if (refused !== undefined && 'refusal' in refused)
      return refuse(
        doc,
        'vessel_thickness',
        refused.refusal.code,
        `vessel_thickness: ${refused.key}: ${refused.refusal.message}`,
        [element.id],
        refused.refusal.paths,
      );
    const components = computedParts(result);
    const { mawpMPa, component } = governingMawp(components);
    const hydrotestPressureMPa = 1.3 * mawpMPa * result.hydrotest.ratio;
    const failures = components.flatMap((part) => part.failures.map((code) => ({ component: part.key, code })));
    const status = failures.length > 0 ? 'fail' : 'pass_with_review';
    const unverified = result.warnings.length > 0;
    const data = {
      equipment: element.mark,
      elementId: element.id,
      corrodedDimensions: corroded,
      designPressureMPa: result.pressureMPa,
      components: Object.fromEntries(components.map((part) => [part.key, part])),
      mawpMPa,
      governingComponent: component,
      hydrotestPressureMPa,
      hydrotest: {
        clause: 'UG-99(b)',
        factor: 1.3,
        stressRatio: result.hydrotest.ratio,
        stressRatioDefaulted: result.hydrotest.ratioDefaulted,
      },
      staticHeadMPa: result.staticHeadMPa,
      status,
      failures,
      warnings: result.warnings,
      unverified,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
      provenance: {
        formulas: FORMULA_SOURCE,
        allowableStressMPa: result.allowableStressMPa,
        allowableStressSource: result.allowableStressSource,
        jointEfficiency: result.jointEfficiency,
        units: 'mm, MPa; pressures gauge',
      },
    };
    const flag = unverified ? ' (unverified inputs, see warnings)' : '';
    return report(
      doc,
      `vessel_thickness: ${element.mark} P ${result.pressureMPa.toPrecision(6)} MPa, MAWP ${mawpMPa.toPrecision(8)} MPa (${component}), hydrotest ${hydrotestPressureMPa.toPrecision(8)} MPa, ${status}${failures.length > 0 ? ` (${failures.map((f) => `${f.component} ${f.code}`).join(', ')})` : ''}; review required${flag}.`,
      data,
    );
  },
});
