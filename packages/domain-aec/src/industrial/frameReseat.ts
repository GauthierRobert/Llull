/**
 * Members placed from a resized member's depth follow it (purlins, gable posts, side rails).
 * @layer domain-aec
 * @pure
 */

import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import type { CadDocument, Vec3 } from '@core/model/types';
import { add3 } from '@lib/vec3';
import { fromMm, withElement } from '../model';
import { findProfile } from '../steel/profiles';
import { sweepFrame } from '../mesh';

/**
 * Members placed from a resized member's depth follow it: purlins on a rafter move along the
 * rafter normal, gable-post tops drop under a deeper rafter, side rails move out with a deeper
 * column (by half the depth change).
 */
export function reseatDependents(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  resizedIds: ReadonlyArray<string>,
  before: string,
  after: string,
  analysed: ReadonlySet<string>,
): { building: BuildingModel; moved: string[] } {
  const [old, larger] = [findProfile(before), findProfile(after)];
  if (!old || !larger || resizedIds.length === 0) return { building, moved: [] };
  const half = fromMm(doc, larger.h - old.h) / 2;
  const tolerance = fromMm(doc, 10);
  const resized = resizedIds
    .map((id) => building.elements[id])
    .filter((element): element is SteelMemberElement => element?.category === 'member');
  const onPlane = (member: SteelMemberElement, y: number): boolean =>
    Math.abs(member.start[1] - y) < tolerance && Math.abs(member.end[1] - y) < tolerance;
  let next = building;
  const moved: string[] = [];
  for (const element of Object.values(building.elements)) {
    if (element.category !== 'member' || analysed.has(element.id)) continue;
    let offset: Vec3 | null = null;
    let topOnly = false;
    if (element.role === 'purlin' || element.role === 'column') {
      // Purlins span between frame planes; gable posts stand in one.
      const rafter = resized.find((candidate) => {
        if (candidate.role !== 'rafter') return false;
        const y = candidate.start[1];
        const inPlane =
          element.role === 'purlin'
            ? Math.abs(element.start[1] - y) < tolerance || Math.abs(element.end[1] - y) < tolerance
            : onPlane(element, y);
        const [low, high] = [
          Math.min(candidate.start[0], candidate.end[0]),
          Math.max(candidate.start[0], candidate.end[0]),
        ];
        // Gable posts stand strictly inside the rafter span (frame columns sit at its ends).
        const margin = element.role === 'purlin' ? -fromMm(doc, larger.h) : tolerance;
        return inPlane && element.start[0] > low + margin && element.start[0] < high - margin;
      });
      const frame = rafter ? sweepFrame(rafter.start, rafter.end, rafter.roll) : null;
      if (frame && element.role === 'purlin')
        offset = [frame.v[0] * half, frame.v[1] * half, frame.v[2] * half];
      if (frame && element.role === 'column' && Math.abs(frame.v[2]) > 1e-6) {
        offset = [0, 0, -half / frame.v[2]];
        topOnly = true;
      }
    }
    if (element.role === 'rail') {
      const column = resized.find(
        (candidate) =>
          candidate.role === 'column' &&
          (Math.abs(candidate.start[1] - element.start[1]) < tolerance ||
            Math.abs(candidate.start[1] - element.end[1]) < tolerance) &&
          Math.abs(candidate.start[0] - element.start[0]) < fromMm(doc, larger.h + 500),
      );
      if (column) offset = [Math.sign(element.start[0] - column.start[0]) * half, 0, 0];
    }
    if (!offset) continue;
    const by = offset;
    const updated: SteelMemberElement = topOnly
      ? element.start[2] >= element.end[2]
        ? { ...element, start: add3(element.start, by) }
        : { ...element, end: add3(element.end, by) }
      : { ...element, start: add3(element.start, by), end: add3(element.end, by) };
    next = withElement(next, updated);
    moved.push(element.id);
  }
  return { building: next, moved };
}
