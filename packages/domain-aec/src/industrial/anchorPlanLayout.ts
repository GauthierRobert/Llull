/**
 * anchorPlan: anchorPlanLayout.
 * @layer domain-aec
 */

import type {
  BasePlateElement,
  BuildingLevel,
  FootingElement,
  GridElement,
  SteelMemberElement,
} from '@core/model/building';
import type { CadDocument, Vec2 } from '@core/model/types';
import { getBuilding } from '../model';
import { plateLayout } from './evaluate';

export const TITLE = 'Anchor bolt setting-out plan';

export const GROUT_MM = 30;

export const DEFAULT_EMBEDMENT_MM = 300;

export const TABLE_WIDTH = 120;

export const ROW_HEIGHT = 4;

export const BUBBLE_RADIUS = 3.5;

export const INSET = 28;

export const BAND_STEP = 6;

export const OFFSET_TOLERANCE_MM = 1;

export interface BandDim {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

/** Greedy interval packing: dimensions that overlap along the band get separate stack levels. */
export function packBands(dims: ReadonlyArray<BandDim>): Array<{ dim: BandDim; level: number }> {
  const ends: number[] = [];
  return [...dims]
    .sort((a, b) => a.from - b.from)
    .map((dim) => {
      let level = ends.findIndex((end) => end < dim.from);
      if (level < 0) level = ends.length;
      ends[level] = dim.to;
      return { dim, level };
    });
}

/** "A" on the grid line, "A+6000" / "B-6000" when the plate centre is off it by more than 1 mm. */
export function gridRef(axis: GridAxis | null, offsetMm: number): string {
  if (!axis) return '-';
  if (Math.abs(offsetMm) <= OFFSET_TOLERANCE_MM) return axis.mark;
  return `${axis.mark}${offsetMm > 0 ? '+' : '-'}${Math.round(Math.abs(offsetMm))}`;
}

export const n = (value: number): string => String(Math.round(value * 100) / 100);

/** One base plate placed in plan, all lengths in millimetres. */
interface PlacedPlate {
  readonly plate: BasePlateElement;
  readonly centre: Vec2;
  readonly corners: Vec2[];
  readonly bolts: Vec2[];
  readonly diameter: number;
  readonly thickness: number;
  readonly length: number;
  readonly width: number;
  readonly undersideLevel: number;
  readonly footingTop: number | null;
}

export interface GridAxis {
  readonly mark: string;
  /** Coordinate across the line (x of a vertical line, y of a horizontal one), mm. */
  readonly position: number;
  readonly from: Vec2;
  readonly to: Vec2;
}

export const compareMark = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });

export function nearest(axes: ReadonlyArray<GridAxis>, value: number): GridAxis | null {
  let best: GridAxis | null = null;
  for (const axis of axes) {
    if (!best || Math.abs(axis.position - value) < Math.abs(best.position - value)) best = axis;
  }
  return best;
}

/** Grid lines split by direction: vertical (constant x) and horizontal (constant y). */
export function gridAxes(
  grids: ReadonlyArray<GridElement>,
  mm: (value: number) => number,
): { vertical: GridAxis[]; horizontal: GridAxis[] } {
  const vertical: GridAxis[] = [];
  const horizontal: GridAxis[] = [];
  for (const grid of grids) {
    const [start, end]: [Vec2, Vec2] = [
      [mm(grid.start[0]), mm(grid.start[1])],
      [mm(grid.end[0]), mm(grid.end[1])],
    ];
    const isVertical = Math.abs(end[0] - start[0]) < Math.abs(end[1] - start[1]);
    const [from, to] = (isVertical ? start[1] <= end[1] : start[0] <= end[0])
      ? [start, end]
      : [end, start];
    const axis: GridAxis = {
      mark: grid.mark,
      position: isVertical ? (start[0] + end[0]) / 2 : (start[1] + end[1]) / 2,
      from,
      to,
    };
    (isVertical ? vertical : horizontal).push(axis);
  }
  const byPosition = (a: GridAxis, b: GridAxis): number => a.position - b.position;
  return { vertical: vertical.sort(byPosition), horizontal: horizontal.sort(byPosition) };
}

export function placePlates(
  doc: CadDocument,
  level: BuildingLevel,
  mm: (value: number) => number,
): PlacedPlate[] {
  const building = getBuilding(doc);
  const footings = Object.values(building.elements).filter(
    (element): element is FootingElement =>
      element.category === 'footing' && element.levelId === level.id,
  );
  const placed: PlacedPlate[] = [];
  for (const id of building.elementOrder) {
    const plate = building.elements[id];
    if (plate?.category !== 'plate' || plate.levelId !== level.id) continue;
    const member = building.elements[plate.memberId];
    if (member?.category !== 'member' || (member as SteelMemberElement).role !== 'column') continue;
    const layout = plateLayout(doc, plate, member, level);
    if (!layout) continue;
    const centre: Vec2 = [mm(layout.center[0]), mm(layout.center[1])];
    const [cos, sin] = [Math.cos(layout.angle), Math.sin(layout.angle)];
    const [halfLength, halfWidth] = [mm(plate.length) / 2, mm(plate.width) / 2];
    const corners = (
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const
    ).map(
      ([a, b]): Vec2 => [
        centre[0] + a * halfLength * cos - b * halfWidth * sin,
        centre[1] + a * halfLength * sin + b * halfWidth * cos,
      ],
    );
    const footing = footings.find(
      (candidate) =>
        Math.abs(layout.center[0] - candidate.location[0]) <= candidate.width / 2 &&
        Math.abs(layout.center[1] - candidate.location[1]) <= candidate.length / 2,
    );
    placed.push({
      plate,
      centre,
      corners,
      bolts: layout.bolts.map((bolt): Vec2 => [mm(bolt[0]), mm(bolt[1])]),
      diameter: mm(plate.boltDiameter),
      thickness: mm(plate.thickness),
      length: mm(plate.length),
      width: mm(plate.width),
      undersideLevel: mm(layout.center[2] - plate.thickness / 2),
      footingTop: footing ? mm(level.elevation + footing.topOffset) : null,
    });
  }
  return placed;
}

export const metres = (millimetres: number): string =>
  `${millimetres < 0 ? '-' : '+'}${(Math.abs(millimetres) / 1000).toFixed(3)}`;
