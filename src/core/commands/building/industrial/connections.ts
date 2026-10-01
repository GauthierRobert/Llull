/**
 * Portal frame moment connections: bolted end plates at eaves (with haunch) and apex joints.
 * @layer core/commands/building/industrial
 */

import type {
  BuildingModel,
  MomentConnectionElement,
  SteelMemberElement,
} from '../../../model/building';
import type { CadDocument, Vec3 } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  nextElementId,
  nextMark,
  noChange,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { findProfile } from '../steel/profiles';
import { boltSize } from './evaluate';

const STEEL_DENSITY_KG_PER_M3 = 7850;

/** Steel mass of a connection in kg: end plate(s) + haunch (half the rafter section per metre). */
export function connectionMass(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): number {
  const rafter = building.elements[connection.rafterId];
  const profile = rafter?.category === 'member' ? findProfile(rafter.profile) : undefined;
  if (!profile) return 0;
  const metres = (value: number): number => value / fromMm(doc, 1000);
  const haunch = connection.haunchLength > 0 ? profile.h : 0;
  const plateHeight = metres(fromMm(doc, profile.h + haunch + 50));
  const plateWidth = metres(fromMm(doc, profile.b + 20));
  const plates = connection.kind === 'apex' ? 2 : 1;
  return (
    plates *
      plateHeight *
      plateWidth *
      metres(connection.plateThickness) *
      STEEL_DENSITY_KG_PER_M3 +
    (metres(connection.haunchLength) * profile.massPerMetre) / 2
  );
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Unconnected rafter joints of `members`: rafter end on a column top (eaves) or a rafter end (apex). */
export function findMomentJoints(
  building: BuildingModel,
  levelId: string,
  rafterIds: ReadonlySet<string> | null,
  tolerance: number,
): Array<Pick<MomentConnectionElement, 'kind' | 'rafterId' | 'end' | 'otherId'>> {
  const members = Object.values(building.elements).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.levelId === levelId,
  );
  const connected = new Set(
    Object.values(building.elements).flatMap((element) =>
      element.category === 'connection'
        ? [`${element.rafterId}:${element.end}`, `${element.otherId}:apex`]
        : [],
    ),
  );
  const joints: Array<Pick<MomentConnectionElement, 'kind' | 'rafterId' | 'end' | 'otherId'>> = [];
  for (const rafter of members) {
    if (rafter.role !== 'rafter' || (rafterIds && !rafterIds.has(rafter.id))) continue;
    for (const end of ['start', 'end'] as const) {
      if (connected.has(`${rafter.id}:${end}`)) continue;
      const point = rafter[end];
      const column = members.find(
        (member) =>
          member.role === 'column' &&
          distance(member.start[2] >= member.end[2] ? member.start : member.end, point) <=
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
          (distance(member.start, point) <= tolerance || distance(member.end, point) <= tolerance),
      );
      if (partner && rafter.id < partner.id && !connected.has(`${rafter.id}:apex`)) {
        joints.push({ kind: 'apex', rafterId: rafter.id, end, otherId: partner.id });
      }
    }
  }
  return joints;
}

interface ConnectionSize {
  readonly plateThickness?: number;
  readonly boltDiameter?: number;
  readonly haunchLength?: number;
}

/** Adds a moment connection per joint (no regeneration). */
export function appendConnections(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  joints: ReadonlyArray<Pick<MomentConnectionElement, 'kind' | 'rafterId' | 'end' | 'otherId'>>,
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

interface AddMomentConnectionsParams {
  rafterIds?: string[];
  levelId?: string;
  plateThickness?: number;
  boltDiameter?: number;
  haunchLength?: number;
}

/**
 * @command add_moment_connections
 * @pure
 * @affects creates 1 connection per unconnected eaves / apex joint of the rafters
 * @failure bad sizes / no unconnected joints -> no-op
 */
export const addMomentConnections: CommandDefinition<AddMomentConnectionsParams> = {
  name: 'add_moment_connections',
  description:
    'Detail the portal frame moment connections: a bolted end plate at every rafter-to-column joint ' +
    '(eaves, with a haunch under the rafter) and a pair of end plates at every rafter-to-rafter joint ' +
    '(apex), for the given rafters or every rafter of the level. Sized from the rafter section ' +
    '(plate 20/25 mm, M20 bolts, haunch = 1/5 of the rafter plan length). Follows the rafter; plate, ' +
    'haunch and bolt quantities feed the takeoff and the connection schedule.',
  paramsSchema: {
    type: 'object',
    properties: {
      rafterIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Rafter member ids. Default: every rafter of the level.',
      },
      levelId: { type: 'string', description: 'Level id. Default: the active level.' },
      plateThickness: { type: 'number', description: 'End plate thickness. Default 20 / 25 mm.' },
      boltDiameter: { type: 'number', description: 'Bolt diameter. Default 20 mm (M20).' },
      haunchLength: {
        type: 'number',
        description: 'Eaves haunch length along the rafter. Default 1/5 of its plan length.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const positive = (value: number | undefined): boolean =>
      value === undefined || (isFiniteNumber(value) && value > 0);
    if (
      !positive(params.plateThickness) ||
      !positive(params.boltDiameter) ||
      !positive(params.haunchLength)
    ) {
      return noChange(
        doc,
        'add_moment_connections failed: plateThickness, boltDiameter and haunchLength must be > 0.',
      );
    }
    const building = getBuilding(doc);
    if (params.levelId !== undefined && !building.levels[params.levelId]) {
      return noChange(doc, `add_moment_connections failed: no level '${params.levelId}'.`);
    }
    const levelId = params.levelId ?? building.activeLevelId ?? building.levelOrder[0] ?? '';
    const joints = findMomentJoints(
      building,
      levelId,
      Array.isArray(params.rafterIds) ? new Set(params.rafterIds) : null,
      fromMm(doc, 10),
    );
    if (joints.length === 0) {
      return noChange(
        doc,
        'add_moment_connections failed: no unconnected rafter-to-column or rafter-to-rafter joint found.',
      );
    }
    const added = appendConnections(doc, building, levelId, joints, {
      ...(params.plateThickness !== undefined ? { plateThickness: params.plateThickness } : {}),
      ...(params.boltDiameter !== undefined ? { boltDiameter: params.boltDiameter } : {}),
      ...(params.haunchLength !== undefined ? { haunchLength: params.haunchLength } : {}),
    });
    const document = regenerateBuilding(doc, added.building);
    const connections = added.ids.map(
      (id) => added.building.elements[id] as MomentConnectionElement,
    );
    const eaves = connections.filter((connection) => connection.kind === 'eaves').length;
    const bolts = connections.reduce((sum, connection) => sum + 2 * connection.boltRows, 0);
    const kilograms = connections.reduce(
      (sum, connection) => sum + connectionMass(doc, added.building, connection),
      0,
    );
    return {
      document,
      summary:
        `Added ${connections.length} moment connection(s): ${eaves} eaves (haunched), ` +
        `${connections.length - eaves} apex; ${bolts} bolt(s) ${boltSize(doc, connections[0]?.boltDiameter ?? 0)}, ` +
        `${kilograms.toFixed(1)} kg of plates and haunches.`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
};
