/**
 * @layer ui/panels/building
 * Plan bounds of the structural grid lines (param-gathering for "Grid extent" outlines).
 */

import type { BuildingModel } from '@core/model/building';
import type { PlanExtent } from './elementToolForm';

export function gridExtent(building: BuildingModel | undefined): PlanExtent | null {
  if (building === undefined) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const element of Object.values(building.elements)) {
    if (element.category !== 'grid') continue;
    xs.push(element.start[0], element.end[0]);
    ys.push(element.start[1], element.end[1]);
  }
  if (xs.length === 0) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
