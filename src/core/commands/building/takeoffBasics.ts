/**
 * quantities: takeoffBasics.
 * @layer core/commands/building
 */

import type { CadDocument } from '../../model/types';
import type {
  BimCategory,
  BuildingElement,
  BuildingModel,
  WallElement,
} from '../../model/building';
import { polygonArea } from '../../../lib/polygon';
import { toMetres } from './model';
import { openingsOf, wallExtent } from './evaluate';
import type { ConnectionWelds } from './industrial/connections';

export type TakeoffUnit = 'm' | 'm2' | 'm3' | 'ea' | 'kg';

export interface TakeoffLine {
  /** Stable rate key "<group>.<material>.<unit>", e.g. "wall.concrete.m3", "slab-roof.concrete.m2". */
  readonly key: string;
  /** Category, refined by role for slabs: "slab-floor" | "slab-roof" | "slab-foundation". */
  readonly group: string;
  readonly category: BimCategory;
  readonly material: string;
  readonly description: string;
  readonly unit: TakeoffUnit;
  readonly quantity: number;
}

interface Scale {
  readonly length: (value: number) => number;
  readonly area: (value: number) => number;
  readonly volume: (value: number) => number;
}

export function scaleFor(doc: CadDocument): Scale {
  const metres = toMetres(doc, 1);
  return {
    length: (value) => value * metres,
    area: (value) => value * metres * metres,
    volume: (value) => value * metres * metres * metres,
  };
}

export interface WallQuantities {
  readonly length: number;
  readonly grossArea: number;
  readonly openingArea: number;
  readonly netArea: number;
  readonly volume: number;
}

/** Wall quantities of the built body (joints applied) in document units: length, one-face areas, volume. */
export function wallQuantities(building: BuildingModel, wall: WallElement): WallQuantities {
  const extent = wallExtent(building, wall);
  const length = extent.end - extent.start;
  const grossArea = length * wall.height;
  const openingArea = openingsOf(building, wall.id).reduce(
    (sum, opening) => sum + opening.width * opening.height,
    0,
  );
  const netArea = grossArea - openingArea;
  return { length, grossArea, openingArea, netArea, volume: netArea * wall.thickness };
}

/** Slab plan area minus its openings (document units²). */
export function slabNetArea(slab: Extract<BuildingElement, { category: 'slab' }>): number {
  return (slab.openings ?? []).reduce(
    (area, opening) => area - polygonArea(opening),
    polygonArea(slab.boundary),
  );
}

export function stairVolume(stair: Extract<BuildingElement, { category: 'stair' }>): number {
  const stepCountSum = (stair.riserCount * (stair.riserCount + 1)) / 2;
  return stair.treadDepth * stair.width * stair.riserHeight * stepCountSum;
}

export function elementsOf<C extends BimCategory>(
  building: BuildingModel,
  category: C,
): Array<Extract<BuildingElement, { category: C }>> {
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter(
      (element): element is Extract<BuildingElement, { category: C }> =>
        element !== undefined && element.category === category,
    );
}

const REBAR_KG_PER_M3 = 7850;

const REBAR_LAP_FACTOR = 1.1;

/** Mass (kg) of a footing's two-way bottom mat incl. 10% laps; 0 when unreinforced. */
export function footingRebarMass(
  footing: Extract<BuildingElement, { category: 'footing' }>,
  scale: Scale,
): number {
  const { reinforcement } = footing;
  if (!reinforcement) return 0;
  const [diameter, spacing, cover, width, length] = [
    reinforcement.barDiameter,
    reinforcement.spacing,
    reinforcement.cover,
    footing.width,
    footing.length,
  ].map(scale.length) as [number, number, number, number, number];
  const barLength = (extent: number): number => Math.max(0, extent - 2 * cover);
  const total =
    (Math.floor((length - 2 * cover) / spacing) + 1) * barLength(width) +
    (Math.floor((width - 2 * cover) / spacing) + 1) * barLength(length);
  return total * ((Math.PI * diameter ** 2) / 4) * REBAR_KG_PER_M3 * REBAR_LAP_FACTOR;
}

export class TakeoffAccumulator {
  private readonly lines = new Map<string, TakeoffLine>();

  add(
    category: BimCategory,
    material: string,
    unit: TakeoffUnit,
    description: string,
    quantity: number,
    group: string = category,
  ): void {
    const key = `${group}.${material}.${unit}`;
    const existing = this.lines.get(key);
    this.lines.set(key, {
      key,
      group,
      category,
      material,
      unit,
      description: existing?.description ?? description,
      quantity: (existing?.quantity ?? 0) + quantity,
    });
  }

  result(): TakeoffLine[] {
    return [...this.lines.values()].map((line) => ({
      ...line,
      quantity: Math.round(line.quantity * 1000) / 1000,
    }));
  }
}

/** Area of the openings hosted by a wall (for net face areas). */
export function curvedVoids(building: BuildingModel, wallId: string): number {
  return openingsOf(building, wallId).reduce(
    (sum, opening) => sum + opening.width * opening.height,
    0,
  );
}

/** "a8 flanges / a5 web · 3.2 m" (empty without welds). */
export function weldLabel(welds: ConnectionWelds | null): string {
  return welds
    ? `a${welds.flangeThroat} flanges / a${welds.webThroat} web · ${(welds.length / 1000).toFixed(1)} m`
    : '';
}
