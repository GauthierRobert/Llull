/**
 * DSTV NC1 export: one numerical-control file per steel piece (members, base plates, connection
 * end plates) for CNC saw / drill / profile-cutting lines. All lengths are millimetres.
 * @layer domain-aec
 */

import type {
  BasePlateElement,
  MomentConnectionElement,
  SteelMemberElement,
} from '@core/model/building';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { fromMm, getBuilding } from '../model';
import { noop } from '@core/commands/noop';
import { sweepFrame } from '../mesh';
import { findProfile, STEEL_DENSITY_KG_PER_M3 } from '../steel/profiles';
import { connectionSolids, plateLayout } from './evaluateConnections';
import { buildFiles, type NcFile } from './ncFiles';
import {
  ANCHOR_HOLE_CLEARANCE_MM,
  END_PLATE_HOLE_CLEARANCE_MM,
  type NcHole,
  type NcPiece,
  memberPiece,
  outlineMean,
  round2,
} from './ncMemberPieces';

export interface NcExport {
  readonly files: NcFile[];
  readonly count: number;
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

type PlateLayout = NonNullable<ReturnType<typeof plateLayout>>;
type ConnectionSolids = NonNullable<ReturnType<typeof connectionSolids>>;

function basePlatePiece(doc: CadDocument, plate: BasePlateElement, layout: PlateLayout): NcPiece {
  const [cos, sin] = [Math.cos(layout.angle), Math.sin(layout.angle)];
  const mm = (value: number): number => value / fromMm(doc, 1);
  const foot = layout.center;
  return platePiece(doc, {
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
  });
}

/** One piece per end-plate solid of the connection (second plate marked `<mark>b`); none without a main plate. */
function endPlatePieces(
  doc: CadDocument,
  connection: MomentConnectionElement,
  solids: ConnectionSolids,
): NcPiece[] {
  const mm = (value: number): number => value / fromMm(doc, 1);
  const outline = solids.find((solid) => solid.part === 'plate')?.outline;
  if (!outline) return [];
  const xs = outline.map((point) => point[0]);
  const ys = outline.map((point) => point[1]);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const holes = solids
    .filter((solid) => solid.part.startsWith('bolt-'))
    .map((solid): NcHole => {
      const [cx, cy] = outlineMean(solid.outline);
      return {
        face: 'o',
        x: round2(mm(cy - minY)),
        y: round2(mm(cx - minX)),
        diameter: round2(mm(connection.boltDiameter) + END_PLATE_HOLE_CLEARANCE_MM),
      };
    });
  return solids
    .filter((solid) => solid.part.startsWith('plate'))
    .map((solid, index) =>
      platePiece(doc, {
        mark: index === 0 ? connection.mark : `${connection.mark}b`,
        grade: connection.material,
        length: Math.max(...solid.outline.map((point) => point[1])) - minY,
        width: Math.max(...solid.outline.map((point) => point[0])) - minX,
        thickness: connection.plateThickness,
        holes,
        sourceId: connection.id,
      }),
    );
}

/**
 * @command export_nc_files
 * @pure read-only
 * @affects none; data = { files: [{ name, content, mark, kind, profile, quantity, length, sourceIds }], count }
 * @invariant identical pieces (profile, length, cuts, holes, grade) share one file with quantity > 1
 * @failure no steel members / unknown level / bad params -> no-op, affected:[]
 */
export const exportNcFiles = defineCommand({
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
  params: z.object({
    memberIds: z
      .array(z.string())
      .optional()
      .describe(
        'Steel member ids to export (also selects the base plates and end plates they host). Default: every steel member.',
      ),
    includePlates: z
      .boolean()
      .optional()
      .describe(
        'Also export base plates and connection end plates as separate NC files. Default true.',
      ),
    levelId: z
      .string()
      .optional()
      .describe('Only export pieces of this level id. Default: all levels.'),
  }),
  run: (doc, params): CommandResult => {
    const { memberIds, includePlates = true, levelId } = params;
    const building = getBuilding(doc);
    if (levelId !== undefined && !building.levels[levelId]) {
      return noop(doc, `export_nc_files failed: no level '${String(levelId)}'.`);
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
      pieces.push(
        memberPiece(doc, element, profile, frame, allConnections, allMembers, building.levels),
      );
    }
    if (pieces.length === 0) {
      return noop(
        doc,
        'export_nc_files: no steel members to export (add_steel_member / add_portal_frame_building first, or check memberIds / levelId).',
      );
    }
    const memberPieceCount = pieces.length;

    if (includePlates) {
      for (const element of elements) {
        if (element.category === 'plate') {
          const column = allMembers[element.memberId];
          const level = building.levels[element.levelId];
          if (!column || !level || !inScope(column.id, element.levelId)) continue;
          const layout = plateLayout(doc, element, column, level);
          if (layout) pieces.push(basePlatePiece(doc, element, layout));
        } else if (element.category === 'connection') {
          const level = building.levels[element.levelId];
          if (!level || !inScope(element.rafterId, element.levelId)) continue;
          const solids = connectionSolids(doc, element, allMembers, level);
          if (solids) pieces.push(...endPlatePieces(doc, element, solids));
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
});
