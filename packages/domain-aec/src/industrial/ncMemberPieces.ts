/**
 * DSTV NC1 pieces for steel members: end-plate cutback, rafter pitch cut, eaves bolt holes. Millimetres.
 * @layer domain-aec
 * @pure
 */

import type {
  BuildingLevel,
  MomentConnectionElement,
  SteelMemberElement,
} from '@core/model/building';
import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import { fromMm } from '../model';
import { sweepFrame } from '../mesh';
import { distanceSq3, dot3, sub3 } from '@lib/vec3';
import type { SteelProfile } from '../steel/profiles';
import { atLevel } from './evaluate';
import { connectionSolids } from './evaluateConnections';

export const END_PLATE_HOLE_CLEARANCE_MM = 2;
export const ANCHOR_HOLE_CLEARANCE_MM = 4;

type DstvFace = 'o' | 'u' | 'v';

export interface NcHole {
  readonly face: DstvFace;
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
}

export interface NcPiece {
  readonly kind: 'member' | 'plate';
  readonly mark: string;
  readonly grade: string;
  readonly profileName: string;
  readonly code: string;
  readonly length: number;
  readonly height: number;
  readonly flangeWidth: number;
  readonly flangeThickness: number;
  readonly webThickness: number;
  readonly massPerMetre: number;
  readonly paintPerMetre: number;
  /** Cut angles in degrees: web start, web end, flange start, flange end. */
  readonly cuts: readonly [number, number, number, number];
  readonly holes: ReadonlyArray<NcHole>;
  /** AK outer contour (mm, plate corner origin), plates only. */
  readonly contour: ReadonlyArray<readonly [number, number]>;
  readonly sourceIds: ReadonlyArray<string>;
}

const CODE_BY_SHAPE: Readonly<Record<SteelProfile['shape'], string>> = {
  I: 'I',
  U: 'U',
  C: 'U',
  SHS: 'M',
  RHS: 'M',
  CHS: 'RO',
  L: 'L',
};

export function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** Rafter end cut: the end plate is vertical, so the cut equals the roof pitch. */
function pitchCut(member: SteelMemberElement): number {
  if (member.role !== 'rafter') return 0;
  const [dx, dy, dz] = [
    member.end[0] - member.start[0],
    member.end[1] - member.start[1],
    member.end[2] - member.start[2],
  ];
  const horizontal = Math.hypot(dx, dy);
  if (horizontal <= 0.2 * Math.hypot(dx, dy, dz)) return 0;
  return round2((Math.atan2(Math.abs(dz), horizontal) * 180) / Math.PI);
}

/** Length (document units) removed from a member by the end plates welded to its ends. */
function endPlateCutback(
  doc: CadDocument,
  member: SteelMemberElement,
  direction: Vec3,
  connections: ReadonlyArray<MomentConnectionElement>,
  members: Readonly<Record<string, SteelMemberElement | undefined>>,
  levels: Readonly<Record<string, BuildingLevel | undefined>>,
): number {
  const ends = { start: 0, end: 0 };
  const [start, end] = [
    atLevel(levels[member.levelId] as BuildingLevel, member.start),
    atLevel(levels[member.levelId] as BuildingLevel, member.end),
  ];
  for (const connection of connections) {
    const level = levels[connection.levelId];
    if (!level || (connection.rafterId !== member.id && connection.otherId !== member.id)) continue;
    const plates = connectionSolids(doc, connection, members, level)?.filter((solid) =>
      solid.part.startsWith('plate'),
    );
    for (const solid of plates ?? []) {
      const atStart = distanceSq3(solid.origin, start) <= distanceSq3(solid.origin, end);
      const into: Vec3 = atStart ? direction : [-direction[0], -direction[1], -direction[2]];
      const joint = atStart ? start : end;
      const slope = dot3(into, solid.along);
      if (slope <= 1e-6) continue;
      const hosted =
        connection.rafterId === member.id
          ? solid.part === 'plate'
          : connection.kind === 'apex' && solid.part === 'plate-2';
      if (!hosted) continue;
      const cutback = dot3(sub3(solid.origin, joint), into) + solid.depth / slope;
      ends[atStart ? 'start' : 'end'] = Math.max(ends[atStart ? 'start' : 'end'], cutback);
    }
  }
  return ends.start + ends.end;
}

export function outlineMean(outline: ReadonlyArray<Vec2>): Vec2 {
  const count = outline.length;
  return outline.reduce<Vec2>(
    (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count],
    [0, 0],
  );
}

function memberHoles(
  doc: CadDocument,
  member: SteelMemberElement,
  profile: SteelProfile,
  connections: ReadonlyArray<MomentConnectionElement>,
  members: Readonly<Record<string, SteelMemberElement | undefined>>,
  levels: Readonly<Record<string, BuildingLevel | undefined>>,
): NcHole[] {
  const mm = (value: number): number => value / fromMm(doc, 1);
  const holes: NcHole[] = [];
  for (const connection of connections) {
    const level = levels[connection.levelId];
    if (connection.kind !== 'eaves' || connection.otherId !== member.id || !level) continue;
    const solids = connectionSolids(doc, connection, members, level);
    const [start, end] = [atLevel(level, member.start), atLevel(level, member.end)];
    const frame = sweepFrame(start, end, member.roll);
    if (!solids || !frame) continue;
    for (const solid of solids) {
      if (!solid.part.startsWith('bolt-')) continue;
      const [cx, cy] = outlineMean(solid.outline);
      const centre: Vec3 = [
        solid.origin[0] + solid.x[0] * cx + solid.y[0] * cy,
        solid.origin[1] + solid.x[1] * cx + solid.y[1] * cy,
        solid.origin[2] + solid.x[2] * cx + solid.y[2] * cy,
      ];
      const offset = sub3(centre, start);
      const throughFlange =
        Math.abs(dot3(solid.along, frame.v)) >= Math.abs(dot3(solid.along, frame.u));
      const diameter = round2(mm(connection.boltDiameter) + END_PLATE_HOLE_CLEARANCE_MM);
      const x = round2(mm(dot3(offset, frame.d)));
      holes.push(
        throughFlange
          ? {
              face: dot3(solid.along, frame.v) > 0 ? 'o' : 'u',
              x,
              y: round2(mm(dot3(offset, frame.u)) + profile.b / 2),
              diameter,
            }
          : {
              face: 'v',
              x,
              y: round2(mm(dot3(offset, frame.v)) + profile.h / 2),
              diameter,
            },
      );
    }
  }
  return holes;
}

export function memberPiece(
  doc: CadDocument,
  element: SteelMemberElement,
  profile: SteelProfile,
  frame: NonNullable<ReturnType<typeof sweepFrame>>,
  connections: ReadonlyArray<MomentConnectionElement>,
  members: Readonly<Record<string, SteelMemberElement | undefined>>,
  levels: Readonly<Record<string, BuildingLevel | undefined>>,
): NcPiece {
  const cut = pitchCut(element);
  return {
    kind: 'member',
    mark: element.mark,
    grade: element.material,
    profileName: profile.name,
    code: CODE_BY_SHAPE[profile.shape],
    length: round2(
      (frame.length - endPlateCutback(doc, element, frame.d, connections, members, levels)) /
        fromMm(doc, 1),
    ),
    height: profile.h,
    flangeWidth: profile.b,
    flangeThickness: profile.tf,
    webThickness: profile.tw,
    massPerMetre: profile.massPerMetre,
    paintPerMetre: round2(profile.perimeter / 1000),
    cuts: [cut, cut, 0, 0],
    holes: memberHoles(doc, element, profile, connections, members, levels),
    contour: [],
    sourceIds: [element.id],
  };
}
