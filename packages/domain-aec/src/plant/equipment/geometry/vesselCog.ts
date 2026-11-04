/**
 * Centre of gravity of a parametric vessel (plant 03 EQP-FU), in the equipment frame (origin = plan location at the level elevation, +Z up; a vertical
 * vessel's axis is x = y = 0, a horizontal one runs along X at the datum height). A lumped-mass sum over the parts of `vesselMass` (shell, heads, support,
 * insulation, internals), the nozzles on request, and the liquid (operating level, or a full water test). Heads use the exact centroid of their offset
 * metal solid (`headCentroid`); nozzles are lumped at the middle of the placement line wall -> flange face.
 */

import type { Vec3 } from '@core/model/vectors';
import type { NozzleRecord, VesselDesignData, VesselTemplate } from '../plantData';
import { headFillCentroid, headMetalCentroid } from './headCentroid';
import { headMetalVolume } from './headOffset';
import type { HeadShape } from './heads';
import { nozzleMassParts } from './nozzleMass';
import { horizontalVolume } from './partialVolume';
import { placeNozzle } from './ports';
import { TEST_WATER_KG_PER_M3, vesselMass } from './vesselMass';
import type { VesselGeometry } from './vesselFrame';

export interface CogPart {
  readonly part: string;
  readonly kg: number;
  /** Equipment-frame position of the lump. */
  readonly at: Vec3;
}

export interface CogState {
  readonly kg: number;
  readonly at: Vec3;
}

export interface VesselCog {
  readonly parts: readonly CogPart[];
  readonly liquidParts: readonly CogPart[];
  readonly empty: CogState;
  /** Null when the operating liquid has no closed form (horizontal torispherical head at a partial level) or no operating liquid is set. */
  readonly operating: CogState | null;
  readonly test: CogState;
  readonly defaulted: readonly string[];
  readonly approximations: readonly string[];
}

/** Mass-weighted centre of `parts`; the origin for a massless set. */
export function centreOf(parts: readonly CogPart[]): CogState {
  const kg = parts.reduce((sum, part) => sum + part.kg, 0);
  if (!(kg > 0)) return { kg: 0, at: [0, 0, 0] };
  const sum = (axis: 0 | 1 | 2): number => parts.reduce((total, part) => total + part.kg * part.at[axis], 0) / kg;
  return { kg, at: [sum(0), sum(1), sum(2)] };
}

/** Circular segment of height h at the bottom of a circle of radius r: area and the distance of its centroid below the circle centre. */
function segment(radius: number, h: number): { area: number; below: number } {
  const level = Math.min(Math.max(h, 0), 2 * radius);
  if (level === 0) return { area: 0, below: 0 };
  const theta = 2 * Math.acos((radius - level) / radius);
  const area = (radius * radius * (theta - Math.sin(theta))) / 2;
  return { area, below: (4 * radius * Math.sin(theta / 2) ** 3) / (3 * (theta - Math.sin(theta))) };
}

interface Frame {
  /** Position `along` the axis from the bottom (vertical) / left (horizontal) tangent line. */
  readonly at: (along: number) => Vec3;
  readonly firstName: string;
  readonly secondName: string;
}

const frameOf = (template: VesselTemplate, geometry: VesselGeometry): Frame =>
  template.orientation === 'vertical'
    ? { at: (along) => [0, 0, geometry.datum + along], firstName: 'headBottom', secondName: 'headTop' }
    : { at: (along) => [-geometry.length / 2 + along, 0, geometry.datum], firstName: 'headLeft', secondName: 'headRight' };

/** Centroid, along the axis from the tangent line outward, of the insulation layer of a head (the metal solids of t + insulation minus t). */
function layerCentroid(shape: HeadShape, radius: number, thickness: number, insulation: number): number {
  const bare = headMetalVolume(shape, radius, thickness);
  const thick = headMetalVolume(shape, radius, thickness + insulation);
  if (!(thick > bare)) return headMetalCentroid(shape, radius, thickness);
  return (
    (thick * headMetalCentroid(shape, radius, thickness + insulation) - bare * headMetalCentroid(shape, radius, thickness)) / (thick - bare)
  );
}

/** Positions of the parts of `vesselMass` (metal, supports, insulation, internals). */
function metalParts(
  template: VesselTemplate,
  geometry: VesselGeometry,
  design: VesselDesignData | undefined,
  parts: ReadonlyArray<{ part: string; kg: number }>,
): { lumps: CogPart[]; defaulted: string[] } {
  const frame = frameOf(template, geometry);
  const { radius, length, headThickness, first, second, datum } = geometry;
  const insulation = design?.insulation?.thickness ?? 0;
  const defaulted: string[] = [];
  const lumps = parts.map(({ part, kg }): CogPart => {
    const at = (along: number): CogPart => ({ part, kg, at: frame.at(along) });
    if (part === 'shell' || part === 'insulation shell') return at(length / 2);
    if (part === frame.firstName) return at(-headMetalCentroid(first, radius, headThickness));
    if (part === frame.secondName) return at(length + headMetalCentroid(second, radius, headThickness));
    if (part === `insulation ${frame.firstName}`) return at(-layerCentroid(first, radius, headThickness, insulation));
    if (part === `insulation ${frame.secondName}`) return at(length + layerCentroid(second, radius, headThickness, insulation));
    if (part === 'skirt' || part === 'legs') return { part, kg, at: [0, 0, datum / 2] };
    if (part === 'baseRing') return { part, kg, at: [0, 0, (template.support.type === 'skirt' ? template.support.thickness : 0) / 2] };
    const item = (design?.internals ?? []).find((candidate) => `internals: ${candidate.label}` === part);
    if (item !== undefined && item.position === undefined) defaulted.push(`${part}: position = middle of the shell`);
    return at(item?.position ?? length / 2);
  });
  return { lumps, defaulted };
}

/** Neck + flange of each nozzle as one lump at the middle between the wall point and the flange face. */
function nozzleLumps(
  template: VesselTemplate,
  geometry: VesselGeometry,
  nozzles: readonly NozzleRecord[],
  scale: number,
  density: number,
): CogPart[] {
  const masses = nozzleMassParts(scale, geometry, nozzles, density);
  return nozzles.flatMap((nozzle, index): CogPart[] => {
    const placement = placeNozzle(template, nozzle);
    const kg = masses[index]?.kg;
    if (placement === null || kg === undefined) return [];
    const [bx, by, bz] = placement.base;
    const [fx, fy, fz] = placement.face;
    return [{ part: `nozzle ${nozzle.mark}`, kg, at: [(bx + fx) / 2, (by + fy) / 2, (bz + fz) / 2] }];
  });
}

/** Liquid lumps of a vessel at `level` (kg per cubic document unit = density x scale^3); null when a horizontal head has no closed form at that level. */
function liquidLumps(template: VesselTemplate, geometry: VesselGeometry, level: number, kgPerUnit3: number): CogPart[] | null {
  const frame = frameOf(template, geometry);
  const { radius, length, first, second, datum } = geometry;
  if (template.orientation === 'vertical') {
    const bottom = headFillCentroid(first, radius, first.depth);
    const inShell = Math.min(Math.max(level, 0), length);
    const top = headFillCentroid(second, radius, Math.min(Math.max(level - length, 0), second.depth));
    return [
      { part: 'liquid bottom head', kg: bottom.volume * kgPerUnit3, at: frame.at(-bottom.centroid) },
      { part: 'liquid shell', kg: Math.PI * radius * radius * inShell * kgPerUnit3, at: frame.at(inShell / 2) },
      { part: 'liquid top head', kg: top.volume * kgPerUnit3, at: frame.at(length + top.centroid) },
    ].filter((part) => part.kg > 0);
  }
  const body = segment(radius, level);
  const z = datum - body.below;
  const headLiquid = (shape: HeadShape): number | null => {
    const both = horizontalVolume(radius, 0, shape, shape, level);
    return both === null ? null : both / 2;
  };
  const left = headLiquid(first);
  const right = headLiquid(second);
  if (left === null || right === null) return null;
  const leftC = headFillCentroid(first, radius, first.depth).centroid;
  const rightC = headFillCentroid(second, radius, second.depth).centroid;
  return [
    { part: 'liquid shell', kg: body.area * length * kgPerUnit3, at: [0, 0, z] as Vec3 },
    { part: 'liquid headLeft', kg: left * kgPerUnit3, at: [-length / 2 - leftC, 0, z] as Vec3 },
    { part: 'liquid headRight', kg: right * kgPerUnit3, at: [length / 2 + rightC, 0, z] as Vec3 },
  ].filter((part) => part.kg > 0);
}

/**
 * Centre of gravity of the empty, operating and hydrotest states of a vessel.
 * @param scale metres per document unit
 * @invariant empty = the parts of `vesselMass` (+ the nozzles when given) at their centroids; operating adds the liquid of design.operatingLiquid, test the
 *   full inside volume of water; the bottom head of a vertical vessel is always full (levels count from the bottom tangent line)
 */
export function vesselCog(
  scale: number,
  template: VesselTemplate,
  geometry: VesselGeometry,
  design: VesselDesignData | undefined,
  nozzles: readonly NozzleRecord[],
): VesselCog {
  const mass = vesselMass(scale, template, geometry, design);
  const { lumps, defaulted } = metalParts(template, geometry, design, mass.parts);
  const empty = [...lumps, ...(nozzles.length === 0 ? [] : nozzleLumps(template, geometry, nozzles, scale, mass.densityKgM3))];
  const cubic = scale ** 3;
  const vertical = template.orientation === 'vertical';
  const fullLevel = vertical ? geometry.length + geometry.second.depth : 2 * geometry.radius;
  const water = liquidLumps(template, geometry, fullLevel, TEST_WATER_KG_PER_M3 * cubic) ?? [];
  const liquid = design?.operatingLiquid;
  const operatingLiquid =
    liquid === undefined ? null : liquidLumps(template, geometry, liquid.levelAboveBottomTangent, liquid.specificGravity * 1000 * cubic);
  const approximations = [
    'each nozzle (neck + flange) is one lump at the middle between the wall point and the flange face',
    'the liquid of a horizontal head at a partial level is lumped at the centroid of the full head cavity, at the height of the shell liquid centroid',
    'saddle plates, lifting lugs, platform clips and the weld metal are not modelled',
  ];
  return {
    parts: empty,
    liquidParts: operatingLiquid ?? [],
    empty: centreOf(empty),
    operating: operatingLiquid === null ? null : centreOf([...empty, ...operatingLiquid]),
    test: centreOf([...empty, ...water]),
    defaulted,
    approximations,
  };
}
