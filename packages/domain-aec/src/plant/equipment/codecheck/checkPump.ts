/**
 * Findings of `check_equipment` for one pump (plant 03 EQP §4, §7): the envelope table grade, vendor data left at a default, the missing weight, nozzle
 * flanges. A pump has no pressure-code check here (casing rating, hydraulics and nozzle loads are the vendor's: named in `notChecked`). Pure.
 */

import type { EquipmentElement } from '@aec/building/types';
import { issuesOf, warning, type ElementCheck, type Found } from './findings';
import { nozzleFindings } from './nozzleFindings';

const NOT_CHECKED = [
  'hydraulic duty, NPSH and driver sizing',
  'casing pressure rating',
  'nozzle loads (API 610 / ISO 5199 allowables)',
  'envelope dimensions against the vendor drawing',
];

/**
 * @param element a pump (`plant.template.kind === 'pump'`)
 * @invariant a table row below grade A, a defaulted driver / baseplate and a missing weight are warnings; reviewRequired is false (no pressure code was computed)
 */
export function checkPump(element: EquipmentElement): ElementCheck {
  const plant = element.plant;
  if (plant === undefined || plant.template.kind !== 'pump') return { issues: [], reviewRequired: false };
  const { template } = plant;
  const found: Found[] = [];
  if (template.envelope.grade !== 'A')
    found.push(
      warning(
        'EQP_TABLE_UNVERIFIED',
        `the envelope is a grade ${template.envelope.grade} table row (${template.envelope.source})`,
        'envelope',
      ),
    );
  if (template.defaulted.includes('driver'))
    found.push(warning('EQP_DESIGN_DATA_MISSING', 'no driver: the envelope has no motor box', 'driver'));
  if (template.defaulted.includes('baseplate'))
    found.push(warning('EQP_DESIGN_DATA_MISSING', 'baseplate sized by default (machine span + margins), not from a drawing', 'baseplate'));
  if (template.weightKg === undefined)
    found.push(warning('EQP_DESIGN_DATA_MISSING', 'no weightKg: the standards give no pump weight, floor loads see 0 kg', 'weightKg'));
  found.push(...nozzleFindings(template, plant.nozzles));
  return { issues: issuesOf(element, found), reviewRequired: false, notChecked: NOT_CHECKED };
}
