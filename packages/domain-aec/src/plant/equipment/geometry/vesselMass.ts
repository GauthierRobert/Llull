/**
 * Mass of a parametric vessel (plant 03 EQP §5.3): shell annulus, exact constant-thickness head solids, skirt / base ring / square legs, and
 * the liquid of the operating level (Jones) or of a full water test. One source for `equipment_weights` and the legacy `weight` field.
 */

import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { VesselDesignData, VesselTemplate } from '../plantData';
import { headMetalVolume } from './headOffset';
import { headVolume } from './heads';
import { horizontalVolume, verticalVolume } from './partialVolume';
import { skirtRadii, type VesselGeometry } from './vesselFrame';

export interface MassPart {
  readonly part: string;
  readonly kg: number;
  readonly method: string;
}

export interface VesselMass {
  readonly parts: readonly MassPart[];
  readonly emptyKg: number;
  /** Null when the operating level has no closed form (torispherical head of a horizontal vessel at a partial level). */
  readonly operatingKg: number | null;
  readonly operatingLiquidM3: number | null;
  readonly testKg: number;
  readonly totalVolumeM3: number;
  readonly densityKgM3: number;
  readonly densityDefaulted: boolean;
}

/** Density of the water of the hydrostatic test (UG-99), a named default. */
export const TEST_WATER_KG_PER_M3 = 1000;

const annulus = (outer: number, inner: number): number => Math.PI * (outer * outer - inner * inner);

function supportParts(template: VesselTemplate, geometry: VesselGeometry, cubic: number, density: number): MassPart[] {
  const { support } = template;
  if (support.type === 'skirt') {
    const { outer } = skirtRadii(geometry, support.thickness);
    const wall = annulus(outer, geometry.radius + geometry.shellThickness) * support.height;
    const ring = support.baseRingWidth > 0 ? annulus(outer + support.baseRingWidth, outer) * support.thickness : 0;
    return [
      { part: 'skirt', kg: wall * cubic * density, method: 'annulus (inside radius = shell outside radius) x height x density' },
      ...(ring > 0 ? [{ part: 'baseRing', kg: ring * cubic * density, method: 'annulus x skirt thickness x density' }] : []),
    ];
  }
  if (support.type === 'legs')
    return [
      {
        part: 'legs',
        kg: support.count * support.legWidth * support.legWidth * support.height * cubic * density,
        method: 'count x square section x height x density',
      },
    ];
  return [];
}

/** Insulation layer on the shell (annulus) and on both heads (exact offset solid of the head, minus the head itself), one part each. */
function insulationParts(
  geometry: VesselGeometry,
  design: VesselDesignData | undefined,
  cubic: number,
  names: readonly [string, string],
): MassPart[] {
  const insulation = design?.insulation;
  if (insulation === undefined) return [];
  const { radius, length, first, second, headThickness } = geometry;
  const shellOuter = radius + geometry.shellThickness;
  const kg = (volume: number): number => volume * cubic * insulation.densityKgM3;
  const layer = (shape: typeof first): number =>
    headMetalVolume(shape, radius, headThickness + insulation.thickness) - headMetalVolume(shape, radius, headThickness);
  const method = 'exact offset layer (t + insulation minus t) x insulation density; supports are not insulated';
  return [
    {
      part: 'insulation shell',
      kg: kg(annulus(shellOuter + insulation.thickness, shellOuter) * length),
      method: 'annulus x tangent length x insulation density',
    },
    { part: `insulation ${names[0]}`, kg: kg(layer(first)), method },
    { part: `insulation ${names[1]}`, kg: kg(layer(second)), method },
  ];
}

/** Internals the user gave as lumped masses. */
const internalParts = (design: VesselDesignData | undefined): MassPart[] =>
  (design?.internals ?? []).map((item) => ({ part: `internals: ${item.label}`, kg: item.kg, method: 'vendor mass (input)' }));

/**
 * @param scale metres per document unit
 * @invariant empty = shell + both heads + skirt / ring / legs + insulation + internals (saddle plates and nozzles are not included); test = empty + full inside volume
 *   x 1000 kg/m3 (nozzle bores not subtracted); density default and operating-liquid absence are the caller's to report
 */
export function vesselMass(
  scale: number,
  template: VesselTemplate,
  geometry: VesselGeometry,
  design: VesselDesignData | undefined,
): VesselMass {
  const cubic = scale ** 3;
  const densityDefaulted = design?.materialDensityKgM3 === undefined;
  const density = design?.materialDensityKgM3 ?? STEEL_DENSITY_KG_PER_M3;
  const { radius, length, first, second } = geometry;
  const outer = radius + geometry.shellThickness;
  const vertical = template.orientation === 'vertical';
  const headMethod = 'exact solid between the inside profile and its outward offset by t, closed by the tangent plane';
  const parts: MassPart[] = [
    { part: 'shell', kg: annulus(outer, radius) * length * cubic * density, method: 'pi ((R + t)^2 - R^2) x tangent length x density' },
    {
      part: vertical ? 'headBottom' : 'headLeft',
      kg: headMetalVolume(first, radius, geometry.headThickness) * cubic * density,
      method: headMethod,
    },
    {
      part: vertical ? 'headTop' : 'headRight',
      kg: headMetalVolume(second, radius, geometry.headThickness) * cubic * density,
      method: headMethod,
    },
    ...supportParts(template, geometry, cubic, density),
    ...insulationParts(geometry, design, cubic, vertical ? ['headBottom', 'headTop'] : ['headLeft', 'headRight']),
    ...internalParts(design),
  ];
  const emptyKg = parts.reduce((sum, part) => sum + part.kg, 0);
  const liquid = design?.operatingLiquid;
  const operatingLiquidM3 =
    liquid === undefined
      ? 0
      : vertical
        ? verticalVolume(radius, length, first, second, first.depth + liquid.levelAboveBottomTangent)
        : horizontalVolume(radius, length, first, second, liquid.levelAboveBottomTangent);
  const totalVolumeM3 = (Math.PI * radius * radius * length + headVolume(first, radius) + headVolume(second, radius)) * cubic;
  return {
    parts,
    emptyKg,
    operatingKg: operatingLiquidM3 === null ? null : emptyKg + operatingLiquidM3 * cubic * (liquid?.specificGravity ?? 0) * 1000,
    operatingLiquidM3: operatingLiquidM3 === null ? null : operatingLiquidM3 * cubic,
    testKg: emptyKg + totalVolumeM3 * TEST_WATER_KG_PER_M3,
    totalVolumeM3,
    densityKgM3: density,
    densityDefaulted,
  };
}
