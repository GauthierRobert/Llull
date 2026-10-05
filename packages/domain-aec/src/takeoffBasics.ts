/**
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type {
  BimCategory,
  BuildingElement,
  BuildingModel,
  CurvedWallElement,
  WallElement,
} from '@core/model/building';
import { polygonArea } from '@lib/polygon';
import { toMetres } from './model';
import { round } from './numeric';
import { builtExtent, openingsOf } from './wallGeometry';

type TakeoffUnit = 'm' | 'm2' | 'm3' | 'ea' | 'kg';

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

interface WallQuantities {
  readonly length: number;
  readonly netArea: number;
  readonly volume: number;
}

/** Built body (joints applied) in document units: length, net one-face area, volume. */
export function wallQuantities(
  building: BuildingModel,
  wall: WallElement | CurvedWallElement,
): WallQuantities {
  const extent = builtExtent(building, wall);
  const length = extent.end - extent.start;
  const openingArea = openingsOf(building, wall.id).reduce(
    (sum, opening) => sum + opening.width * opening.height,
    0,
  );
  const netArea = length * wall.height - openingArea;
  return { length, netArea, volume: netArea * wall.thickness };
}

/** Slab plan area minus its openings (document units²). */
export function slabNetArea(slab: Extract<BuildingElement, { category: 'slab' }>): number {
  return (slab.openings ?? []).reduce(
    (area, opening) => area - polygonArea(opening),
    polygonArea(slab.boundary),
  );
}

export function columnSectionArea(
  column: Extract<BuildingElement, { category: 'column' }>,
): number {
  return column.shape === 'circular'
    ? Math.PI * (column.width / 2) ** 2
    : column.width * column.depth;
}

export function stairVolume(stair: Extract<BuildingElement, { category: 'stair' }>): number {
  const stepCountSum = (stair.riserCount * (stair.riserCount + 1)) / 2;
  return stair.treadDepth * stair.width * stair.riserHeight * stepCountSum;
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

  /** Adds `quantity` per `[unit, what, quantity]` row; each line is described "<label> — <what>". */
  add(
    category: BimCategory,
    material: string,
    label: string,
    rows: ReadonlyArray<readonly [unit: TakeoffUnit, what: string, quantity: number]>,
    group: string = category,
  ): void {
    for (const [unit, what, quantity] of rows) {
      const key = `${group}.${material}.${unit}`;
      const existing = this.lines.get(key);
      this.lines.set(key, {
        key,
        group,
        category,
        material,
        unit,
        description: existing?.description ?? `${label} — ${what}`,
        quantity: (existing?.quantity ?? 0) + quantity,
      });
    }
  }

  result(): TakeoffLine[] {
    return [...this.lines.values()].map((line) => ({
      ...line,
      quantity: round(line.quantity, 3),
    }));
  }
}
