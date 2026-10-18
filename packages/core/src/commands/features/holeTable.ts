/** hole_table (07 FTR M6, FR-FTR-29): the holes of a part as table rows, positions from the top-left corner of their face (drawing hole table). */

import { type CadDocument, type Vec2, type Vec3, is3D } from '../../model/types';
import type { FtrResultMeta, FtrUnverifiedInput, Named } from '../../model/manufacturing';
import type { HoleKind } from '../../model/features';
import { type MachinedHole, authoredFeatures } from '../../geometry/featureInstances';
import { drillTipHeight } from '../../lib/holeMath';
import { recipeOf } from '../../geometry/shapeRecipe';
import { worldToFrame } from '../../geometry/featureFrame';
import { dot3 } from '../../lib/vec3';
import type { CommandResult } from '../types';
import { defineCommand, vec2, z } from '../schema';
import { currentContext } from '../context';
import { operandRecipe } from '../brep/kernelShape';
import { report } from '../noop';
import { machinedPart } from './machined';
import { refuse, resultMeta } from './ftr';

const DRILL_POINT_SOURCE = 'R8';

export interface HoleRow {
  readonly label: string;
  readonly id: string;
  /** Distance from the datum along the face's u axis, document length units. */
  readonly x: number;
  /** Distance from the datum down the face (the datum is the top-left corner: y grows downwards), document length units. */
  readonly y: number;
  readonly face: Vec3;
  /** Hole centre on its face in the part's own (mesh) coordinates, document length units: where a viewer marks it. */
  readonly at: Vec3;
  readonly subtype: HoleKind;
  readonly diameter: number;
  readonly cskDiameter?: number;
  readonly cskAngleDeg?: number;
  readonly cskDepth?: number;
  readonly cboreDiameter?: number;
  readonly cboreDepth?: number;
  readonly depth?: number;
  readonly through: boolean;
  readonly drillPointAngle?: Named<number>;
  readonly tipHeight?: number;
  readonly thread?: string;
}

export interface HoleTableData extends FtrResultMeta {
  readonly entityId: string;
  /** Datum of the first row's face in that face's frame (u, v), document length units. */
  readonly origin: Vec2;
  readonly rows: readonly HoleRow[];
}

const rounded = (value: number): number => Math.round(value * 1e9) / 1e9;

/** Top-left corner [u_min, v_max] of the coplanar triangles of the entity mesh lying in the hole's face plane. */
function faceDatum(positions: readonly number[], indices: readonly number[], hole: MachinedHole): Vec2 | null {
  const { frame } = hole;
  let [uMin, vMax] = [Infinity, -Infinity];
  const vertex = (i: number): Vec3 => [positions[i * 3] ?? 0, positions[i * 3 + 1] ?? 0, positions[i * 3 + 2] ?? 0];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => vertex(indices[t + k] ?? 0));
    const inPlane = corners.every(
      (c) => Math.abs(dot3(frame.normal, c) - dot3(frame.normal, hole.position)) < 1e-6 * (1 + Math.abs(dot3(frame.normal, hole.position))),
    );
    if (!inPlane) continue;
    for (const corner of corners) {
      const [u, v] = worldToFrame(frame, corner);
      [uMin, vMax] = [Math.min(uMin, u), Math.max(vMax, v)];
    }
  }
  return Number.isFinite(uMin) ? [uMin, vMax] : null;
}

/**
 * @affects nothing — read-only
 * @invariant data = HoleTableData; rows sorted by face normal, then y, then x (rounded to 1e-6); a drill point that add_hole defaulted is named
 *   { value: 118, defaulted: true, source: 'R8' } and flagged unverified (AF-31)
 * @failure missing / non-solid entity (FTR_PART_NOT_FOUND) -> rejected no-op; no kernel and no authored holes (FTR_NEEDS_EXACT_KERNEL); a part with no holes -> empty rows
 */
export const holeTable = defineCommand({
  name: 'hole_table',
  annotations: { readOnly: true },
  description:
    'List the holes of a part as a table for drawings: one row per hole with its label (H1, H2, ... in table order), position x, y from the ' +
    'top-left corner of its face (x along the face, y downwards, document length units), kind (simple, counterbore, countersink, counterdrill), ' +
    'diameter, countersink diameter / included angle in degrees / depth, counterbore diameter / depth, blind depth or through, drill point ' +
    'angle with its source (a drill point that was not given is reported as defaulted, 118 degrees, source R8) and tip height, and the ' +
    'cosmetic thread. Holes come from add_hole, or are recognised from the B-rep of an imported solid when the kernel is exact (without a kernel only authored holes are listed, otherwise FTR_NEEDS_EXACT_KERNEL). Rows are ' +
    'sorted by face, then y, then x. Pass origin to measure from another datum of the face frame. Lengths in the document length unit, ' +
    'angles in degrees. The table is returned in data = { origin, rows } plus the unit, provenance and reviewRequired (computed by llull, not approved).',
  params: z.object({
    id: z.string().describe('Id of the 3D solid.'),
    origin: vec2(
      'Datum [u, v] in the face frame, in document length units, replacing the default top-left corner of each face.',
    ).optional(),
  }),
  run: (doc: CadDocument, { id, origin }, ctx): CommandResult => {
    const entity = doc.entities[id];
    if (!entity || !is3D(entity) || entity.kind === 'instance')
      return refuse(
        doc,
        'hole_table',
        'FTR_PART_NOT_FOUND',
        `no 3D solid '${id}'`,
        'list entities with describe_scene, then pass a solid id',
        [id],
        ['id'],
      );
    const kernel = (ctx ?? currentContext()).kernel;
    const authored = kernel === null ? authoredFeatures(recipeOf(entity)) : null;
    if (authored !== null && authored.holes.length + authored.pockets.length === 0)
      return refuse(
        doc,
        'hole_table',
        'FTR_NEEDS_EXACT_KERNEL',
        'no kernel is available and the part has no authored holes, so its holes cannot be recognised',
        'rerun with --kernel occt; for imported parts use import_step_exact',
        [id],
      );
    const part =
      kernel === null ? { holes: authored?.holes ?? [], source: 'authored' as const } : machinedPart(kernel, operandRecipe(kernel, entity));
    const mesh = entity.kind === 'mesh' ? entity.mesh : null;
    const datums = new Map<string, Vec2>();
    const datumOf = (hole: MachinedHole): Vec2 => {
      const key = `${hole.frame.normal.map(rounded).join(',')}@${rounded(dot3(hole.frame.normal, hole.position))}`;
      const known = datums.get(key);
      if (known !== undefined) return known;
      const found = origin ?? (mesh === null ? null : faceDatum(mesh.positions, mesh.indices, hole)) ?? [0, 0];
      datums.set(key, found);
      return found;
    };
    const unverified: FtrUnverifiedInput[] = [];
    const placed = part.holes.map((hole) => {
      const [u, v] = hole.point;
      const [du, dv] = datumOf(hole);
      return { hole, x: rounded(u - du), y: rounded(dv - v) };
    });
    placed.sort(
      (a, b) =>
        a.hole.frame.normal[2] - b.hole.frame.normal[2] ||
        a.hole.frame.normal[1] - b.hole.frame.normal[1] ||
        a.hole.frame.normal[0] - b.hole.frame.normal[0] ||
        a.y - b.y ||
        a.x - b.x,
    );
    const rows = placed.map(({ hole, x, y }, index): HoleRow => {
      const tip = hole.drillPointAngle;
      if (tip?.defaulted === true && !unverified.some((entry) => entry.id === 'drill_point_118'))
        unverified.push({ kind: 'preset', id: 'drill_point_118', source: DRILL_POINT_SOURCE });
      return {
        label: `H${index + 1}`,
        id: hole.id,
        x,
        y,
        face: hole.frame.normal.map(rounded) as unknown as Vec3,
        at: hole.position.map(rounded) as unknown as Vec3,
        subtype: hole.kind,
        diameter: hole.diameter,
        ...(hole.cskDiameter === undefined ? {} : { cskDiameter: hole.cskDiameter }),
        ...(hole.cskAngle === undefined ? {} : { cskAngleDeg: hole.cskAngle }),
        ...(hole.cskDepth === undefined ? {} : { cskDepth: rounded(hole.cskDepth) }),
        ...(hole.cboreDiameter === undefined ? {} : { cboreDiameter: hole.cboreDiameter }),
        ...(hole.cboreDepth === undefined ? {} : { cboreDepth: hole.cboreDepth }),
        ...(hole.depth === undefined ? {} : { depth: hole.depth }),
        through: hole.through,
        ...(tip === undefined
          ? {}
          : {
              drillPointAngle: {
                value: tip.value,
                source: tip.defaulted ? DRILL_POINT_SOURCE : 'add_hole input',
                defaulted: tip.defaulted,
                verification: tip.defaulted ? 'unverified' : 'verified',
              } satisfies Named<number>,
              tipHeight: rounded(drillTipHeight(hole.diameter, tip.value).value),
            }),
        ...(hole.thread === undefined ? {} : { thread: hole.thread.designation }),
      };
    });
    const first = placed[0];
    const data: HoleTableData = {
      ...resultMeta(doc, {
        formulas: {
          cskDepth: 'c=(D-d)/(2*tan(alpha/2))',
          tipHeight: 'h=(d/2)/tan(beta/2)',
          position: 'x=u-u0, y=v0-v (datum = top-left of the face)',
        },
        sources: ['07 FTR §5.3', `${DRILL_POINT_SOURCE}: FreeCAD PartDesign Hole (drill point default)`],
        unverifiedInputs: unverified,
      }),
      entityId: id,
      origin: first === undefined ? [0, 0] : datumOf(first.hole),
      rows,
    };
    const note =
      part.source === 'none' && rows.length === 0 ? ' No authored holes; use an exact kernel (recognize_features) for imported parts.' : '';
    return report(
      doc,
      `hole_table: '${id}' has ${rows.length} holes (${part.source}); rows sorted by face, y, x from the top-left datum.${note} ` +
        'Computed by llull, not approved — a qualified person must review before manufacture.',
      data,
    );
  },
});
