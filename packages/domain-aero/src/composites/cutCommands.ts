/** split_ply: darts and splices that cut a ply into separately draped pieces (06 CMP FR-CMP-42, VC-CMP-33). */

import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { entityLocalToWorld } from '@core/geometry/entityFrame';
import { placedCurve } from '@core/geometry/nurbsSurface';
import type { CadDocument, Entity, Vec2, Vec3 } from '@core/model/types';
import type { CompositePart, Ply, PlyCut } from '@core/model/composites';
import { sampleCurve } from '@lib/nurbs/evaluate';
import { polygonArea } from '@lib/polygon';
import { sig } from '../shared/results';
import { refuseCmp } from './codes';
import { syncOutlines } from './derive';
import { cutFaces, cutPieces } from './cutPieces';
import { insideOrOn, piecesOf } from './geometry2d';
import { compositesOf, findPart, findPly, withComposites } from './state';
import { toFlat } from './surface';

const SAMPLES = 48;

/** World points of a curve entity (line, polyline, nurbs_curve), or null for other kinds. */
function curvePoints(entity: Entity): Vec3[] | null {
  if (entity.kind === 'nurbs_curve') return sampleCurve(placedCurve(entity), SAMPLES);
  if (entity.kind === 'polyline') return entity.points.map(([x, y]) => entityLocalToWorld(entity, [x, y, 0]));
  if (entity.kind === 'line')
    return [
      entityLocalToWorld(entity, [entity.start[0], entity.start[1], 0]),
      entityLocalToWorld(entity, [entity.end[0], entity.end[1], 0]),
    ];
  return null;
}

/** Chart polyline of the cut: the given chart `path`, or the curve entity projected on the tool face. */
function cutPath(doc: CadDocument, part: CompositePart, path: readonly Vec2[] | undefined, curveId: string | undefined): Vec2[] | string {
  if ((path === undefined) === (curveId === undefined)) return 'give exactly one of path and curveId';
  if (path !== undefined) return path.length < 2 ? 'path needs at least 2 vertices' : path.map((p): Vec2 => [p[0], p[1]]);
  const entity = doc.entities[curveId as string];
  if (entity === undefined) return `no entity '${curveId}'`;
  const points = curvePoints(entity);
  if (points === null) return `entity '${curveId}' is a ${entity.kind}; use a line, polyline or nurbs_curve`;
  return points.map((point) => toFlat(part.surface, point).uv);
}

/**
 * @affects appends one cut to doc.composites.plies[ply].cuts; the pieces (and the derived outlines of planar parts) are re-derived
 * @invariant a splice must divide a piece in two; a dart is a slit that must touch the ply region, and divides it only when it meets another cut or the boundary on both ends; pieces are draped, flattened, weighed and exported separately; a splice overlap grows the piece on the left of the path direction
 * @failure unknown part / ply / curve -> CMP_REF_MISSING; path outside the ply, splice that divides nothing, bad overlap -> CMP_CUT_INVALID
 */
export const splitPly = defineCommand({
  name: 'split_ply',
  description:
    'Cut a composite ply with a dart or a splice so that each resulting piece is draped and flattened on its own (FR-CMP-42). The cut is a ' +
    'polyline in the part frame (`path`, chart coordinates as in add_ply polygons) or a line / polyline / nurbs_curve entity (`curveId`) projected ' +
    'on the tool face. A "splice" must cross the ply boundary at both ends and divides a piece in two; `overlap` (document length units, default 0) ' +
    'grows the piece on the LEFT of the path direction over the other one. A "dart" is a slit from the boundary toward the interior: it divides ' +
    'the ply when it meets another dart (e.g. several darts meeting at a pole cut a hemisphere ply into wedges) or runs boundary to boundary; a lone ' +
    'dart stays recorded as a slit and does not change the pieces. Each piece is draped from the ply seed (the piece bisector when the seed is a ' +
    'vertex of the piece). Run check_producibility afterwards. Several cuts accumulate on the ply.',
  params: z.object({
    ply: z.string().describe('Ply id, or ply name (with `part`).'),
    part: z.string().describe('Part id or name; needed only when `ply` is a name.').optional(),
    kind: z.enum(['dart', 'splice']).describe('"dart" (slit from the boundary) or "splice" (cut across the ply).'),
    path: z
      .array(vec2('A vertex [x, y] in the part frame (document units).'))
      .describe('Cut polyline in the part frame, at least 2 vertices (ends past the boundary are clipped).')
      .optional(),
    curveId: z
      .string()
      .describe('Alternative to `path`: id of a line, polyline or nurbs_curve entity projected on the tool face.')
      .optional(),
    overlap: z
      .number()
      .describe('Splice overlap, document length units, >= 0; the piece on the left of the path direction grows by this.')
      .optional(),
  }),
  run: (doc, { ply: plyRef, part: partRef, kind, path, curveId, overlap }): CommandResult => {
    const model = compositesOf(doc);
    const part = partRef === undefined ? null : findPart(model, partRef);
    if (partRef !== undefined && part === null)
      return refuseCmp(doc, 'split_ply', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const ply: Ply | null | undefined = model.plies[plyRef] ?? (part === null ? null : findPly(model, part.id, plyRef));
    const owner = ply === null || ply === undefined ? undefined : model.parts[ply.partId];
    if (ply === null || ply === undefined || owner === undefined)
      return refuseCmp(doc, 'split_ply', 'CMP_REF_MISSING', `no ply '${plyRef}'`, [], ['params.ply']);
    if (overlap !== undefined && (!(Number.isFinite(overlap) && overlap >= 0) || (kind === 'dart' && overlap > 0)))
      return refuseCmp(
        doc,
        'split_ply',
        'CMP_CUT_INVALID',
        'overlap must be >= 0 and applies to splices only',
        [ply.id],
        ['params.overlap'],
      );
    const resolved = cutPath(doc, owner, path, curveId);
    if (typeof resolved === 'string') return refuseCmp(doc, 'split_ply', 'CMP_REF_MISSING', resolved, [ply.id], ['params.path']);
    if (!resolved.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
      return refuseCmp(doc, 'split_ply', 'CMP_CUT_INVALID', 'path vertices must be finite', [ply.id], ['params.path']);
    const before = piecesOf(ply, owner);
    if (!before.some((piece) => resolved.some((p) => insideOrOn(p, piece, 1e-6))) && !pathCrosses(before, resolved))
      return refuseCmp(doc, 'split_ply', 'CMP_CUT_INVALID', 'the path does not touch the ply region', [ply.id], ['params.path']);
    const cut: PlyCut = { kind, path: resolved, ...(overlap === undefined || overlap === 0 ? {} : { overlap }) };
    const next: Ply = { ...ply, cuts: [...(ply.cuts ?? []), cut] };
    const after = piecesOf(next, owner);
    if (kind === 'splice' && after.length <= before.length)
      return refuseCmp(
        doc,
        'split_ply',
        'CMP_CUT_INVALID',
        'a splice must cross the ply boundary at both ends so that it divides a piece',
        [ply.id],
        ['params.path'],
      );
    const area = (pieces: readonly (readonly Vec2[])[]): number => pieces.reduce((sum, piece) => sum + polygonArea(piece), 0);
    const base = ply.boundary.kind === 'whole_face' ? [owner.outline] : ply.boundary.polygons;
    if (cutFaces(base, next.cuts ?? []).some((face) => face.holes.length > 0))
      return refuseCmp(
        doc,
        'split_ply',
        'CMP_CUT_INVALID',
        'the cut closes a region inside the ply without reaching its boundary',
        [ply.id],
        ['params.path'],
      );
    if (cut.overlap !== undefined) {
      const plain = piecesOf({ ...next, cuts: [...(ply.cuts ?? []), { kind, path: resolved }] }, owner);
      if (!(area(after) > area(plain) + 1e-9))
        return refuseCmp(
          doc,
          'split_ply',
          'CMP_CUT_INVALID',
          'the overlap could not be applied: the piece on the right of the path must be convex and share the cut',
          [ply.id],
          ['params.overlap'],
        );
    }
    return changed(
      syncOutlines(withComposites(doc, { ...model, plies: { ...model.plies, [ply.id]: next } })),
      `split_ply: ${kind} added to ply "${ply.name}" (${ply.id}): ${before.length} -> ${after.length} piece(s), ply area ${sig(area(before))} -> ${sig(area(after))} (chart units^2); ${next.cuts?.length} cut(s) on the ply.`,
      [ply.id],
    );
  },
});

/** True when the polyline crosses an edge of one of `pieces` (so a path with both ends outside still counts). */
function pathCrosses(pieces: readonly (readonly Vec2[])[], path: readonly Vec2[]): boolean {
  return cutPieces(pieces, [{ kind: 'splice', path }]).length > pieces.length;
}
