/**
 * DSTV NC1 export: one numerical-control file per steel piece (members, base plates, connection
 * end plates) for CNC saw / drill / profile-cutting lines. All lengths are millimetres.
 * @layer core/commands/building/industrial
 */

import type {
  BasePlateElement,
  BuildingLevel,
  MomentConnectionElement,
  SteelMemberElement,
} from '../../../model/building';
import type { CadDocument, Vec3 } from '../../../model/types';
import type { CommandDefinition, CommandResult } from '../../types';
import { fileSlug, fromMm, getBuilding, noChange } from '../model';
import { sweepFrame } from '../mesh';
import { findProfile, type SteelProfile } from '../steel/profiles';
import { atLevel, connectionSolids, plateLayout } from './evaluate';

const STEEL_DENSITY_KG_PER_M3 = 7850;
const END_PLATE_HOLE_CLEARANCE_MM = 2;
const ANCHOR_HOLE_CLEARANCE_MM = 4;

type DstvFace = 'o' | 'u' | 'v';

interface NcHole {
  readonly face: DstvFace;
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
}

interface NcPiece {
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

export interface NcFile {
  readonly name: string;
  readonly content: string;
  readonly mark: string;
  readonly kind: 'member' | 'plate';
  readonly profile: string;
  readonly quantity: number;
  readonly length: number;
  readonly sourceIds: string[];
}

export interface NcExport {
  readonly files: NcFile[];
  readonly count: number;
}

interface ExportNcFilesParams {
  memberIds?: string[];
  includePlates?: boolean;
  levelId?: string;
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

function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function minus(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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
  const squaredDistance = (a: Vec3, b: Vec3): number => dot(minus(a, b), minus(a, b));
  for (const connection of connections) {
    const level = levels[connection.levelId];
    if (!level || (connection.rafterId !== member.id && connection.otherId !== member.id)) continue;
    const plates = connectionSolids(doc, connection, members, level)?.filter((solid) =>
      solid.part.startsWith('plate'),
    );
    for (const solid of plates ?? []) {
      const atStart = squaredDistance(solid.origin, start) <= squaredDistance(solid.origin, end);
      const into: Vec3 = atStart ? direction : [-direction[0], -direction[1], -direction[2]];
      const joint = atStart ? start : end;
      const slope = dot(into, solid.along);
      if (slope <= 1e-6) continue;
      const hosted =
        connection.rafterId === member.id
          ? solid.part === 'plate'
          : connection.kind === 'apex' && solid.part === 'plate-2';
      if (!hosted) continue;
      const cutback = dot(minus(solid.origin, joint), into) + solid.depth / slope;
      ends[atStart ? 'start' : 'end'] = Math.max(ends[atStart ? 'start' : 'end'], cutback);
    }
  }
  return ends.start + ends.end;
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
      const count = solid.outline.length;
      const [cx, cy] = solid.outline.reduce<[number, number]>(
        (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count],
        [0, 0],
      );
      const centre: Vec3 = [
        solid.origin[0] + solid.x[0] * cx + solid.y[0] * cy,
        solid.origin[1] + solid.x[1] * cx + solid.y[1] * cy,
        solid.origin[2] + solid.x[2] * cx + solid.y[2] * cy,
      ];
      const offset = minus(centre, start);
      const throughFlange =
        Math.abs(dot(solid.along, frame.v)) >= Math.abs(dot(solid.along, frame.u));
      const diameter = round2(mm(connection.boltDiameter) + END_PLATE_HOLE_CLEARANCE_MM);
      const x = round2(mm(dot(offset, frame.d)));
      holes.push(
        throughFlange
          ? {
              face: dot(solid.along, frame.v) > 0 ? 'o' : 'u',
              x,
              y: round2(mm(dot(offset, frame.u)) + profile.b / 2),
              diameter,
            }
          : {
              face: 'v',
              x,
              y: round2(mm(dot(offset, frame.v)) + profile.h / 2),
              diameter,
            },
      );
    }
  }
  return holes;
}

function platePiece(
  doc: CadDocument,
  parts: {
    mark: string;
    grade: string;
    length: number;
    width: number;
    thickness: number;
    holes: ReadonlyArray<NcHole>;
    sourceId: string;
  },
): NcPiece {
  const mm = (value: number): number => value / fromMm(doc, 1);
  const [length, width, thickness] = [
    round2(mm(parts.length)),
    round2(mm(parts.width)),
    round2(mm(parts.thickness)),
  ];
  return {
    kind: 'plate',
    mark: parts.mark,
    grade: parts.grade,
    profileName: `PL${thickness}`,
    code: 'B',
    length,
    height: width,
    flangeWidth: width,
    flangeThickness: thickness,
    webThickness: thickness,
    massPerMetre: round2((width / 1000) * (thickness / 1000) * STEEL_DENSITY_KG_PER_M3),
    paintPerMetre: round2((2 * (width + thickness)) / 1000),
    cuts: [0, 0, 0, 0],
    holes: parts.holes,
    contour: [
      [0, 0],
      [length, 0],
      [length, width],
      [0, width],
      [0, 0],
    ],
    sourceIds: [parts.sourceId],
  };
}

function numberField(value: number): string {
  return `  ${value.toFixed(2).padStart(10)}`;
}

function textField(value: string): string {
  return `  ${value}`;
}

/** DSTV NC1 text for one piece (`quantity` pieces of the same mark). */
function renderPiece(
  piece: NcPiece,
  quantity: number,
  orderNumber: string,
  drawingNumber: string,
): string {
  const lines: string[] = [
    'ST',
    textField(orderNumber),
    textField(drawingNumber),
    textField('1'),
    textField(piece.mark),
    textField(piece.grade),
    textField(String(quantity)),
    textField(piece.profileName),
    textField(piece.code),
    ...[
      piece.length,
      piece.height,
      piece.flangeWidth,
      piece.flangeThickness,
      piece.webThickness,
      0,
      piece.massPerMetre,
      piece.paintPerMetre,
      ...piece.cuts,
    ].map(numberField),
    textField(''),
  ];
  if (piece.contour.length > 0) {
    lines.push('AK', ...piece.contour.map(([x, y]) => `  o${numberField(x)}${numberField(y)}`));
  }
  if (piece.holes.length > 0) {
    lines.push(
      'BO',
      ...piece.holes.map(
        (hole) =>
          `  ${hole.face}${numberField(hole.x)}${numberField(hole.y)}${numberField(hole.diameter)}`,
      ),
    );
  }
  lines.push('EN');
  return `${lines.join('\n')}\n`;
}

function pieceKey(piece: NcPiece): string {
  const holes = piece.holes.map((hole) => `${hole.face},${hole.x},${hole.y},${hole.diameter}`);
  return [
    piece.kind,
    piece.profileName,
    piece.grade,
    piece.length,
    piece.height,
    piece.cuts.join(','),
    holes.sort().join(';'),
  ].join('|');
}

function buildFiles(
  pieces: ReadonlyArray<NcPiece>,
  orderNumber: string,
  drawingNumber: string,
): NcFile[] {
  const groups = new Map<string, NcPiece[]>();
  for (const piece of pieces) {
    const key = pieceKey(piece);
    groups.set(key, [...(groups.get(key) ?? []), piece]);
  }
  const usedNames = new Set<string>();
  const files: NcFile[] = [];
  for (const group of groups.values()) {
    const first = group[0] as NcPiece;
    const slug = fileSlug(first.mark, first.kind);
    let name = `${slug}.nc1`;
    for (let suffix = 2; usedNames.has(name); suffix++) name = `${slug}-${suffix}.nc1`;
    usedNames.add(name);
    files.push({
      name,
      content: renderPiece(first, group.length, orderNumber, drawingNumber),
      mark: first.mark,
      kind: first.kind,
      profile: first.profileName,
      quantity: group.length,
      length: first.length,
      sourceIds: group.flatMap((piece) => piece.sourceIds),
    });
  }
  return files;
}

/**
 * @command export_nc_files
 * @pure read-only
 * @affects none; data = { files: [{ name, content, mark, kind, profile, quantity, length, sourceIds }], count }
 * @invariant identical pieces (profile, length, cuts, holes, grade) share one file with quantity > 1
 * @failure no steel members / unknown level / bad params -> no-op, affected:[]
 */
export const exportNcFiles: CommandDefinition<ExportNcFilesParams> = {
  name: 'export_nc_files',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Export DSTV NC1 numerical-control files (one per distinct piece) for CNC saw-drill-cutting lines. ' +
    'Steel members get an ST header (profile, code letter I/U/M/RO/L, length, section sizes, mass, ' +
    'painted surface, cut angles; rafters are cut to the roof pitch) and a BO block for bolt holes ' +
    'where the model has them (column flange holes at eaves moment connections). Base plates and ' +
    'connection end plates become separate code-B files with an AK contour and BO holes. Identical ' +
    'pieces are grouped into one file with a quantity. All numbers are millimetres whatever the ' +
    'document unit. data.files[].content holds each NC1 file text.',
  paramsSchema: {
    type: 'object',
    properties: {
      memberIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Steel member ids to export (also selects the base plates and end plates they host). Default: every steel member.',
      },
      includePlates: {
        type: 'boolean',
        description:
          'Also export base plates and connection end plates as separate NC files. Default true.',
      },
      levelId: {
        type: 'string',
        description: 'Only export pieces of this level id. Default: all levels.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const { memberIds, includePlates = true, levelId } = params;
    if (
      memberIds !== undefined &&
      !(Array.isArray(memberIds) && memberIds.every((id) => typeof id === 'string'))
    ) {
      return noChange(doc, 'export_nc_files failed: memberIds must be an array of strings.');
    }
    if (typeof includePlates !== 'boolean') {
      return noChange(doc, 'export_nc_files failed: includePlates must be a boolean.');
    }
    const building = getBuilding(doc);
    if (levelId !== undefined && !building.levels[levelId]) {
      return noChange(doc, `export_nc_files failed: no level '${String(levelId)}'.`);
    }
    const elements = building.elementOrder.flatMap((id) => {
      const element = building.elements[id];
      return element ? [element] : [];
    });
    const allMembers: Record<string, SteelMemberElement | undefined> = {};
    const allConnections: MomentConnectionElement[] = [];
    for (const element of elements) {
      if (element.category === 'member') allMembers[element.id] = element;
      else if (element.category === 'connection') allConnections.push(element);
    }
    const selected = memberIds ? new Set(memberIds) : null;
    const inScope = (host: string, hostLevel: string): boolean =>
      (selected ? selected.has(host) : true) && (levelId === undefined || hostLevel === levelId);

    const pieces: NcPiece[] = [];
    for (const element of elements) {
      if (element.category !== 'member' || !inScope(element.id, element.levelId)) continue;
      const profile = findProfile(element.profile);
      const frame = sweepFrame(element.start, element.end, element.roll);
      if (!profile || !frame) continue;
      const cut = pitchCut(element);
      pieces.push({
        kind: 'member',
        mark: element.mark,
        grade: element.material,
        profileName: profile.name,
        code: CODE_BY_SHAPE[profile.shape],
        length: round2(
          (frame.length -
            endPlateCutback(doc, element, frame.d, allConnections, allMembers, building.levels)) /
            fromMm(doc, 1),
        ),
        height: profile.h,
        flangeWidth: profile.b,
        flangeThickness: profile.tf,
        webThickness: profile.tw,
        massPerMetre: profile.massPerMetre,
        paintPerMetre: round2(profile.perimeter / 1000),
        cuts: [cut, cut, 0, 0],
        holes: memberHoles(doc, element, profile, allConnections, allMembers, building.levels),
        contour: [],
        sourceIds: [element.id],
      });
    }
    if (pieces.length === 0) {
      return noChange(
        doc,
        'export_nc_files: no steel members to export (add_steel_member / add_portal_frame_building first, or check memberIds / levelId).',
      );
    }
    const memberPieceCount = pieces.length;

    if (includePlates) {
      for (const element of elements) {
        if (element.category === 'plate') {
          const plate: BasePlateElement = element;
          const column = allMembers[plate.memberId];
          const level = building.levels[plate.levelId];
          if (!column || !level || !inScope(column.id, plate.levelId)) continue;
          const layout = plateLayout(doc, plate, column, level);
          if (!layout) continue;
          const [cos, sin] = [Math.cos(layout.angle), Math.sin(layout.angle)];
          const mm = (value: number): number => value / fromMm(doc, 1);
          const foot = layout.center;
          pieces.push(
            platePiece(doc, {
              mark: plate.mark,
              grade: plate.material,
              length: plate.length,
              width: plate.width,
              thickness: plate.thickness,
              sourceId: plate.id,
              holes: layout.bolts.map((bolt): NcHole => {
                const [dx, dy] = [bolt[0] - foot[0], bolt[1] - foot[1]];
                return {
                  face: 'o',
                  x: round2(mm(dx * cos + dy * sin + plate.length / 2)),
                  y: round2(mm(-dx * sin + dy * cos + plate.width / 2)),
                  diameter: round2(mm(plate.boltDiameter) + ANCHOR_HOLE_CLEARANCE_MM),
                };
              }),
            }),
          );
        } else if (element.category === 'connection') {
          const level = building.levels[element.levelId];
          if (!level || !inScope(element.rafterId, element.levelId)) continue;
          const solids = connectionSolids(doc, element, allMembers, level);
          const mm = (value: number): number => value / fromMm(doc, 1);
          const outline = solids?.find((solid) => solid.part === 'plate')?.outline;
          if (!solids || !outline) continue;
          const xs = outline.map((point) => point[0]);
          const ys = outline.map((point) => point[1]);
          const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
          const holes = solids
            .filter((solid) => solid.part.startsWith('bolt-'))
            .map((solid): NcHole => {
              const count = solid.outline.length;
              const [cx, cy] = solid.outline.reduce<[number, number]>(
                (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count],
                [0, 0],
              );
              return {
                face: 'o',
                x: round2(mm(cy - minY)),
                y: round2(mm(cx - minX)),
                diameter: round2(mm(element.boltDiameter) + END_PLATE_HOLE_CLEARANCE_MM),
              };
            });
          solids
            .filter((solid) => solid.part.startsWith('plate'))
            .forEach((solid, index) => {
              pieces.push(
                platePiece(doc, {
                  mark: index === 0 ? element.mark : `${element.mark}b`,
                  grade: element.material,
                  length: Math.max(...solid.outline.map((point) => point[1])) - minY,
                  width: Math.max(...solid.outline.map((point) => point[0])) - minX,
                  thickness: element.plateThickness,
                  holes,
                  sourceId: element.id,
                }),
              );
            });
        }
      }
    }

    const files = buildFiles(pieces, building.project.name, building.project.drawingNumber);
    const memberFiles = files.filter((file) => file.kind === 'member').length;
    const plateCount = pieces.length - memberPieceCount;
    const data: NcExport = { files, count: files.length };
    return {
      document: doc,
      summary: `DSTV NC1: ${files.length} file(s) — ${memberFiles} member file(s) for ${memberPieceCount} piece(s), ${files.length - memberFiles} plate file(s) for ${plateCount} plate(s).`,
      affected: [],
      data,
    };
  },
};
