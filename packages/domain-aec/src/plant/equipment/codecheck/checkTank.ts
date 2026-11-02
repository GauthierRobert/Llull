/**
 * Findings of `check_equipment` for one API 650 tank (plant 03 EQP §4, §7): the one-foot governing thickness of every course against the nominal plate
 * thickness (a fail only when the thicknesses are the user's), unverified table rows, unsourced allowables, thicknesses that are not an input, nozzle
 * layout. Pure; the findings are data.
 */

import type { EquipmentElement } from '@aec/building/types';
import type { TankTemplate } from '../plantData';
import { issuesOf, warning, type ElementCheck, type Found } from './findings';
import { nozzleFindings } from './nozzleFindings';
import { API650_REVIEW_REASON, tankShellResult } from './tankShell';

const NOT_CHECKED = [
  'roof and roof-to-shell joint',
  'bottom and annular plate',
  'wind and seismic loads (overturning, anchorage, buckling)',
  'shell openings (nozzle reinforcement)',
  'foundation and settlement',
];

const PATHS: Readonly<Record<string, string>> = {
  designLiquidLevel: 'design.designLiquidLevel',
  material: 'design.material',
  'allowableStress.source': 'design.allowableStress.source',
};

/** Fail / warning findings of the shell courses of `template` (`mmPerUnit` = millimetres per document unit). */
function shellFindings(template: TankTemplate, mmPerUnit: number): Found[] {
  const result = tankShellResult(
    {
      diameter: template.diameter,
      shellHeight: template.shellHeight,
      courses: template.courses,
      designLiquidLevel: template.design.designLiquidLevel,
      specificGravity: template.design.specificGravity,
      material: template.design.material,
      corrosionAllowance: template.design.corrosionAllowance,
      allowableStress: template.design.allowableStress,
    },
    mmPerUnit,
  );
  if ('refusal' in result) {
    const { code, message, paths } = result.refusal;
    return [warning(code, `shell courses not judged: ${message}`, ...paths.map((path) => PATHS[path] ?? path))];
  }
  const found: Found[] = result.warnings.map((note) => warning(note.code, note.message, ...note.paths.map((path) => PATHS[path] ?? path)));
  if (template.thicknessSource !== 'user') {
    found.push(
      warning(
        'EQP_DESIGN_DATA_MISSING',
        `courseThicknesses were not given: the plates are the ${template.thicknessSource === 'one_foot' ? 'one-foot governing' : 'minimum'} thicknesses, so there is nothing to check against`,
        'courseThicknesses',
      ),
    );
    return found;
  }
  result.courses.forEach((course, index) => {
    const nominal = (template.courseThicknesses[index] as number) * mmPerUnit;
    if (nominal < course.governingThicknessMm * (1 - 1e-9))
      found.push({
        severity: 'fail',
        finding: {
          code: 'EQP_SHELL_UNDER_THICKNESS',
          message: `course ${course.course} nominal thickness ${nominal.toPrecision(6)} mm is below the API 650 governing ${course.governingThicknessMm.toPrecision(6)} mm (${course.governing})`,
          paths: [`courseThicknesses.${index}`],
        },
      });
  });
  return found;
}

/**
 * @param element a tank (`plant.template.kind === 'tank'`)
 * @invariant fails only on a user-given course thickness below the one-foot governing thickness; a tank the one-foot method cannot judge (D > 60 m, material outside
 *   the table without S_d / S_t) or whose thicknesses are derived is a warning, never a pass; reviewRequired is always true (tank design beyond the shell courses is not judged)
 */
export function checkTank(element: EquipmentElement, mmPerUnit: number): ElementCheck {
  const plant = element.plant;
  if (plant === undefined || plant.template.kind !== 'tank') return { issues: [], reviewRequired: false };
  const shell = shellFindings(plant.template, mmPerUnit);
  const found: Found[] = [...shell, ...nozzleFindings(plant.template, plant.nozzles)];
  return { issues: issuesOf(element, found), reviewRequired: true, reviewReason: API650_REVIEW_REASON, notChecked: NOT_CHECKED };
}
