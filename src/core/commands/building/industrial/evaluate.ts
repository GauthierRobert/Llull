/**
 * Evaluation of industrial elements: steel members, footings, cladding panels, equipment, pipes,
 * cable trays, base plates.
 * @layer core/commands/building/industrial
 * @pure
 */

import type {
  CadDocument,
  CylinderEntity,
  Entity,
  SphereEntity,
  Vec2,
  Vec3,
} from '../../../model/types';
import type {
  BasePlateElement,
  BuildingLevel,
  CableTrayElement,
  EquipmentElement,
  FootingElement,
  MemberRole,
  PanelElement,
  PipeElement,
  SteelMemberElement,
} from '../../../model/building';
import { fromMm } from '../model';
import { base, colorForMaterial, MEMBER_LAYER, meshEntity, orientedBox } from '../entities';
import { prismMesh, sweepFrame, sweepMesh } from '../mesh';
import { findProfile, profileOutline } from '../steel/profiles';

export const ROLE_LABEL: Readonly<Record<MemberRole, string>> = {
  column: 'Column',
  rafter: 'Rafter',
  beam: 'Beam',
  brace: 'Brace',
  purlin: 'Purlin',
  rail: 'Side rail',
  crane: 'Crane beam',
};

/** World position of a level-relative point. */
export function atLevel(level: BuildingLevel, point: Vec3): Vec3 {
  return [point[0], point[1], level.elevation + point[2]];
}

export function evaluateMember(
  doc: CadDocument,
  member: SteelMemberElement,
  level: BuildingLevel,
): Entity[] {
  const profile = findProfile(member.profile);
  if (!profile) return [];
  const { outer, holes } = profileOutline(profile);
  const mesh = sweepMesh(
    outer,
    holes,
    atLevel(level, member.start),
    atLevel(level, member.end),
    member.roll,
    fromMm(doc, 1),
  );
  if (!mesh) return [];
  return [
    meshEntity(
      member,
      {
        part: 'body',
        label: `${ROLE_LABEL[member.role]} ${member.mark} ${profile.name}`,
        layer: MEMBER_LAYER[member.role].name,
      },
      mesh,
      colorForMaterial(member.material, '#6e8296'),
    ),
  ];
}

export function evaluateFooting(footing: FootingElement, level: BuildingLevel): Entity[] {
  return [
    orientedBox(
      footing,
      { part: 'body', label: `Footing ${footing.mark}` },
      [
        footing.location[0],
        footing.location[1],
        level.elevation + footing.topOffset - footing.thickness / 2,
      ],
      0,
      [footing.width, footing.length, footing.thickness],
      colorForMaterial(footing.material, '#b4b2aa'),
    ),
  ];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossProduct = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** Newell normal of a planar 3D polygon (zero vector when degenerate). */
export function polygonNormal(points: ReadonlyArray<Vec3>): Vec3 {
  const normal: [number, number, number] = [0, 0, 0];
  points.forEach((current, index) => {
    const next = points[(index + 1) % points.length] as Vec3;
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  });
  return normal;
}

/** Local plane frame of a panel: origin, in-plane axes (e1, e2) and unit normal. */
export function panelFrame(corners: ReadonlyArray<Vec3>): {
  origin: Vec3;
  e1: Vec3;
  e2: Vec3;
  normal: Vec3;
} | null {
  const normalVector = polygonNormal(corners);
  if (Math.hypot(...normalVector) < 1e-9 || corners.length < 3) return null;
  const normal = unit(normalVector);
  const origin = corners[0] as Vec3;
  const e1 = unit(sub(corners[1] as Vec3, origin));
  const e2 = crossProduct(normal, e1);
  return { origin, e1, e2, normal };
}

export function evaluatePanel(panel: PanelElement, level: BuildingLevel): Entity[] {
  const world = panel.corners.map((corner) => atLevel(level, corner));
  const frame = panelFrame(world);
  if (!frame) return [];
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const local = world.map((point): Vec2 => {
    const offset = sub(point, frame.origin);
    return [dot(offset, frame.e1), dot(offset, frame.e2)];
  });
  const mesh = prismMesh(local, [], ([x, y], side) => [
    frame.origin[0] + frame.e1[0] * x + frame.e2[0] * y + frame.normal[0] * side * panel.thickness,
    frame.origin[1] + frame.e1[1] * x + frame.e2[1] * y + frame.normal[1] * side * panel.thickness,
    frame.origin[2] + frame.e1[2] * x + frame.e2[2] * y + frame.normal[2] * side * panel.thickness,
  ]);
  if (!mesh) return [];
  return [
    meshEntity(
      panel,
      { part: 'body', label: `${panel.role === 'roof' ? 'Roof' : 'Wall'} panel ${panel.mark}` },
      mesh,
      colorForMaterial(panel.material, '#9fb3c4'),
    ),
  ];
}

export function evaluateEquipment(equipment: EquipmentElement, level: BuildingLevel): Entity[] {
  const [length, width, height] = equipment.size;
  return [
    orientedBox(
      equipment,
      { part: 'body', label: `${equipment.name} ${equipment.mark}` },
      [equipment.location[0], equipment.location[1], level.elevation + height / 2],
      equipment.angle,
      [length, width, height],
      '#c27c2c',
    ),
  ];
}

const PIPE_SEGMENTS = 16;

export function evaluatePipe(pipe: PipeElement, level: BuildingLevel): Entity[] {
  const radius = pipe.diameter / 2;
  const circle = Array.from({ length: PIPE_SEGMENTS }, (_, index): Vec2 => {
    const angle = (index / PIPE_SEGMENTS) * Math.PI * 2;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  const color = colorForMaterial(pipe.material, '#2f9c8f');
  const points = pipe.points.map((point) => atLevel(level, point));
  const entities: Entity[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const mesh = sweepMesh(circle, [], points[index] as Vec3, points[index + 1] as Vec3, 0, 1);
    if (!mesh) continue;
    entities.push(
      meshEntity(
        pipe,
        { part: `segment-${index}`, label: `Pipe ${pipe.mark} ${pipe.service}` },
        mesh,
        color,
      ),
    );
  }
  for (let index = 1; index + 1 < points.length; index++) {
    const joint: SphereEntity = {
      ...base(
        pipe,
        { part: `joint-${index}`, label: `Pipe ${pipe.mark} bend` },
        points[index] as Vec3,
        [0, 0, 0],
        color,
      ),
      kind: 'sphere',
      radius,
    };
    entities.push(joint);
  }
  return entities;
}

/** Open-top U outline (x across the width, +y up), sheet thickness `sheet`. Counter-clockwise. */
export function trayOutline(width: number, height: number, sheet: number): Vec2[] {
  const [w, h, t] = [width / 2, height / 2, Math.min(sheet, width / 4, height / 2)];
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [w - t, h],
    [w - t, -h + t],
    [-w + t, -h + t],
    [-w + t, h],
    [-w, h],
  ];
}

export function evaluateTray(
  doc: Pick<CadDocument, 'units'>,
  tray: CableTrayElement,
  level: BuildingLevel,
): Entity[] {
  const outline = trayOutline(tray.width, tray.height, fromMm(doc, 2));
  const points = tray.points.map((point) => atLevel(level, point));
  const entities: Entity[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const mesh = sweepMesh(outline, [], points[index] as Vec3, points[index + 1] as Vec3, 0, 1);
    if (!mesh) continue;
    entities.push(
      meshEntity(
        tray,
        { part: `segment-${index}`, label: `Cable tray ${tray.mark} ${tray.system}` },
        mesh,
        colorForMaterial('galvanized steel', '#a07c2c'),
      ),
    );
  }
  return entities;
}

/** Anchor bolt size label, e.g. "M24" (diameter in document units). */
export function boltSize(doc: Pick<CadDocument, 'units'>, diameter: number): string {
  return `M${Math.round(diameter / fromMm(doc, 1))}`;
}

/** World placement of a base plate and its anchor bolts (null when the column is missing). */
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
