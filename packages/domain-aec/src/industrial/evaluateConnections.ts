/**
 * Evaluation of bolted steel connections: base plates with anchor bolts and moment end-plate joints.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, CylinderEntity, Entity, Vec2, Vec3 } from '@core/model/types';
import type {
  BasePlateElement,
  BuildingLevel,
  BuildingModel,
  MomentConnectionElement,
  SteelMemberElement,
} from '@core/model/building';
import { fromMm } from '../model';
import { base, colorForMaterial, meshEntity, orientedBox } from '../entities';
import { prismMesh, sweepFrame } from '../mesh';
import { findProfile } from '../steel/profiles';
import { add3, scale3, sub3 } from '@lib/vec3';
import { atLevel, boltSize } from './evaluate';

/** World placement of a base plate and its anchor bolts. */
export interface PlateLayout {
  /** Plate centre (world). */
  readonly center: Vec3;
  /** Plan angle of the plate length axis (the column depth direction). */
  readonly angle: number;
  /** World plan positions of the bolts. */
  readonly bolts: Vec2[];
  /** Bolt projection above the plate top and embedment below its underside. */
  readonly boltAbove: number;
  readonly boltBelow: number;
}

export function plateLayout(
  doc: Pick<CadDocument, 'units'>,
  plate: BasePlateElement,
  member: SteelMemberElement,
  level: BuildingLevel,
): PlateLayout | null {
  const [start, end] = [atLevel(level, member.start), atLevel(level, member.end)];
  const foot = start[2] <= end[2] ? start : end;
  const frame = sweepFrame(start, end, member.roll);
  if (!frame) return null;
  const angle = Math.atan2(frame.v[1], frame.v[0]);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const edge = Math.max(2 * plate.boltDiameter, fromMm(doc, 40));
  const columns = Math.max(1, plate.boltCount / 2);
  const bolts: Vec2[] = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < columns; index++) {
      const along =
        columns === 1
          ? 0
          : -plate.length / 2 + edge + ((plate.length - 2 * edge) * index) / (columns - 1);
      const across = side * (plate.width / 2 - edge);
      bolts.push([foot[0] + along * cos - across * sin, foot[1] + along * sin + across * cos]);
    }
  }
  return {
    center: [foot[0], foot[1], foot[2] - plate.thickness / 2],
    angle,
    bolts,
    boltAbove: 3 * plate.boltDiameter,
    boltBelow: 12 * plate.boltDiameter,
  };
}

export function evaluatePlate(
  doc: Pick<CadDocument, 'units'>,
  plate: BasePlateElement,
  member: SteelMemberElement,
  level: BuildingLevel,
): Entity[] {
  const layout = plateLayout(doc, plate, member, level);
  if (!layout) return [];
  const color = colorForMaterial(plate.material, '#5d6f80');
  const top = layout.center[2] + plate.thickness / 2;
  const bottom = layout.center[2] - plate.thickness / 2;
  const boltHeight = layout.boltAbove + plate.thickness + layout.boltBelow;
  return [
    orientedBox(
      plate,
      { part: 'body', label: `Base plate ${plate.mark}` },
      layout.center,
      layout.angle,
      [plate.length, plate.width, plate.thickness],
      color,
    ),
    ...layout.bolts.map(
      (bolt, index): CylinderEntity => ({
        ...base(
          plate,
          {
            part: `bolt-${index}`,
            label: `Anchor bolt ${plate.mark} ${boltSize(doc, plate.boltDiameter)}`,
          },
          [bolt[0], bolt[1], (top + layout.boltAbove + bottom - layout.boltBelow) / 2],
          [0, 0, 0],
          '#3d4650',
        ),
        kind: 'cylinder',
        radius: plate.boltDiameter / 2,
        height: boltHeight,
      }),
    ),
  ];
}

/** One prism of a connection part: a 2D outline mapped into 3D, extruded along `along`. */
export interface ConnectionSolid {
  readonly part: string;
  readonly outline: Vec2[];
  readonly origin: Vec3;
  /** Local x / y axes of the outline and the extrusion direction (right-handed). */
  readonly x: Vec3;
  readonly y: Vec3;
  readonly along: Vec3;
  readonly depth: number;
}

/** World solids of a moment connection: end plate(s), haunch, bolts (null without its rafter). */
export function connectionSolids(
  doc: Pick<CadDocument, 'units'>,
  connection: MomentConnectionElement,
  members: Readonly<Record<string, SteelMemberElement | undefined>>,
  level: BuildingLevel,
): ConnectionSolid[] | null {
  const rafter = members[connection.rafterId];
  const other = members[connection.otherId];
  const profile = rafter ? findProfile(rafter.profile) : undefined;
  if (!rafter || !profile) return null;
  const mm = (value: number): number => fromMm(doc, value);
  /** Joint point, rafter frame into the rafter, and the vertical end-plate frame there. */
  const into = (
    member: SteelMemberElement,
    end: 'start' | 'end',
  ): {
    joint: Vec3;
    frame: NonNullable<ReturnType<typeof sweepFrame>>;
    plate: { x: Vec3; y: Vec3; along: Vec3; slope: number };
  } | null => {
    const [start, finish] = [atLevel(level, member.start), atLevel(level, member.end)];
    const [joint, away] = end === 'start' ? [start, finish] : [finish, start];
    const frame = sweepFrame(joint, away, member.roll);
    if (!frame) return null;
    const horizontal = Math.hypot(frame.d[0], frame.d[1]);
    // Vertical end plate (cut square to the column flange / the ridge); perpendicular to a
    // steep rafter.
    const plate =
      horizontal > 0.2
        ? {
            along: [frame.d[0] / horizontal, frame.d[1] / horizontal, 0] as Vec3,
            x: [-frame.d[1] / horizontal, frame.d[0] / horizontal, 0] as Vec3,
            y: [0, 0, 1] as Vec3,
            slope: horizontal,
          }
        : { along: frame.d, x: frame.u, y: frame.v, slope: 1 };
    return { joint, frame, plate };
  };
  const near = into(rafter, connection.end);
  if (!near) return null;
  const { joint, frame, plate } = near;
  const [h, b] = [mm(profile.h), mm(profile.b)];
  const haunchDepth = connection.haunchLength > 0 ? h : 0;
  // Plate heights measured on the vertical cut through the rafter (+ haunch).
  const top = h / 2 / plate.slope + mm(25);
  const bottom = -(h / 2 + haunchDepth) / plate.slope - mm(25);
  const width = b + mm(20);
  const t = connection.plateThickness;
  // Eaves: the end plate sits on the column flange face.
  const columnProfile = other ? findProfile(other.profile) : undefined;
  const offset =
    connection.kind === 'eaves' && columnProfile ? mm(columnProfile.h) / 2 / plate.slope : 0;
  const face = add3(joint, scale3(frame.d, offset));
  const rectangle = (x0: number, x1: number, y0: number, y1: number): Vec2[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const solids: ConnectionSolid[] = [
    {
      part: 'plate',
      outline: rectangle(-width / 2, width / 2, bottom, top),
      origin: face,
      x: plate.x,
      y: plate.y,
      along: plate.along,
      depth: t,
    },
  ];
  if (connection.kind === 'apex' && other) {
    const distanceTo = (point: Vec3): number => Math.hypot(...sub3(point, joint));
    const nearerEnd =
      distanceTo(atLevel(level, other.start)) <= distanceTo(atLevel(level, other.end))
        ? 'start'
        : 'end';
    const far = into(other, nearerEnd);
    if (far) {
      solids.push({
        part: 'plate-2',
        outline: rectangle(-width / 2, width / 2, bottom, top),
        origin: far.joint,
        x: far.plate.x,
        y: far.plate.y,
        along: far.plate.along,
        depth: t,
      });
    }
  }
  if (haunchDepth > 0) {
    // The haunch is cut vertically where it meets the (vertical) end plate.
    const tanSlope = plate.slope < 1 ? frame.d[2] / plate.slope : 0;
    solids.push({
      part: 'haunch',
      outline: [
        [(-h / 2) * tanSlope, h / 2],
        [connection.haunchLength, h / 2],
        [-(h / 2 + haunchDepth) * tanSlope, h / 2 + haunchDepth],
      ],
      origin: sub3(face, scale3(frame.u, b / 2)),
      x: frame.d,
      y: scale3(frame.v, -1),
      along: frame.u,
      depth: b,
    });
  }
  const edge = Math.max(2 * connection.boltDiameter, mm(40));
  const gauge = Math.max(width / 2 - edge, connection.boltDiameter);
  const radius = connection.boltDiameter / 2;
  const circle = Array.from({ length: 12 }, (_, index): Vec2 => {
    const angle = (index / 12) * Math.PI * 2;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  const rows = Math.max(1, connection.boltRows);
  // Through the end plate and the column flange / the other end plate.
  const boltStart = sub3(face, scale3(plate.along, t + connection.boltDiameter));
  for (let row = 0; row < rows; row++) {
    const y = rows === 1 ? 0 : top - edge - ((top - bottom - 2 * edge) * row) / (rows - 1);
    for (const x of [-gauge, gauge]) {
      solids.push({
        part: `bolt-${row}-${x < 0 ? 'l' : 'r'}`,
        outline: circle.map(([cx, cy]): Vec2 => [cx + x, cy + y]),
        origin: boltStart,
        x: plate.x,
        y: plate.y,
        along: plate.along,
        depth: 2 * t + 2 * connection.boltDiameter,
      });
    }
  }
  return solids;
}

/** `connectionSolids` resolved against `building` (the connection's level and joined members). */
export function buildingConnectionSolids(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  connection: MomentConnectionElement,
): ConnectionSolid[] | null {
  const level = building.levels[connection.levelId];
  if (!level) return null;
  const members: Record<string, SteelMemberElement | undefined> = {};
  for (const id of [connection.rafterId, connection.otherId]) {
    const element = building.elements[id];
    if (element?.category === 'member') members[id] = element;
  }
  return connectionSolids(doc, connection, members, level);
}

export function evaluateConnection(
  doc: Pick<CadDocument, 'units'>,
  connection: MomentConnectionElement,
  members: Readonly<Record<string, SteelMemberElement | undefined>>,
  level: BuildingLevel,
): Entity[] {
  const solids = connectionSolids(doc, connection, members, level);
  if (!solids) return [];
  const color = colorForMaterial(connection.material, '#5d6f80');
  return solids.flatMap((solid): Entity[] => {
    const mesh = prismMesh(solid.outline, [], ([x, y], side) => [
      solid.origin[0] + solid.x[0] * x + solid.y[0] * y + solid.along[0] * side * solid.depth,
      solid.origin[1] + solid.x[1] * x + solid.y[1] * y + solid.along[1] * side * solid.depth,
      solid.origin[2] + solid.x[2] * x + solid.y[2] * y + solid.along[2] * side * solid.depth,
    ]);
    return mesh
      ? [
          meshEntity(
            connection,
            { part: solid.part, label: `Connection ${connection.mark} ${solid.part}` },
            mesh,
            solid.part.startsWith('bolt') ? '#3d4650' : color,
          ),
        ]
      : [];
  });
}
