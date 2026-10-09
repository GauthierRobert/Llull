/**
 * Earthworks math (document units): grid-method cut / fill between a TIN and a graded pad with
 * cut / fill batters, and between two TINs.
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';
import { pointInPolygon, polygonArea } from '@lib/polygon';
import { elevationAt, tinBounds, type Tin } from './tin';

/** Default grid: the pad gets about this many cells. */
export const TARGET_PAD_CELLS = 2500;
/** Hard cap on grid samples. */
export const MAX_SAMPLES = 250000;
const COMPARE_TARGET_CELLS = 40000;

/** Ground sampled on a regular grid (cell centres) around a pad. */
export interface GridSamples {
  /** Existing-ground elevation per cell; NaN where the TIN has none. */
  readonly ground: Float64Array;
  /** Plan distance to the pad outline; 0 inside the pad. */
  readonly distance: Float64Array;
  readonly cellArea: number;
  readonly spacing: number;
  readonly outsideTin: number;
}

export interface Earthworks {
  readonly cutVolume: number;
  readonly fillVolume: number;
  readonly cutArea: number;
  readonly fillArea: number;
  readonly padArea: number;
  readonly maxCutDepth: number;
  readonly maxFillDepth: number;
  readonly spacing: number;
  readonly samples: number;
  readonly outsideTin: number;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Plan distance from `p` to the outline of `polygon`. */
export function distanceToOutline(p: Vec2, polygon: ReadonlyArray<Vec2>): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    best = Math.min(
      best,
      segmentDistance(p, polygon[i] as Vec2, polygon[(i + 1) % polygon.length] as Vec2),
    );
  }
  return best;
}

/** Farthest plan distance a batter can reach before meeting any ground of `tin`. */
export function daylightReach(
  tin: Tin,
  elevation: number,
  cutSlope: number,
  fillSlope: number,
): number {
  const bounds = tinBounds(tin);
  if (!bounds) return 0;
  return Math.max(
    0,
    (bounds.max[2] - elevation) * cutSlope,
    (elevation - bounds.min[2]) * fillSlope,
  );
}

/** Cell count along an axis so cells are about `spacing` wide. */
const cellsAlong = (length: number, spacing: number): number =>
  Math.max(1, Math.ceil(length / spacing - 1e-9));

function emptySamples(): GridSamples {
  return {
    ground: new Float64Array(0),
    distance: new Float64Array(0),
    cellArea: 0,
    spacing: 0,
    outsideTin: 0,
  };
}

/**
 * Samples the ground of `tin` on a grid covering `boundary` expanded by `margin` (clipped to the
 * TIN extent). `spacing` defaults so the pad gets ~2500 cells; always capped at 250k samples.
 */
export function buildSamples(
  tin: Tin,
  boundary: ReadonlyArray<Vec2>,
  margin: number,
  spacing?: number,
): GridSamples {
  const bounds = tinBounds(tin);
  if (!bounds || boundary.length < 3) return emptySamples();
  const xs = boundary.map((point) => point[0]);
  const ys = boundary.map((point) => point[1]);
  const minX = Math.max(Math.min(...xs) - margin, bounds.min[0]);
  const maxX = Math.min(Math.max(...xs) + margin, bounds.max[0]);
  const minY = Math.max(Math.min(...ys) - margin, bounds.min[1]);
  const maxY = Math.min(Math.max(...ys) + margin, bounds.max[1]);
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return emptySamples();
  let step = spacing ?? Math.sqrt(polygonArea(boundary) / TARGET_PAD_CELLS);
  if (!(step > 0)) step = Math.sqrt((width * height) / TARGET_PAD_CELLS);
  if ((width / step) * (height / step) > MAX_SAMPLES)
    step = Math.sqrt((width * height) / MAX_SAMPLES);
  const columns = cellsAlong(width, step);
  const rows = cellsAlong(height, step);
  const dx = width / columns;
  const dy = height / rows;
  const ground = new Float64Array(columns * rows);
  const distance = new Float64Array(columns * rows);
  let outsideTin = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const at: Vec2 = [minX + (column + 0.5) * dx, minY + (row + 0.5) * dy];
      const index = row * columns + column;
      const z = elevationAt(tin, at);
      if (z === null) {
        outsideTin += 1;
        ground[index] = NaN;
        continue;
      }
      ground[index] = z;
      distance[index] = pointInPolygon(at, boundary) ? 0 : distanceToOutline(at, boundary);
    }
  }
  return { ground, distance, cellArea: dx * dy, spacing: Math.sqrt(dx * dy), outsideTin };
}

/** Cut (+) / fill (-) depth of a cell: pad level inside the pad, batters outside. */
function depthAt(
  ground: number,
  distance: number,
  elevation: number,
  cutSlope: number,
  fillSlope: number,
): number {
  if (distance === 0) return ground - elevation;
  if (ground > elevation) return Math.max(0, ground - (elevation + distance / cutSlope));
  if (ground < elevation) return Math.min(0, ground - (elevation - distance / fillSlope));
  return 0;
}

/** Cut / fill of a pad at `elevation` over pre-sampled ground. */
export function volumesFromSamples(
  samples: GridSamples,
  boundary: ReadonlyArray<Vec2>,
  elevation: number,
  cutSlope: number,
  fillSlope: number,
): Earthworks {
  let cut = 0;
  let fill = 0;
  let cutCells = 0;
  let fillCells = 0;
  let maxCut = 0;
  let maxFill = 0;
  for (let i = 0; i < samples.ground.length; i++) {
    const ground = samples.ground[i] as number;
    if (Number.isNaN(ground)) continue;
    const depth = depthAt(ground, samples.distance[i] as number, elevation, cutSlope, fillSlope);
    if (depth > 0) {
      cut += depth;
      cutCells += 1;
      maxCut = Math.max(maxCut, depth);
    } else if (depth < 0) {
      fill -= depth;
      fillCells += 1;
      maxFill = Math.max(maxFill, -depth);
    }
  }
  return {
    cutVolume: cut * samples.cellArea,
    fillVolume: fill * samples.cellArea,
    cutArea: cutCells * samples.cellArea,
    fillArea: fillCells * samples.cellArea,
    padArea: polygonArea(boundary),
    maxCutDepth: maxCut,
    maxFillDepth: maxFill,
    spacing: samples.spacing,
    samples: samples.ground.length,
    outsideTin: samples.outsideTin,
  };
}

/** Cut / fill of a pad against the ground of `tin`. */
export function padEarthworks(
  tin: Tin,
  boundary: ReadonlyArray<Vec2>,
  elevation: number,
  cutSlope: number,
  fillSlope: number,
  spacing?: number,
): Earthworks {
  const margin = daylightReach(tin, elevation, cutSlope, fillSlope);
  const samples = buildSamples(tin, boundary, margin, spacing);
  return volumesFromSamples(samples, boundary, elevation, cutSlope, fillSlope);
}

export interface SurfaceComparison {
  readonly cutVolume: number;
  readonly fillVolume: number;
  readonly cutArea: number;
  readonly fillArea: number;
  readonly area: number;
  readonly spacing: number;
  readonly samples: number;
  readonly outsideTin: number;
}

/** Cut where `comparison` lies below `base`, fill where above (grid method over the shared extent). */
export function compareSurfaceVolumes(
  base: Tin,
  comparison: Tin,
  spacing?: number,
): SurfaceComparison {
  const a = tinBounds(base);
  const b = tinBounds(comparison);
  const none: SurfaceComparison = {
    cutVolume: 0,
    fillVolume: 0,
    cutArea: 0,
    fillArea: 0,
    area: 0,
    spacing: 0,
    samples: 0,
    outsideTin: 0,
  };
  if (!a || !b) return none;
  const minX = Math.max(a.min[0], b.min[0]);
  const maxX = Math.min(a.max[0], b.max[0]);
  const minY = Math.max(a.min[1], b.min[1]);
  const maxY = Math.min(a.max[1], b.max[1]);
  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return none;
  let step = spacing ?? Math.sqrt((width * height) / COMPARE_TARGET_CELLS);
  if ((width / step) * (height / step) > MAX_SAMPLES)
    step = Math.sqrt((width * height) / MAX_SAMPLES);
  const columns = cellsAlong(width, step);
  const rows = cellsAlong(height, step);
  const dx = width / columns;
  const dy = height / rows;
  let cut = 0;
  let fill = 0;
  let cutCells = 0;
  let fillCells = 0;
  let outsideTin = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const at: Vec2 = [minX + (column + 0.5) * dx, minY + (row + 0.5) * dy];
      const z0 = elevationAt(base, at);
      const z1 = elevationAt(comparison, at);
      if (z0 === null || z1 === null) {
        outsideTin += 1;
        continue;
      }
      if (z1 < z0) {
        cut += z0 - z1;
        cutCells += 1;
      } else if (z1 > z0) {
        fill += z1 - z0;
        fillCells += 1;
      }
    }
  }
  const cellArea = dx * dy;
  return {
    cutVolume: cut * cellArea,
    fillVolume: fill * cellArea,
    cutArea: cutCells * cellArea,
    fillArea: fillCells * cellArea,
    area: (columns * rows - outsideTin) * cellArea,
    spacing: Math.sqrt(cellArea),
    samples: columns * rows,
    outsideTin,
  };
}
