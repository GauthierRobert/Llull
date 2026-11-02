/**
 * Mass of an exchanger (plant 03 EQP §5.3): shell and channel annuli, exact offset-solid bonnets and shell cover, flat covers and tubesheets as
 * gross discs minus the tube holes, tube metal over the full tube length, and the fluid volumes of both sides. One source for `equipment_weights`
 * and the legacy `weight` field. Floating head, floating tubesheet, U-bends, baffles, tie rods, pass partitions and saddles are not modelled.
 */

import { STEEL_DENSITY_KG_PER_M3 } from '@aec/steel/profiles';
import type { ExchangerTemplate } from '../plantData';
import { exchangerVolumes, type ExchangerEnd, type ExchangerGeometry } from './exchangerFrame';
import { headMetalVolume } from './headOffset';
import { TEST_WATER_KG_PER_M3, type MassPart } from './vesselMass';

export interface FluidSide {
  readonly volumeM3: number;
  /** Null when the side has no specific gravity: it adds nothing to the operating weight. */
  readonly specificGravity: number | null;
}

export interface ExchangerMass {
  readonly parts: readonly MassPart[];
  readonly emptyKg: number;
  readonly operatingKg: number;
  readonly testKg: number;
  readonly shellSide: FluidSide;
  readonly tubeSide: FluidSide;
  readonly densityKgM3: number;
  readonly densityDefaulted: boolean;
}

const annulus = (outer: number, inner: number): number => Math.PI * (outer * outer - inner * inner);

/** @param scale metres per document unit */
export function exchangerMass(scale: number, template: ExchangerTemplate, geometry: ExchangerGeometry): ExchangerMass {
  const cubic = scale ** 3;
  const density = template.design?.materialDensityKgM3 ?? STEEL_DENSITY_KG_PER_M3;
  const { radius, shellThickness } = geometry;
  const { tubes } = template;
  const holes = (tubes.count * Math.PI * tubes.outsideDiameter ** 2) / 4;
  const kg = (volume: number): number => volume * cubic * density;
  const sheetMethod = 'gross disc (outside radius = shell outside radius) x thickness minus the tube holes, x density';
  const endParts = (end: ExchangerEnd, name: string): MassPart[] => {
    const parts: MassPart[] = [];
    if (end.hasTubesheet) {
      parts.push(
        { part: `${name}Tubesheet`, kg: kg((Math.PI * (radius + shellThickness) ** 2 - holes) * geometry.tubesheet), method: sheetMethod },
        {
          part: `${name}Channel`,
          kg: kg(annulus(radius + end.channelThickness, radius) * end.channelLength),
          method: 'annulus x length x density',
        },
      );
    }
    const closure =
      end.closure === 'flat'
        ? { part: `${name}Cover`, method: 'flat cover: disc of the inside radius x channel thickness x density' }
        : {
            part: end.closure === 'bonnet' ? `${name}Bonnet` : `${name}ShellCover`,
            method: 'exact solid between the inside profile and its outward offset by t, closed by the tangent plane',
          };
    parts.push({ ...closure, kg: kg(headMetalVolume(end.head, radius, end.channelThickness)) });
    return parts;
  };
  const parts: MassPart[] = [
    {
      part: 'shell',
      kg: kg(annulus(radius + shellThickness, radius) * geometry.shellLength),
      method: 'pi ((R + t)^2 - R^2) x shell length x density',
    },
    ...endParts(geometry.front, 'front'),
    ...endParts(geometry.rear, 'rear'),
    {
      part: 'tubes',
      kg: kg(
        (tubes.count * Math.PI * (tubes.outsideDiameter ** 2 - (tubes.outsideDiameter - 2 * tubes.wallThickness) ** 2) * tubes.length) / 4,
      ),
      method: 'count x pi/4 (OD^2 - ID^2) x tube length x density',
    },
  ];
  const emptyKg = parts.reduce((sum, part) => sum + part.kg, 0);
  const volumes = exchangerVolumes(template, geometry);
  const shellSide: FluidSide = {
    volumeM3: volumes.shellSide * cubic,
    specificGravity: template.design?.shellSide?.specificGravity ?? null,
  };
  const tubeSide: FluidSide = { volumeM3: volumes.tubeSide * cubic, specificGravity: template.design?.tubeSide?.specificGravity ?? null };
  const fluid = (side: FluidSide): number => side.volumeM3 * (side.specificGravity ?? 0) * 1000;
  return {
    parts,
    emptyKg,
    operatingKg: emptyKg + fluid(shellSide) + fluid(tubeSide),
    testKg: emptyKg + (shellSide.volumeM3 + tubeSide.volumeM3) * TEST_WATER_KG_PER_M3,
    shellSide,
    tubeSide,
    densityKgM3: density,
    densityDefaulted: template.design?.materialDensityKgM3 === undefined,
  };
}
