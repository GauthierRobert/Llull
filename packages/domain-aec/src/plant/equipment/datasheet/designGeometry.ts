/** Design-data and geometry sections of the equipment data sheet (plant 03 EQP §6): the stored template and design, lengths in millimetres. */

import type { EquipmentElement } from '@aec/building/types';
import { headInsideArea } from '../geometry/heads';
import { resolveVessel } from '../geometry/vesselFrame';
import type { ExchangerSideDesign, PlantEquipmentData, VesselDesignData } from '../plantData';
import { millimetres, toMillimetres, type Obj } from './millimetres';

const quantity = (value: { value: number; unit: string; source?: string | undefined } | undefined): Obj | null =>
  value === undefined ? null : { value: value.value, unit: value.unit, ...(value.source === undefined ? {} : { source: value.source }) };

/** Design inputs a code check cannot do without: listed in `missing` when absent, never defaulted. */
const REQUIRED_INPUTS = ['pressure', 'temperatureC', 'material', 'allowableStress', 'jointEfficiency'] as const;

function pressureDesign(design: VesselDesignData | ExchangerSideDesign | undefined, mm: number): Obj {
  return {
    pressure: quantity(design?.pressure),
    temperatureC: design?.temperatureC ?? null,
    material: design?.material ?? null,
    allowableStress: quantity(design?.allowableStress),
    allowableStressAtTest: quantity(design?.allowableStressAtTest),
    jointEfficiency: design?.jointEfficiency ?? null,
    ...(design !== undefined && 'operatingLiquid' in design ? { operatingLiquid: toMillimetres(design.operatingLiquid ?? null, mm) } : {}),
    ...(design !== undefined && 'specificGravity' in design ? { specificGravity: design.specificGravity ?? null } : {}),
    missing: REQUIRED_INPUTS.filter((key) => design?.[key] === undefined),
  };
}

export function designOf(plant: PlantEquipmentData, mm: number): Obj {
  const { template } = plant;
  switch (template.kind) {
    case 'vessel':
      return {
        ...pressureDesign(plant.design, mm),
        materialDensityKgM3: plant.design?.materialDensityKgM3 ?? null,
        corrosionAllowanceMm: millimetres(template.corrosionAllowance, mm),
      };
    case 'exchanger':
      return {
        shellSide: pressureDesign(template.design?.shellSide, mm),
        tubeSide: pressureDesign(template.design?.tubeSide, mm),
        materialDensityKgM3: template.design?.materialDensityKgM3 ?? null,
        corrosionAllowanceMm: millimetres(template.corrosionAllowance, mm),
      };
    case 'tank':
      return toMillimetres(template.design, mm) as Obj;
    case 'pump':
      return {
        standard: template.standard,
        size: template.size ?? null,
        api610Type: template.api610Type ?? null,
        rating: template.envelope.rating,
      };
    case 'block':
      return {};
  }
}

/** Inside surface of a vessel (shell + both heads), m2: the take-off for lining and painting of the inside. */
function insideAreaM2(plant: PlantEquipmentData, mm: number): number | null {
  if (plant.template.kind !== 'vessel') return null;
  const geometry = resolveVessel(plant.template);
  if ('error' in geometry) return null;
  const area =
    2 * Math.PI * geometry.radius * geometry.length +
    headInsideArea(geometry.first, geometry.radius) +
    headInsideArea(geometry.second, geometry.radius);
  return Math.round(area * (mm / 1000) ** 2 * 1e9) / 1e9;
}

export function geometryOf(element: EquipmentElement, plant: PlantEquipmentData, mm: number): Obj {
  const { kind, ...rest } = plant.template;
  const area = insideAreaM2(plant, mm);
  return {
    kind,
    ...(toMillimetres(rest, mm) as Obj),
    ...(area === null ? {} : { insideSurfaceAreaM2: area }),
    boundingBoxMm: element.size.map((value) => millimetres(value, mm)),
  };
}
