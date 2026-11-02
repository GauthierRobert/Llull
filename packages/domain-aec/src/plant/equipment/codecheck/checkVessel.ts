/**
 * Findings of `check_equipment` for one vessel (plant 03 EQP §4, §7): ASME VIII-1 under-thickness / MAWP failures, covered-by-the-formulas
 * warnings, nozzle layout warnings, unverified or unsourced inputs, placeholder flanges. Pure; the findings are data, never refusals.
 */

import type { EquipmentElement } from '@aec/building/types';
import { resolveVessel } from '../geometry/vesselFrame';
import { asmeThickness } from './asme';
import { COVERAGE_CODES, issuesOf, type ElementCheck, type Found } from './findings';
import { nozzleFindings } from './nozzleFindings';

/**
 * @param element a vessel (`plant.template.kind === 'vessel'`)
 * @invariant fails only on computed under-thickness / MAWP below design; a part the formulas do not cover is a warning, never a pass
 */
export function checkVessel(element: EquipmentElement, mmPerUnit: number): ElementCheck {
  const plant = element.plant;
  if (plant === undefined || plant.template.kind !== 'vessel') return { issues: [], reviewRequired: false };
  const found: Found[] = [];
  const result = asmeThickness(plant, { mmPerUnit, corroded: true });
  let reviewRequired = false;
  if ('refusal' in result) {
    const code = COVERAGE_CODES.includes(result.refusal.code) ? result.refusal.code : 'EQP_PARAM_INVALID';
    found.push({ severity: 'warning', finding: { ...result.refusal, code } });
    const stress = plant.design?.allowableStress;
    if (stress !== undefined && (stress.source === undefined || stress.source === ''))
      found.push({
        severity: 'warning',
        finding: { code: 'EQP_VALUE_UNSOURCED', message: 'allowable stress S has no source', paths: ['design.allowableStress.source'] },
      });
  } else {
    for (const part of result.parts) {
      if ('refusal' in part)
        found.push({ severity: 'warning', finding: { ...part.refusal, message: `${part.key}: ${part.refusal.message}` } });
      else {
        reviewRequired = true;
        for (const code of part.result.failures) {
          const text =
            code === 'EQP_MAWP_BELOW_DESIGN'
              ? `${part.key} MAWP ${part.result.mawpMPa.toPrecision(6)} MPa is below the design pressure ${result.pressureMPa} MPa`
              : `${part.key} available thickness ${part.result.availableThicknessMm.toPrecision(6)} mm is below the required ${part.result.requiredCorrodedThicknessMm.toPrecision(6)} mm (corroded)`;
          found.push({
            severity: 'fail',
            finding: { code, message: text, paths: [part.key === 'shell' ? 'shellThickness' : 'headThickness'] },
          });
        }
      }
    }
    for (const warning of result.warnings) found.push({ severity: 'warning', finding: warning });
  }
  const geometry = resolveVessel(plant.template);
  if (!('error' in geometry) && geometry.unverified)
    found.push({
      severity: 'warning',
      finding: { code: 'EQP_TABLE_UNVERIFIED', message: 'a head standard row below grade A gives the head proportions', paths: ['heads'] },
    });
  found.push(...nozzleFindings(plant.template, plant.nozzles));
  return { issues: issuesOf(element, found), reviewRequired };
}
