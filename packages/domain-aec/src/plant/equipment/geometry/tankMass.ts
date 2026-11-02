/**
 * Mass of an API 650 tank (plant 03 EQP §5.3): course annuli, bottom plate and roof plate (thin plate: area x thickness), the liquid of the design
 * level and of a full-shell water test. One source for `equipment_weights` and the legacy `weight` field. Rim angle, stiffeners, roof framing and
 * appurtenances are not modelled.
 */

import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { TankTemplate } from '../plantData';
import { courseBottoms, eaveRadius, roofRise, tankLiquidVolume } from './tankFrame';
import { TEST_WATER_KG_PER_M3, type MassPart } from './vesselMass';

export interface TankMass {
  readonly parts: readonly MassPart[];
  readonly emptyKg: number;
  readonly operatingKg: number;
  readonly testKg: number;
  readonly operatingLiquidM3: number;
  readonly totalVolumeM3: number;
  readonly densityKgM3: number;
  readonly densityDefaulted: boolean;
}

/** Area of the roof plate (cone lateral, spherical cap, disc). */
function roofArea(template: TankTemplate): number {
  const eave = eaveRadius(template);
  const rise = roofRise(template);
  const { roof } = template;
  if (roof.type === 'cone') return Math.PI * eave * Math.hypot(eave, rise);
  if (roof.type === 'dome') return 2 * Math.PI * (roof.radius ?? eave) * rise;
  return Math.PI * eave * eave;
}

/** @param scale metres per document unit */
export function tankMass(scale: number, template: TankTemplate): TankMass {
  const cubic = scale ** 3;
  const density = template.design.materialDensityKgM3 ?? STEEL_DENSITY_KG_PER_M3;
  const radius = template.diameter / 2;
  const bottoms = courseBottoms(template);
  const parts: MassPart[] = [
    ...template.courses.map(
      (height, index): MassPart => ({
        part: `course ${index + 1}`,
        kg: Math.PI * ((radius + (template.courseThicknesses[index] as number)) ** 2 - radius * radius) * height * cubic * density,
        method: `pi ((R + t)^2 - R^2) x course height x density (course bottom ${bottoms[index]})`,
      }),
    ),
    {
      part: 'bottom',
      kg: Math.PI * eaveRadius(template) ** 2 * template.bottom.thickness * cubic * density,
      method: 'disc of the eave radius x bottom plate thickness x density',
    },
    { part: 'roof', kg: roofArea(template) * template.roof.thickness * cubic * density, method: 'plate area x roof thickness x density' },
  ];
  const emptyKg = parts.reduce((sum, part) => sum + part.kg, 0);
  const operatingLiquidM3 = tankLiquidVolume(template, template.design.designLiquidLevel) * cubic;
  const totalVolumeM3 = tankLiquidVolume(template, template.shellHeight) * cubic;
  return {
    parts,
    emptyKg,
    operatingKg: emptyKg + operatingLiquidM3 * template.design.specificGravity * 1000,
    testKg: emptyKg + totalVolumeM3 * TEST_WATER_KG_PER_M3,
    operatingLiquidM3,
    totalVolumeM3,
    densityKgM3: density,
    densityDefaulted: template.design.materialDensityKgM3 === undefined,
  };
}
