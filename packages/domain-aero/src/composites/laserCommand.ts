/** export_laser_projection: ply boundary point lists in the tool frame for laser projectors (06 CMP §6.3, FR-CMP-52, VC-CMP-17). */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import type { CompositePart } from '@core/model/composites';
import { MM_PER_UNIT } from '@core/model/units';
import type { Vec2, Vec3 } from '@core/model/types';
import { toCounterClockwise } from '@lib/polygon';
import { cross3, distance3, dot3, len3, sub3 } from '@lib/vec3';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { piecesOf } from './geometry2d';
import { compositesOf, findPart, findPly, pliesOf } from './state';
import { fromFlat } from './surface';

const DEFAULT_SPACING_MM = 75;
const DEFAULT_CORNER_DEG = 20;
const MAX_DEPTH = 14;

/** Boundary points of a chart polygon on the tool face: edges split until every chord is at most `spacing`, then thinned to corners and gaps. */
export function projectionPoints(part: CompositePart, polygon: readonly Vec2[], spacing: number, cornerDeg: number): Vec3[] {
  const ring = toCounterClockwise(polygon);
  const at = (uv: Vec2): Vec3 => fromFlat(part.surface, uv);
  const refine = (a: Vec2, b: Vec2, depth: number): Vec2[] => {
    if (depth >= MAX_DEPTH || distance3(at(a), at(b)) <= spacing / 2) return [a];
    const middle: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return [...refine(a, middle, depth + 1), ...refine(middle, b, depth + 1)];
  };
  const dense = ring.flatMap((a, k) => refine(a, ring[(k + 1) % ring.length] as Vec2, 0));
  const points = dense.map(at);
  const turn = (k: number): number => {
    const [p, q, r] = [points[(k + points.length - 1) % points.length] as Vec3, points[k] as Vec3, points[(k + 1) % points.length] as Vec3];
    const [u, v] = [sub3(q, p), sub3(r, q)];
    const scale = len3(u) * len3(v);
    if (scale < 1e-18) return 0;
    return (Math.atan2(len3(cross3(u, v)), dot3(u, v)) * 180) / Math.PI;
  };
  const kept: Vec3[] = [];
  let last: Vec3 | null = null;
  for (const [k, point] of points.entries()) {
    const next = points[(k + 1) % points.length] as Vec3;
    const corner = turn(k) >= cornerDeg;
    if (last === null || corner || distance3(last, next) > spacing) {
      kept.push(point);
      last = point;
    }
  }
  return kept;
}

/**
 * @affects nothing (read-only)
 * @invariant one block per ply piece, points on the tool face in document coordinates converted to mm, winding counter-clockwise seen from the laminate side, consecutive points at most `spacing` apart, every turn of at least `cornerAngle` degrees kept
 * @failure unknown part / ply -> CMP_REF_MISSING; no plies -> CMP_NO_PLIES; spacing or cornerAngle <= 0 -> CMP_PARAM_INVALID
 */
export const exportLaserProjection = defineCommand({
  name: 'export_laser_projection',
  annotations: { readOnly: true },
  description:
    'Laser-projection data of a composite part: for every ply piece the boundary polyline on the tool face as 3D points in the tool (document) ' +
    'frame, in millimetres, as a plain-text list (a neutral layout; vendor formats are not written). The file starts with "# llull laser ' +
    'projection v1   units=mm   frame=tool   part=<name>" and holds one block per piece: "PLY <name> SEQ <sequence> MATERIAL <material> ANGLE ' +
    '<degrees> POINTS <n>", n lines "x y z", then "END". Points run counter-clockwise seen from the laminate side. Consecutive points are at ' +
    'most `spacing` apart (default 75 mm) and every corner turning at least `cornerAngle` degrees (default 20) is included. `plies` selects ' +
    'plies by id or name (default all). The text is returned in data.files[0].content; save it with the CLI --save option. Read-only; the ' +
    'projection is computed by llull from the model: verify it on the tool before laying material.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    plies: z.array(z.string().describe('Ply id or name.')).describe('Plies to export; default every ply of the part.').optional(),
    spacing: z.number().describe('Maximum distance between consecutive points, millimetres, > 0; default 75.').optional(),
    cornerAngle: z.number().describe('Turn angle in degrees (0, 180] from which a vertex is always kept; default 20.').optional(),
    confirmExportControlled,
  }),
  run: (
    doc,
    {
      part: partRef,
      plies: selection,
      spacing = DEFAULT_SPACING_MM,
      cornerAngle = DEFAULT_CORNER_DEG,
      confirmExportControlled: confirmation,
    },
    ctx,
  ): CommandResult => {
    const refused = exportRefusal(doc, 'export_laser_projection', 'data', confirmation, ctx);
    if (refused !== null) return refused;
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'export_laser_projection', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    if (!(Number.isFinite(spacing) && spacing > 0) || !(Number.isFinite(cornerAngle) && cornerAngle > 0 && cornerAngle <= 180))
      return refuseCmp(
        doc,
        'export_laser_projection',
        'CMP_PARAM_INVALID',
        'spacing must be > 0 and cornerAngle in (0, 180]',
        [part.id],
        ['params.spacing'],
      );
    const chosen = selection === undefined ? pliesOf(model, part.id) : selection.map((ref) => findPly(model, part.id, ref));
    const missing = (selection ?? []).filter((_, i) => chosen[i] === null);
    if (missing.length > 0)
      return refuseCmp(
        doc,
        'export_laser_projection',
        'CMP_REF_MISSING',
        `unknown ply(ies) ${missing.join(', ')}`,
        [part.id],
        ['params.plies'],
      );
    const plies = chosen.flatMap((ply) => (ply === null || ply.partId !== part.id ? [] : [ply]));
    if (plies.length === 0)
      return refuseCmp(doc, 'export_laser_projection', 'CMP_NO_PLIES', `part "${part.name}" has no plies`, [part.id], ['params.part']);
    const scale = MM_PER_UNIT[doc.units];
    const reverse = part.laminateSide === 'negative_normal';
    const lines = [`# llull laser projection v1   units=mm   frame=tool   part=${part.name.replace(/\s+/g, '_')}`];
    const blocks: Record<string, unknown>[] = [];
    for (const ply of plies)
      for (const [index, piece] of piecesOf(ply, part).entries()) {
        const ordered = projectionPoints(part, piece, spacing / scale, cornerAngle);
        const points = reverse ? [...ordered].reverse() : ordered;
        const gap = Math.max(...points.map((p, k) => distance3(p, points[(k + 1) % points.length] as Vec3))) * scale;
        lines.push(
          `PLY ${ply.name.replace(/\s+/g, '_')} SEQ ${ply.sequence} MATERIAL ${ply.materialName.replace(/\s+/g, '_')} ANGLE ${ply.orientation} POINTS ${points.length}`,
        );
        for (const p of points) lines.push(`${(p[0] * scale).toFixed(4)} ${(p[1] * scale).toFixed(4)} ${(p[2] * scale).toFixed(4)}`);
        lines.push('END');
        blocks.push({ ply: ply.id, name: ply.name, piece: index, points: points.length, maxGapMm: sig(gap) });
      }
    const content = `${lines.join('\n')}\n`;
    return report(
      doc,
      `export_laser_projection: part "${part.name}": ${blocks.length} piece(s) of ${plies.length} ply(ies), ${blocks.reduce((n, b) => n + (b['points'] as number), 0)} points, spacing <= ${spacing} mm, corners >= ${cornerAngle} deg kept. Computed by llull: verify on the tool.`,
      {
        part: part.id,
        unit: 'mm',
        frame: 'tool',
        spacingMm: spacing,
        cornerAngleDeg: cornerAngle,
        files: [{ name: `${part.name.replace(/\s+/g, '_')}.lpt.txt`, mime: 'text/plain', content }],
        pieces: blocks,
        reviewRequired: true,
        reviewReason: 'projection data computed by llull, not approved: check against the tool before use',
        provenance: {
          method: 'ply boundary on the tool face, chord-limited and corner-preserving',
          reference: 'llull laser projection v1',
          inputs: { part: part.id },
        },
      },
    );
  },
});
