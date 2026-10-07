/**
 * Moment-connection joint discovery, creation and stale-joint removal.
 * @layer domain-aec
 * @pure
 */

import type {
  BuildingModel,
  MomentConnectionElement,
  SteelMemberElement,
} from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import { fromMm, nextElementId, nextMark, withElement, withoutElements } from '../model';
import { distance3 } from '@lib/vec3';
import { findProfile } from '../steel/profiles';

type MomentJoint = Pick<MomentConnectionElement, 'kind' | 'rafterId' | 'end' | 'otherId'>;

/** Unconnected rafter joints of `members`: rafter end on a column top (eaves) or a rafter end (apex). */
export function findMomentJoints(
  building: BuildingModel,
  levelId: string,
  rafterIds: ReadonlySet<string> | null,
  tolerance: number,
): MomentJoint[] {
  const members = Object.values(building.elements).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.levelId === levelId,
  );
  const existing = Object.values(building.elements).filter(
    (element): element is MomentConnectionElement => element.category === 'connection',
  );
  const connected = new Set(existing.map((element) => `${element.rafterId}:${element.end}`));
  const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const apexPairs = new Set(
    existing
      .filter((element) => element.kind === 'apex')
      .map((element) => pairKey(element.rafterId, element.otherId)),
  );
  const joints: MomentJoint[] = [];
  for (const rafter of members) {
    if (rafter.role !== 'rafter' || (rafterIds && !rafterIds.has(rafter.id))) continue;
    for (const end of ['start', 'end'] as const) {
      if (connected.has(`${rafter.id}:${end}`)) continue;
      const point = rafter[end];
      const column = members.find(
        (member) =>
          member.role === 'column' &&
          distance3(member.start[2] >= member.end[2] ? member.start : member.end, point) <=
            tolerance,
      );
      if (column) {
        joints.push({ kind: 'eaves', rafterId: rafter.id, end, otherId: column.id });
        continue;
      }
      const partner = members.find(
        (member) =>
          member.role === 'rafter' &&
          member.id !== rafter.id &&
          (distance3(member.start, point) <= tolerance ||
            distance3(member.end, point) <= tolerance),
      );
      if (partner && !apexPairs.has(pairKey(rafter.id, partner.id))) {
        apexPairs.add(pairKey(rafter.id, partner.id));
        joints.push({ kind: 'apex', rafterId: rafter.id, end, otherId: partner.id });
      }
    }
  }
  return joints;
}

interface ConnectionSize {
  readonly plateThickness?: number | undefined;
  readonly boltDiameter?: number | undefined;
  readonly haunchLength?: number | undefined;
}

/** Adds a moment connection per joint (no regeneration). */
export function appendConnections(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  joints: ReadonlyArray<MomentJoint>,
  size: ConnectionSize,
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids: string[] = [];
  for (const joint of joints) {
    const rafter = building.elements[joint.rafterId];
    const profile = rafter?.category === 'member' ? findProfile(rafter.profile) : undefined;
    if (!rafter || rafter.category !== 'member' || !profile) continue;
    const horizontal = Math.hypot(rafter.end[0] - rafter.start[0], rafter.end[1] - rafter.start[1]);
    const connection: MomentConnectionElement = {
      id: nextElementId(next, 'connection'),
      category: 'connection',
      mark: nextMark(next, 'connection'),
      entityIds: [],
      levelId,
      ...joint,
      plateThickness: size.plateThickness ?? fromMm(doc, profile.h >= 400 ? 25 : 20),
      boltRows: joint.kind === 'eaves' ? 4 : 3,
      boltDiameter: size.boltDiameter ?? fromMm(doc, 20),
      haunchLength: joint.kind === 'eaves' ? (size.haunchLength ?? horizontal / 5) : 0,
      material: 'S355',
    };
    next = withElement(next, connection);
    ids.push(connection.id);
  }
  return { building: next, ids };
}

/**
 * Connections of `memberId` whose joint no longer exists (rafter no longer a rafter, the column
 * top / partner rafter end moved away from the rafter end) are removed.
 */
export function dropStaleConnections(
  building: BuildingModel,
  memberId: string,
  tolerance: number,
): { building: BuildingModel; removed: string[] } {
  const member = (id: string): SteelMemberElement | undefined => {
    const element = building.elements[id];
    return element?.category === 'member' ? element : undefined;
  };
  const stale = Object.values(building.elements).filter(
    (element): element is MomentConnectionElement => {
      if (element.category !== 'connection') return false;
      if (element.rafterId !== memberId && element.otherId !== memberId) return false;
      const [rafter, other] = [member(element.rafterId), member(element.otherId)];
      if (!rafter || !other || rafter.role !== 'rafter') return true;
      const point = rafter[element.end];
      if (element.kind === 'eaves') {
        const top = other.start[2] >= other.end[2] ? other.start : other.end;
        return other.role !== 'column' || distance3(top, point) > tolerance;
      }
      return (
        other.role !== 'rafter' ||
        Math.min(distance3(other.start, point), distance3(other.end, point)) > tolerance
      );
    },
  );
  if (stale.length === 0) return { building, removed: [] };
  const removed = new Set(stale.map((element) => element.id));
  return { building: withoutElements(building, removed), removed: [...removed] };
}
