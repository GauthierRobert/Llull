/**
 * Crane runway beam segments and support brackets.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { BuildingModel } from '@core/model/building';
import { fromMm } from '../model';
import type { SteelProfile } from '../steel/profiles';
import type { MemberSpec } from './portalGeometry';

export interface RunwaySpec {
  readonly start: Vec2;
  readonly end: Vec2;
  readonly railHeight: number;
  readonly profile: SteelProfile;
  readonly supports: ReadonlyArray<number>;
  readonly bracket: SteelProfile;
  readonly note: string;
}

/** Runway beam segments between supports + brackets to the nearest steel column at each support. */
export function runwayMembers(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  spec: RunwaySpec,
): MemberSpec[] {
  const dx = spec.end[0] - spec.start[0];
  const dy = spec.end[1] - spec.start[1];
  const length = Math.hypot(dx, dy);
  const at = (distance: number): Vec2 => [
    spec.start[0] + (dx / length) * distance,
    spec.start[1] + (dy / length) * distance,
  ];
  const axisZ = spec.railHeight - fromMm(doc, spec.profile.h) / 2;
  const stations = [
    ...new Set([0, ...spec.supports.filter((s) => s > 0 && s < length), length]),
  ].sort((a, b) => a - b);
  const members: MemberSpec[] = [];
  for (let index = 0; index + 1 < stations.length; index++) {
    const [from, to] = [at(stations[index] as number), at(stations[index + 1] as number)];
    members.push({
      role: 'crane',
      profile: spec.profile.name,
      start: [from[0], from[1], axisZ],
      end: [to[0], to[1], axisZ],
      note: spec.note,
    });
  }
  const columns = Object.values(building.elements).filter(
    (element) =>
      element.category === 'member' && element.role === 'column' && element.levelId === levelId,
  );
  const bracketZ = spec.railHeight - fromMm(doc, spec.profile.h) - fromMm(doc, spec.bracket.h) / 2;
  for (const station of stations) {
    const point = at(station);
    let nearest: Vec2 | null = null;
    let best = fromMm(doc, 2000);
    for (const column of columns) {
      if (column.category !== 'member') continue;
      const [x, y] = column.start;
      const distance = Math.hypot(x - point[0], y - point[1]);
      if (distance > 0 && distance < best) {
        best = distance;
        nearest = [x, y];
      }
    }
    if (nearest) {
      members.push({
        role: 'beam',
        profile: spec.bracket.name,
        start: [nearest[0], nearest[1], bracketZ],
        end: [point[0], point[1], bracketZ],
        note: 'crane bracket',
      });
    }
  }
  return members;
}
