/**
 * Grid geometry shared by the grid-framing commands.
 * @layer domain-aec
 * @pure
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, GridElement } from '@core/model/building';
import { elementsOf } from '../model';

export interface GridCrossing {
  /** Crossing point in plan. */
  point: Vec2;
  /** Label of the other grid line. */
  other: string;
  /** Distance along the line from its start. */
  along: number;
}

/** Grid lines in element order. */
export function gridLinesOf(building: BuildingModel): GridElement[] {
  return elementsOf(building, 'grid');
}

/**
 * Crossing of two grid segments, or null when parallel or when the crossing lies outside either
 * segment by more than `tolerance`.
 */
export function crossGridLines(
  a: GridElement,
  b: GridElement,
  tolerance: number,
): { point: Vec2; along: number } | null {
  const dx = a.end[0] - a.start[0];
  const dy = a.end[1] - a.start[1];
  const ex = b.end[0] - b.start[0];
  const ey = b.end[1] - b.start[1];
  const lengthA = Math.hypot(dx, dy);
  const lengthB = Math.hypot(ex, ey);
  if (lengthA === 0 || lengthB === 0) return null;
  const cross = dx * ey - dy * ex;
  if (Math.abs(cross) < 1e-9 * lengthA * lengthB) return null;
  const qx = b.start[0] - a.start[0];
  const qy = b.start[1] - a.start[1];
  const t = (qx * ey - qy * ex) / cross;
  const s = (qx * dy - qy * dx) / cross;
  if (t * lengthA < -tolerance || t * lengthA > lengthA + tolerance) return null;
  if (s * lengthB < -tolerance || s * lengthB > lengthB + tolerance) return null;
  return { point: [a.start[0] + t * dx, a.start[1] + t * dy], along: t * lengthA };
}

/** Crossings on `line` with the other `lines`, ordered along it; coincident crossings merged. */
export function crossingsOnLine(
  line: GridElement,
  lines: ReadonlyArray<GridElement>,
  tolerance: number,
): GridCrossing[] {
  const found: GridCrossing[] = [];
  for (const other of lines) {
    if (other.id === line.id) continue;
    const crossing = crossGridLines(line, other, tolerance);
    if (crossing) found.push({ ...crossing, other: other.mark });
  }
  found.sort((p, q) => p.along - q.along);
  return found.filter((crossing, index) => {
    const previous = found[index - 1];
    return previous === undefined || crossing.along - previous.along > tolerance;
  });
}

export const samePlanPoint = (p: Vec2, q: Vec2, tolerance: number): boolean =>
  Math.hypot(p[0] - q[0], p[1] - q[1]) <= tolerance;

/** "A/1" or "1/A" -> ["A", "1"]; null when not two non-empty labels. */
export function parseCrossingName(name: string): [string, string] | null {
  const parts = name.split('/').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === '')) return null;
  return [parts[0] as string, parts[1] as string];
}

/** Labels in `labels` that no grid line carries. */
export const unknownLabels = (
  lines: ReadonlyArray<GridElement>,
  labels: ReadonlyArray<string>,
): string[] => labels.filter((label) => !lines.some((line) => line.mark === label));
