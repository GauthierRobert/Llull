import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { Vec3 } from '@core/model/vectors';
import { toMetres } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { toWorld } from '../geometry/ports';
import { resolveVessel } from '../geometry/vesselFrame';
import { vesselCog, type CogState, type VesselCog } from '../geometry/vesselCog';
import { refuse } from '../model';
import { equipmentRefParam, findEquipment } from './equipmentRef';
import { otherEquipmentCog } from './otherCogResult';

interface Warning {
  code: string;
  message: string;
  paths: string[];
}

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant lumped-mass centre of the same parts as equipment_weights (empty.kg = total.emptyKg for the same include), vessel heads at the exact centroid of
 *   their offset metal solid; operating liquid from design.operatingLiquid (vessel), the sides' specificGravity (exchanger) or design.designLiquidLevel (tank),
 *   test = full inside volume of water; a pump is its vendor weight at the centre of the machine envelope; positions in the equipment frame and in world
 * @failure unknown equipment -> EQP_NOT_FOUND; legacy block -> EQP_NOT_PARAMETRIC; invalid head -> EQP_HEAD_INVALID; pump without weightKg ->
 *   EQP_DESIGN_DATA_MISSING; operating liquid without a closed form or absent -> operating null with a warning, not a refusal
 */
export const equipmentCog = defineCommand({
  name: 'equipment_cog',
  description:
    'Query: centre of gravity of a parametric vessel, heat exchanger, storage tank or pump (tag or id) for the empty, operating and hydrotest states, with the ' +
    'mass of each state (the same masses as equipment_weights: shell, heads, supports, insulation and internals from design.insulation / design.internals ' +
    '(vessels), tubes, tubesheets and channels (exchangers), courses, bottom and roof (tanks), plus nozzles when include has "nozzles"). Lumped masses: ' +
    'each part at the centroid of its solid (vessel heads at the exact centroid of their offset metal solid, a tank roof at the centroid of its surface), ' +
    'nozzles at the middle of their projection, the operating liquid (vessel design.operatingLiquid, exchanger sides with a specificGravity, tank ' +
    'design.designLiquidLevel) and the water of the test (full inside volume). A pump is its vendor weightKg lumped at the centre of the pump + driver ' +
    'envelope boxes (an approximation, listed in defaulted). Positions: local = equipment frame (origin = plan location at the level elevation, +Z up; ' +
    'horizontal vessels and exchangers run along X), world = document coordinates, heightAboveLevel = local z. Returns empty / operating / test ' +
    '{ kg, local, world, heightAboveLevel }, parts[{ part, kg, local }], liquidParts[], defaulted[], approximations[], notIncluded[], warnings[]. ' +
    'Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC (legacy block), EQP_HEAD_INVALID, EQP_DESIGN_DATA_MISSING (pump without weightKg). Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    equipment: equipmentRefParam,
    include: z
      .array(z.enum(['body', 'nozzles']))
      .min(1)
      .optional()
      .describe('Parts to include. Default ["body"]; "nozzles" adds neck + flange of every nozzle to every state.'),
  }),
  run: (doc, { equipment, include }): CommandResult => {
    const building = getBuilding(doc);
    const element = findEquipment(building, equipment);
    if (element === undefined)
      return refuse(doc, 'equipment_cog', 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    const plant = element.plant;
    const withNozzles = (include ?? ['body']).includes('nozzles');
    const level = building.levels[element.levelId] ?? { elevation: 0 };
    const place = (local: Vec3): { local: Vec3; world: Vec3 } => ({ local, world: toWorld(element, level, local) });
    const state = (value: CogState): object => ({ kg: value.kg, ...place(value.at), heightAboveLevel: value.at[2] });
    const at = (value: CogState): string => `[${value.at.map((coordinate) => coordinate.toPrecision(7)).join(', ')}]`;
    const answer = (cog: VesselCog, warnings: Warning[], notIncluded: string[]): CommandResult => {
      const data = {
        equipment: element.mark,
        elementId: element.id,
        empty: state(cog.empty),
        operating: cog.operating === null ? null : state(cog.operating),
        test: state(cog.test),
        parts: cog.parts.map((part) => ({ part: part.part, kg: part.kg, local: part.at })),
        liquidParts: cog.liquidParts.map((part) => ({ part: part.part, kg: part.kg, local: part.at })),
        defaulted: cog.defaulted,
        approximations: cog.approximations,
        warnings,
        notIncluded: [...notIncluded, ...(withNozzles ? [] : ['nozzles (include "nozzles")'])],
      };
      const operating = cog.operating === null ? 'n/a' : `${cog.operating.kg.toPrecision(8)} kg at ${at(cog.operating)}`;
      return report(
        doc,
        `equipment_cog: ${element.mark} empty ${cog.empty.kg.toPrecision(8)} kg at ${at(cog.empty)}, operating ${operating}, test ${cog.test.kg.toPrecision(8)} kg at ${at(cog.test)} (equipment frame).`,
        data,
      );
    };
    if (plant?.template.kind !== 'vessel') {
      const other = otherEquipmentCog(doc, element, withNozzles);
      if (other === null)
        return refuse(
          doc,
          'equipment_cog',
          'EQP_NOT_PARAMETRIC',
          `${element.mark} (${element.id}) is a legacy block: the centre of gravity covers parametric vessels, exchangers, tanks and pumps`,
          [element.id],
          ['equipment'],
        );
      if ('missing' in other) return refuse(doc, 'equipment_cog', 'EQP_DESIGN_DATA_MISSING', other.missing, [element.id], ['weightKg']);
      return answer(other.cog, other.warnings, other.notIncluded);
    }
    const geometry = resolveVessel(plant.template);
    if ('error' in geometry)
      return refuse(doc, 'equipment_cog', 'EQP_HEAD_INVALID', `equipment_cog: ${geometry.error}`, [element.id], [geometry.path]);
    const cog = vesselCog(toMetres(doc, 1), plant.template, geometry, plant.design, withNozzles ? plant.nozzles : []);
    const warnings: Warning[] = [];
    if (plant.design?.operatingLiquid === undefined)
      warnings.push({
        code: 'EQP_DESIGN_DATA_MISSING',
        message: 'no operating liquid: the operating state is not computed',
        paths: ['design.operatingLiquid'],
      });
    else if (cog.operating === null)
      warnings.push({
        code: 'EQP_HEAD_NOT_COVERED',
        message: 'operating liquid of a horizontal vessel with a torispherical head has no closed form at this level (V1)',
        paths: ['design.operatingLiquid.levelAboveBottomTangent'],
      });
    return answer(cog, warnings, ['saddle plates', 'lifting lugs, platform clips', 'weld metal']);
  },
});
