import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { Vec3 } from '@core/model/vectors';
import { toMetres } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { toWorld } from '../geometry/ports';
import { resolveVessel } from '../geometry/vesselFrame';
import { vesselCog, type CogState } from '../geometry/vesselCog';
import { refuse } from '../model';
import { equipmentRefParam, findEquipment } from './equipmentRef';

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant lumped-mass centre of the same parts as equipment_weights (empty.kg = total.emptyKg for the same include), heads at the exact centroid of their
 *   offset metal solid; operating liquid from design.operatingLiquid, test = full inside volume of water; positions in the equipment frame and in world
 * @failure unknown equipment -> EQP_NOT_FOUND; not a parametric vessel -> EQP_NOT_PARAMETRIC; invalid head -> EQP_HEAD_INVALID; operating liquid without a
 *   closed form or absent -> operating null with a warning, not a refusal
 */
export const equipmentCog = defineCommand({
  name: 'equipment_cog',
  description:
    'Query: centre of gravity of a parametric vessel (tag or id) for the empty, operating and hydrotest states, with the mass of each state (the same masses as ' +
    'equipment_weights: shell, heads, skirt / base ring / legs, insulation and internals from design.insulation / design.internals, plus nozzles when ' +
    'include has "nozzles"). Lumped masses: shell at mid-length, heads at the exact centroid of their offset metal solid, insulation layers, internals ' +
    'at their position (omitted: the middle of the shell, listed in defaulted), nozzles at the middle of their projection, operating liquid from ' +
    'design.operatingLiquid and the water of the test (full inside volume). Positions: local = equipment frame (origin = plan location at the level ' +
    'elevation, +Z up; horizontal vessels run along X), world = document coordinates, heightAboveLevel = local z. Returns empty / operating / test ' +
    '{ kg, local, world, heightAboveLevel }, parts[{ part, kg, local }], liquidParts[], defaulted[], approximations[], notIncluded[], warnings[]. ' +
    'Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC, EQP_HEAD_INVALID. Does not modify the document.',
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
    if (plant?.template.kind !== 'vessel')
      return refuse(
        doc,
        'equipment_cog',
        'EQP_NOT_PARAMETRIC',
        `${element.mark} (${element.id}) is not a parametric vessel: the centre of gravity covers vessels (columns) only`,
        [element.id],
        ['equipment'],
      );
    const geometry = resolveVessel(plant.template);
    if ('error' in geometry)
      return refuse(doc, 'equipment_cog', 'EQP_HEAD_INVALID', `equipment_cog: ${geometry.error}`, [element.id], [geometry.path]);
    const withNozzles = (include ?? ['body']).includes('nozzles');
    const cog = vesselCog(toMetres(doc, 1), plant.template, geometry, plant.design, withNozzles ? plant.nozzles : []);
    const level = building.levels[element.levelId] ?? { elevation: 0 };
    const place = (local: Vec3): { local: Vec3; world: Vec3 } => ({ local, world: toWorld(element, level, local) });
    const state = (value: CogState): object => ({ kg: value.kg, ...place(value.at), heightAboveLevel: value.at[2] });
    const warnings: Array<{ code: string; message: string; paths: string[] }> = [];
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
      notIncluded: ['saddle plates', 'lifting lugs, platform clips', 'weld metal', ...(withNozzles ? [] : ['nozzles (include "nozzles")'])],
    };
    const at = (value: CogState): string => `[${value.at.map((coordinate) => coordinate.toPrecision(7)).join(', ')}]`;
    return report(
      doc,
      `equipment_cog: ${element.mark} empty ${cog.empty.kg.toPrecision(8)} kg at ${at(cog.empty)}, operating ${cog.operating === null ? 'n/a' : `${cog.operating.kg.toPrecision(8)} kg at ${at(cog.operating)}`}, test ${cog.test.kg.toPrecision(8)} kg at ${at(cog.test)} (equipment frame).`,
      data,
    );
  },
});
