import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { MM_PER_UNIT, toMetres } from '@core/model/units';
import { courseBottoms, roofRise, tankLiquidVolume } from '../geometry/tankFrame';
import { refuse } from '../model';
import { buildTankTemplate, tankShape } from './tankParams';
import { isVesselIssue } from './vesselParams';
import { commitNewEquipment, levelContext, locationParam, newEquipmentElement, placementShape } from './newEquipment';

/**
 * @affects creates 1 equipment element (plant template 'tank') plus derived revolutions (bottom, one ring per course, roof) on layer Q-EQPM tagged element:<id>
 * @invariant size / shape / weight of the element are re-derived from `plant` in the same command; ids are step-scoped (L8); `diameter` is the inside diameter
 *   (the wall grows outward) and levels count from the top of the bottom plate; without courseThicknesses each course takes its API 650 one-foot governing
 *   thickness (named default, `thicknessSource`)
 * @failure duplicate tag, courses not adding up (EQP_COURSES_MISMATCH), D > 60 m or a material outside Table 5-2a without courseThicknesses (EQP_API650_ONE_FOOT_LIMIT
 *   / EQP_MATERIAL_NOT_IN_TABLE), bad roof or thicknesses -> coded refusal with the param path
 */
export const addStorageTank = defineCommand({
  name: 'add_storage_tank',
  description:
    'Create a parametric API 650 vertical atmospheric storage tank (equipment element with a tag): flat bottom, a shell of stacked courses, a cone / dome / flat fixed ' +
    'roof. Lengths are document units; diameter is the INSIDE (nominal) diameter, the wall grows outward, liquid levels count from the top of the bottom plate. ' +
    'courses = heights from the bottom and must add up to shellHeight (EQP_COURSES_MISMATCH). courseThicknesses = nominal plate thickness per course; omit it ' +
    'and each course takes its API 650 one-foot-method governing thickness (needs design.material in Table 5-2a - A283M Gr C, A36M, A516-70 - or ' +
    'design.allowableStress, and D <= 60 m), which check_equipment then flags as not an input. roof { type: cone + slopeRatio "1:12" | dome + radius | flat, ' +
    'thickness }, bottom { annularPlate (stored only), thickness }; roof 5 mm and bottom 6 mm are named defaults. design { specificGravity, designLiquidLevel, ' +
    'material, corrosionAllowance, allowableStress { design, test, source }, materialDensityKgM3 }. The legacy size / shape / weight are re-derived (weight = empty + ' +
    'liquid at the design level). Next: add_nozzle with location { on: "shell", elevation above the shell base, orientationDeg } or { on: "free" } for the roof ' +
    '(ports "<tag>:<mark>"), tank_shell_thickness { equipment }, vessel_volume { equipment, levels }, equipment_weights, check_equipment. Returns elementId, tag, ' +
    'courses[{ course, height, bottom, thickness }], thicknessSource (user | one_foot | minimum), roofRise, volumes, defaulted[], weightKg, angleConvention.',
  params: z.object({ ...placementShape, location: locationParam('the tank axis'), ...tankShape }),
  run: (doc, params): CommandResult => {
    const context = levelContext(doc, 'add_storage_tank', params.levelId);
    if (!context.ok) return context.result;
    const built = buildTankTemplate(params, doc.units);
    if (isVesselIssue(built)) return refuse(doc, 'add_storage_tank', built.code, built.message, [], [built.path]);
    const created = newEquipmentElement(doc, 'add_storage_tank', context, params, built.template, []);
    if (!created.ok) return created.result;
    const { template } = built;
    const { element } = created;
    const cubic = toMetres(doc, 1) ** 3;
    const bottoms = courseBottoms(template);
    const totalM3 = tankLiquidVolume(template, template.shellHeight) * cubic;
    return commitNewEquipment(
      doc,
      context.building,
      element,
      `add_storage_tank: ${element.mark} "${element.name}" (${element.id}) API 650 tank D ${template.diameter} x ${template.shellHeight} in ${template.courses.length} course(s), ` +
        `${template.roof.type} roof, shell ${totalM3.toFixed(3)} m3, thicknesses ${template.thicknessSource === 'user' ? 'given' : `from the ${template.thicknessSource === 'one_foot' ? 'one-foot method' : 'minimum'} (default)`}, ` +
        `${element.weight.toFixed(1)} kg operating${built.defaulted.length > 0 ? `; defaults: ${built.defaulted.join(', ')}` : ''}.`,
      {
        courses: template.courses.map((height, index) => ({
          course: index + 1,
          height,
          bottom: bottoms[index] as number,
          thickness: template.courseThicknesses[index] as number,
          thicknessMm: (template.courseThicknesses[index] as number) * MM_PER_UNIT[doc.units],
        })),
        thicknessSource: template.thicknessSource,
        roofRise: roofRise(template),
        volumes: { shellM3: totalM3, designLiquidM3: tankLiquidVolume(template, template.design.designLiquidLevel) * cubic },
        defaulted: built.defaulted,
        notes: created.notes,
      },
      params.angleConvention ?? 'north_cw',
    );
  },
});
