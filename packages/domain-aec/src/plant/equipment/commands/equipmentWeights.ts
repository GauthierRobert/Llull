import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { toMetres } from '@core/model/units';
import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import { getBuilding } from '../../../building/model';
import { nozzleMassParts } from '../geometry/nozzleMass';
import { resolveVessel } from '../geometry/vesselFrame';
import { TEST_WATER_KG_PER_M3, vesselMass } from '../geometry/vesselMass';
import { refuse } from '../model';
import { equipmentRefParam, findEquipment } from './equipmentRef';
import { otherEquipmentWeights } from './otherWeights';

const sum = (parts: readonly { kg: number }[]): number => parts.reduce((total, part) => total + part.kg, 0);

/**
 * @affects none (query: returns the same document; results in `data`)
 * @invariant one source of truth with the legacy `weight` field (body.operatingKg); heads are exact offset solids, never area x t; test = empty +
 *   full inside volume x 1000 kg/m3 (named default); density default 7850 is reported in `defaulted`; saddle plates are not part of the body
 * @failure unknown equipment -> EQP_NOT_FOUND; legacy block -> EQP_NOT_PARAMETRIC; invalid head -> EQP_HEAD_INVALID; no operating liquid or a level
 *   without a closed form -> operatingKg null with a warning (EQP_DESIGN_DATA_MISSING / EQP_HEAD_NOT_COVERED), not a refusal
 */
export const equipmentWeights = defineCommand({
  name: 'equipment_weights',
  description:
    'Query: empty, operating and hydrotest weights of a parametric vessel, exchanger, tank or pump (tag or id; exchangers: shell, channels, bonnets, tubesheets, tubes, both sides full ' +
    'at their specific gravity; tanks: courses, bottom, roof plate, liquid at the design level; pumps: the vendor weightKg, EQP_DESIGN_DATA_MISSING without it). Vessels:  body = shell annulus + both formed heads (exact solid between ' +
    'the inside profile and its outward offset by the head thickness) + skirt / base ring / legs, at the metal density of design.materialDensityKgM3 ' +
    '(default 7850 kg/m3, listed in `defaulted`). operatingKg = empty + liquid volume of design.operatingLiquid x specific gravity x 1000 (null when no ' +
    'operating liquid is set, with a warning); testKg = empty + the full inside volume x 1000 kg/m3 of water. include: "body" (default) and/or ' +
    '"nozzles" (neck beyond the outside wall + weld-neck flange per nozzle, flange rows from the piping catalogue; placeholders are listed in ' +
    '`defaulted`); saddle plates, trays, insulation and internals are not modelled. Returns body{emptyKg, operatingKg, testKg}, nozzles{kg} ' +
    '(when included), total{emptyKg, operatingKg, testKg} (body + requested parts), breakdown[{part, kg, method}], defaulted[], warnings[], ' +
    'unverified. Refusals: EQP_NOT_FOUND, EQP_NOT_PARAMETRIC, EQP_HEAD_INVALID. Does not modify the document.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    equipment: equipmentRefParam,
    include: z
      .array(z.enum(['body', 'nozzles']))
      .min(1)
      .optional()
      .describe('Parts of the equipment to weigh. Default ["body"]. "nozzles" adds neck + flange of every nozzle to `total`.'),
  }),
  run: (doc, { equipment, include }): CommandResult => {
    const element = findEquipment(getBuilding(doc), equipment);
    if (element === undefined)
      return refuse(doc, 'equipment_weights', 'EQP_NOT_FOUND', `no equipment with tag or id '${equipment}'`, [], ['equipment']);
    const other = otherEquipmentWeights(doc, element, include ?? ['body']);
    if (other !== null) return other;
    const plant = element.plant;
    if (plant?.template.kind !== 'vessel')
      return refuse(
        doc,
        'equipment_weights',
        'EQP_NOT_PARAMETRIC',
        `${element.mark} (${element.id}) is not a parametric vessel`,
        [element.id],
        ['equipment'],
      );
    const geometry = resolveVessel(plant.template);
    if ('error' in geometry)
      return refuse(doc, 'equipment_weights', 'EQP_HEAD_INVALID', `equipment_weights: ${geometry.error}`, [element.id], [geometry.path]);
    const scale = toMetres(doc, 1);
    const mass = vesselMass(scale, plant.template, geometry, plant.design);
    const parts = new Set(include ?? ['body']);
    const nozzleParts = parts.has('nozzles') ? nozzleMassParts(scale, geometry, plant.nozzles, mass.densityKgM3) : [];
    const nozzlesKg = sum(nozzleParts);
    const defaulted: string[] = [];
    const warnings: Array<{ code: string; message: string; paths: string[] }> = [];
    if (mass.densityDefaulted) defaulted.push(`materialDensityKgM3 = ${STEEL_DENSITY_KG_PER_M3} kg/m3 (steel, named default)`);
    defaulted.push(`test water density = ${TEST_WATER_KG_PER_M3} kg/m3 (named default)`);
    for (const nozzle of plant.nozzles) {
      if (parts.has('nozzles') && nozzle.flange.placeholder)
        defaulted.push(`nozzle ${nozzle.mark}: flange is a placeholder (no catalogue row)`);
    }
    if (plant.design?.operatingLiquid === undefined)
      warnings.push({
        code: 'EQP_DESIGN_DATA_MISSING',
        message: 'no operating liquid: operatingKg equals emptyKg',
        paths: ['design.operatingLiquid'],
      });
    else if (mass.operatingKg === null)
      warnings.push({
        code: 'EQP_HEAD_NOT_COVERED',
        message: 'operating liquid of a horizontal vessel with a torispherical head has no closed form at this level (V1)',
        paths: ['design.operatingLiquid.levelAboveBottomTangent'],
      });
    const unverified = parts.has('nozzles') && plant.nozzles.some((nozzle) => nozzle.flange.unverified || nozzle.flange.placeholder);
    const operatingKg = mass.operatingKg ?? mass.emptyKg;
    const data = {
      equipment: element.mark,
      elementId: element.id,
      body: { emptyKg: mass.emptyKg, operatingKg: mass.operatingKg ?? mass.emptyKg, testKg: mass.testKg },
      ...(parts.has('nozzles') ? { nozzles: { kg: nozzlesKg } } : {}),
      total: { emptyKg: mass.emptyKg + nozzlesKg, operatingKg: operatingKg + nozzlesKg, testKg: mass.testKg + nozzlesKg },
      operatingLiquidM3: mass.operatingLiquidM3,
      totalVolumeM3: mass.totalVolumeM3,
      breakdown: [...mass.parts, ...nozzleParts],
      densityKgM3: mass.densityKgM3,
      defaulted,
      warnings,
      unverified,
      notIncluded: ['saddle plates', 'trays and other internals', 'insulation', 'lifting lugs, platform clips'],
    };
    return report(
      doc,
      `equipment_weights: ${element.mark} empty ${data.total.emptyKg.toPrecision(8)} kg, operating ${data.total.operatingKg.toPrecision(8)} kg, test ${data.total.testKg.toPrecision(8)} kg (${[...parts].join(' + ')}).`,
      data,
    );
  },
});
