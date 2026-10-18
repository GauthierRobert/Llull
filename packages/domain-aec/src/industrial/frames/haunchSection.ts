/**
 * Haunched rafter ends in the portal frame analysis: the haunch is cut from the rafter section (depth h at the column face under the
 * rafter, tapering to 0), so the section there is an I of the same flanges and web with total depth up to 2h. The tapered stretch is
 * modelled as HAUNCH_PIECES prismatic pieces (stiffness at the piece middle, resistance at its shallower end).
 */
import type { Vec3 } from '@core/model/types';
import type { BuildingModel, SteelMemberElement } from '@core/model/building';
import { distance3 } from '@lib/vec3';
import type { SteelProfile } from '../../steel/profiles';

/** Prismatic pieces a haunch is divided into in the analysis model. */
export const HAUNCH_PIECES = 4;

/** A haunch at one end of a rafter, mm along the rafter axis: the end-plate face offset from the joint and the length from the face. */
export interface HaunchEnd {
  readonly face: number;
  readonly length: number;
}

export interface RafterPiece {
  /** Station of the piece ends along the rafter axis from the analysis start, mm. */
  readonly from: number;
  readonly to: number;
  /** Section giving the stiffness (EI) of the piece. */
  readonly stiffness: SteelProfile;
  /** Section checked for the piece (its shallower end); null on the plain rafter. */
  readonly resistance: SteelProfile | null;
}

/** Equivalent doubly-symmetric I of the rafter flanges and web with `extra` mm of depth added (the haunch's own mid flange is neglected). */
export function haunchedProfile(base: SteelProfile, extra: number): SteelProfile {
  if (!(extra > 0) || base.shape !== 'I') return base;
  return {
    ...base,
    name: `${base.name}+haunch`,
    h: base.h + extra,
    area: base.area + base.tw * extra,
    massPerMetre: base.massPerMetre * (1 + extra / base.h / 2),
    perimeter: base.perimeter + 2 * extra,
  };
}

/** Extra depth at distance `s` from the rafter end: h at the end plate face and inside the column, linear to 0 over the haunch length. */
function extraDepth(base: SteelProfile, end: HaunchEnd | null, s: number): number {
  if (!end || !(end.length > 0)) return 0;
  return base.h * Math.min(1, Math.max(0, 1 - (s - end.face) / end.length));
}

/**
 * Stepped pieces of a rafter of `length` mm (analysis start → end) with haunches at its start / end: HAUNCH_PIECES equal pieces over each
 * haunched stretch (face + length, at most 45 % of the rafter), one plain piece in between.
 */
export function rafterPieces(base: SteelProfile, length: number, ends: readonly [HaunchEnd | null, HaunchEnd | null]): RafterPiece[] {
  const zone = (end: HaunchEnd | null): number => (end && end.length > 0 ? Math.min(end.face + end.length, 0.45 * length) : 0);
  const [startZone, endZone] = [zone(ends[0]), zone(ends[1])];
  const extraAt = (s: number): number => Math.max(extraDepth(base, ends[0], s), extraDepth(base, ends[1], length - s));
  const stations: number[] = [0];
  for (let index = 1; startZone > 0 && index <= HAUNCH_PIECES; index++) stations.push((startZone * index) / HAUNCH_PIECES);
  const plainEnd = length - endZone;
  if (plainEnd > (stations[stations.length - 1] as number) + 1e-9) stations.push(plainEnd);
  for (let index = 1; endZone > 0 && index <= HAUNCH_PIECES; index++) stations.push(plainEnd + (endZone * index) / HAUNCH_PIECES);
  return stations.slice(1).map((to, index): RafterPiece => {
    const from = stations[index] as number;
    const middle = extraAt((from + to) / 2);
    const weakest = Math.min(extraAt(from), extraAt(to));
    return {
      from,
      to,
      stiffness: haunchedProfile(base, middle),
      resistance: weakest > 0 || middle > 0 ? haunchedProfile(base, weakest) : null,
    };
  });
}

/** Haunch of a rafter at its element start / end from the moment connections (the apex partner gets the haunch of the connection). */
export function haunchEndsOf(
  building: BuildingModel,
  rafter: SteelMemberElement,
  mm: (value: number) => number,
  columnDepth: (columnId: string) => number,
): readonly [HaunchEnd | null, HaunchEnd | null] {
  const ends: [HaunchEnd | null, HaunchEnd | null] = [null, null];
  const length = mm(distance3(rafter.start, rafter.end));
  const horizontal = Math.hypot(mm(rafter.end[0] - rafter.start[0]), mm(rafter.end[1] - rafter.start[1]));
  const slope = length > 0 ? horizontal / length : 1;
  const set = (end: 'start' | 'end', value: HaunchEnd): void => {
    ends[end === 'start' ? 0 : 1] = value;
  };
  for (const connection of Object.values(building.elements)) {
    if (connection.category !== 'connection' || !(connection.haunchLength > 0)) continue;
    const lengthMm = mm(connection.haunchLength);
    if (connection.rafterId === rafter.id) {
      set(connection.end, {
        face: connection.kind === 'eaves' && slope > 0.2 ? columnDepth(connection.otherId) / 2 / slope : 0,
        length: lengthMm,
      });
    } else if (connection.kind === 'apex' && connection.otherId === rafter.id) {
      const host = building.elements[connection.rafterId];
      if (host?.category !== 'member') continue;
      const joint = host[connection.end];
      const distance = (point: Vec3): number => distance3(point, joint);
      set(distance(rafter.start) <= distance(rafter.end) ? 'start' : 'end', { face: 0, length: lengthMm });
    }
  }
  return ends;
}
