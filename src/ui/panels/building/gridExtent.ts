/**
 * @layer ui/panels/building
 * Plan bounds of the structural grid (param-gathering for "Grid extent" outlines): the outermost
 * axis crossings, so the bubble overshoot of the grid lines is not included. Without any crossing,
 * the line endpoints.
 */

import type { BuildingModel, GridElement } from '@core/model/building';
import { crossGridLines } from '@aec/industrial/gridFraming';
import type { PlanExtent } from './elementToolForm';

const CROSSING_TOLERANCE = 1;

function boundsOf(points: ReadonlyArray<readonly [number, number]>): PlanExtent {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function gridExtent(building: BuildingModel | undefined): PlanExtent | null {
  if (building === undefined) return null;
  const lines = Object.values(building.elements).filter(
    (element): element is GridElement => element.category === 'grid',
  );
  if (lines.length === 0) return null;
  const crossings: Array<readonly [number, number]> = [];
  lines.forEach((line, index) => {
    for (const other of lines.slice(index + 1)) {
      const crossing = crossGridLines(line, other, CROSSING_TOLERANCE);
      if (crossing) crossings.push(crossing.point);
    }
  });
  if (crossings.length > 0) return boundsOf(crossings);
  return boundsOf(lines.flatMap((line) => [line.start, line.end]));
}
