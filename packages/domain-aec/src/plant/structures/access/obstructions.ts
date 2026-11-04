/**
 * Vertical obstruction tests shared by the stair headroom and the platform headroom (06 STA): the boxes that can hang over a walking route and the exact
 * z span of a vertical line through one. Boxes are in document units.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { BuildingModel } from '@aec/building/types';
import { boxExtent, elementBoxes, type OrientedBox } from '../../../industrial/clash/clashBoxes';
import { externalBodies } from '../../../industrial/clash/clashSources';
import { pipingClashBodies } from '../../piping/clashBodies';
import { dot3 } from '@lib/vec3';

export interface Candidate {
  readonly id: string;
  readonly box: OrientedBox;
  readonly min: Vec3;
  readonly max: Vec3;
}

/** The z range `[low, high]` of the vertical line through (x, y) inside the box; null when the line misses it. */
export function verticalSpan(box: OrientedBox, x: number, y: number): [number, number] | null {
  let [low, high] = [-Infinity, Infinity];
  const origin: Vec3 = [x - box.center[0], y - box.center[1], -box.center[2]];
  for (let axis = 0; axis < 3; axis++) {
    const direction = box.axes[axis] as Vec3;
    const [offset, slope, half] = [dot3(origin, direction), direction[2], box.half[axis] as number];
    if (Math.abs(slope) < 1e-12) {
      if (Math.abs(offset) > half) return null;
      continue;
    }
    const [a, b] = [(-half - offset) / slope, (half - offset) / slope];
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
  }
  return low <= high ? [low, high] : null;
}

const candidate = (id: string, box: OrientedBox): Candidate => ({ id, box, ...boxExtent(box) });

/** Every building solid, spec-driven pipe run (insulation envelopes included) and access body, except the ids and groups in `exclude`. */
export function allCandidates(doc: CadDocument, building: BuildingModel, exclude: ReadonlySet<string>): Candidate[] {
  const found: Candidate[] = [];
  for (const element of Object.values(building.elements))
    if (!exclude.has(element.id)) for (const box of elementBoxes(doc, building, element)) found.push(candidate(element.id, box));
  for (const body of externalBodies(doc)) if (!exclude.has(body.id) && !exclude.has(body.group)) found.push(candidate(body.id, body.box));
  return found;
}

/** Boxes of pipes and cable trays: building elements and spec-driven runs with their insulation envelopes. */
export function pipeBoxes(doc: CadDocument, building: BuildingModel): OrientedBox[] {
  const found: OrientedBox[] = [];
  for (const element of Object.values(building.elements))
    if (element.category === 'pipe' || element.category === 'tray') found.push(...elementBoxes(doc, building, element));
  for (const body of pipingClashBodies(doc)) found.push(body.box);
  return found;
}
