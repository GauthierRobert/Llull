/** wrap_overlay — read-only geometry to DRAW the wrap results on a solid: its curves on faces and its B-rep edges with their convexity (03 WRP, spec §7 UI). */

import { is3D, type CadDocument, type NurbsCurveEntity, type Vec3 } from '../../model/types';
import { placedCurve } from '../../geometry/nurbsSurface';
import { sampleCurve } from '../../lib/nurbs/evaluate';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { exactKernel, isRejection, openSolid } from './faceSession';
import { wrapRejection } from './codes';

/** Curves and edges returned at most (a drawing, not an export). */
const MAX_CURVES = 64;
const MAX_EDGES = 400;
/** Steps followed back through the history to find the solids a solid was made from. */
const MAX_LINEAGE = 256;

/** A curve lying on a face of the solid ('solid') or of a solid it was made from ('earlier'), sampled in world coordinates. */
export interface WrapOverlayCurve {
  readonly id: string;
  readonly face: number;
  readonly faceName: string | null;
  readonly source: 'solid' | 'earlier';
  readonly length: number | null;
  readonly points: Vec3[];
}

/** An edge of the solid with the faces it joins, what a chain across it does (its convexity) and its sampled points. */
export interface WrapOverlayEdge {
  readonly edge: number;
  readonly faces: number[];
  readonly convexity: 'smooth' | 'convex' | 'concave' | 'unknown';
  readonly points: Vec3[];
}

const sampled = (curve: NurbsCurveEntity, count: number): Vec3[] => sampleCurve(placedCurve(curve), count);

/**
 * The ids of the solids `id` was made from, read from the history: a step that lists `id` among its results and names another solid in its `id` parameter consumed that solid (a split keeps the curves
 * of the solid it consumed, whose id is then gone). Followed back at most 256 steps.
 */
function consumedBefore(doc: CadDocument, id: string): ReadonlySet<string> {
  const found = new Set<string>();
  let current = id;
  for (let step = 0; step < MAX_LINEAGE; step++) {
    const producer = [...doc.featureHistory].reverse().find((entry) => {
      const from = (entry.params as { id?: unknown } | null)?.id;
      return typeof from === 'string' && from !== current && (entry.affected ?? []).includes(current);
    });
    const from = (producer?.params as { id?: string } | undefined)?.id;
    if (from === undefined || found.has(from)) break;
    found.add(from);
    current = from;
  }
  return found;
}

/**
 * @affects none (read-only); data.curves = the curves lying on a face (nurbs_curve with onFace) of the solid, or of a solid it was made from that no longer exists (the history says which: a silhouette split keeps the curves of the
 *   solid it consumed), sampled along the placed curve in world coordinates; data.edges = the B-rep edges of the solid with the faces they join and their convexity (what a chain of faces across them is built on), sampled, null without an exact kernel
 * @invariant computed on read, nothing stored; the viewport draws exactly these polylines (no geometry is derived in the UI); capped at 64 curves and 400 edges with data.truncated naming what was cut
 * @failure unknown id -> WRP_ENTITY_NOT_FOUND; not a 3D solid -> WRP_NOT_A_SOLID; no exact kernel, or one that cannot build the solid -> the curves only (data.edges null, data.edgesNote says why)
 */
export const wrapOverlay = defineCommand({
  name: 'wrap_overlay',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Geometry to DRAW the wrap results of a solid for review, in world coordinates (document units): data.curves [{ id, face, faceName, source: "solid" | "earlier", length, points[] }] (every curve with onFace that lies on this solid, ' +
    'or on a solid it was made from that no longer exists, read from the history, e.g. the curves of a split_at_silhouette; sampled along the placed curve), data.edges [{ edge, faces[], convexity: "smooth" | "convex" | "concave" | "unknown", points[] }] (the B-rep edges of the solid ' +
    'with the faces each joins: smooth edges are where emboss_on_face chains across without a mitre, convex and concave ones are mitred between two planes; null without the exact native kernel, data.edgesNote says why), ' +
    'data.truncated {curves, edges} (how many were left out above the caps of 64 and 400). Read-only; nothing is stored. Next: check_wrap for the numbers behind the picture.',
  params: z.object({
    id: z.string().describe('Id of the solid whose wrap results are drawn.'),
    samples: z.number().int().min(2).max(200).optional().describe('Points sampled along each curve and edge (default 24).'),
  }),
  run: (doc: CadDocument, params, ctx): CommandResult => {
    const entity = doc.entities[params.id];
    if (entity === undefined)
      return wrapRejection(doc, 'wrap_overlay', 'WRP_ENTITY_NOT_FOUND', `entity '${params.id}' not found`, [params.id], ['id']);
    if (!is3D(entity) || entity.kind === 'instance')
      return wrapRejection(
        doc,
        'wrap_overlay',
        'WRP_NOT_A_SOLID',
        `entity '${params.id}' (${entity.kind}) is not a 3D solid`,
        [params.id],
        ['id'],
      );
    const count = params.samples ?? 24;
    const earlier = consumedBefore(doc, params.id);
    const curves: WrapOverlayCurve[] = [];
    let skippedCurves = 0;
    for (const other of Object.values(doc.entities)) {
      if (other.kind !== 'nurbs_curve' || other.onFace === undefined) continue;
      const owner = other.onFace.entityId;
      const source = owner === params.id ? 'solid' : earlier.has(owner) && doc.entities[owner] === undefined ? 'earlier' : null;
      if (source === null) continue;
      if (curves.length >= MAX_CURVES) {
        skippedCurves += 1;
        continue;
      }
      curves.push({
        id: other.id,
        face: other.onFace.faceIndex,
        faceName: other.onFace.faceName ?? null,
        source,
        length: other.onFace.chartLength ?? null,
        points: sampled(other, count),
      });
    }
    const exact = exactKernel(doc, 'wrap_overlay', ctx);
    let edges: WrapOverlayEdge[] | null = null;
    let edgesNote: string | null = null;
    let skippedEdges = 0;
    if ('summary' in exact) edgesNote = 'no exact kernel: the edges of the solid are not available';
    else {
      const session = openSolid(doc, ctx, 'wrap_overlay', params.id);
      if (isRejection(session)) edgesNote = session.summary;
      else {
        const graph = session.query.faceGraph(session.shape);
        if (graph === null) edgesNote = 'the kernel gave no face graph for this solid';
        else {
          const listed: WrapOverlayEdge[] = [];
          graph.edgeFaces.forEach((faces, edge) => {
            if (listed.length >= MAX_EDGES) {
              skippedEdges += 1;
              return;
            }
            const points = session.query.edgeSamples(session.shape, edge, count)?.map((sample) => sample.point) ?? [];
            listed.push({ edge, faces: [...faces], convexity: graph.edgeConvexity[edge] ?? 'unknown', points });
          });
          edges = listed;
        }
      }
    }
    return report(
      doc,
      `wrap_overlay: '${params.id}' has ${curves.length} curve(s) on faces${skippedCurves > 0 ? ` (+${skippedCurves} left out)` : ''}${edges === null ? `; edges not drawn (${edgesNote})` : `, ${edges.length} edge(s) (${edges.filter((e) => e.convexity === 'smooth').length} smooth)${skippedEdges > 0 ? ` (+${skippedEdges} left out)` : ''}`}.`,
      { curves, edges, edgesNote, truncated: { curves: skippedCurves, edges: skippedEdges }, unit: doc.units },
    );
  },
});
