/**
 * @layer aec/building
 * Pure geometry of grid axes, shared by evaluation (3D bubbles) and plan drawings.
 */

import type { Vec2 } from '@core/model/types';
import type { GridElement } from '@core/model/building';
import { wallFrame } from './wallGeometry';

/** Bubble centres of a grid axis: one `radius` beyond each end, along the axis. */
export function gridBubbleCenters(grid: GridElement, radius: number): [start: Vec2, end: Vec2] {
  const { direction } = wallFrame(grid);
  return [
    [grid.start[0] - direction[0] * radius, grid.start[1] - direction[1] * radius],
    [grid.end[0] + direction[0] * radius, grid.end[1] + direction[1] * radius],
  ];
}
