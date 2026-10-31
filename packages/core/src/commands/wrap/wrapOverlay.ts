/** wrap_overlay — read-only geometry to DRAW the wrap results on a solid: its curves on faces and its B-rep edges with their convexity (03 WRP, spec §7 UI). */

import type { CadDocument, NurbsCurveEntity, Vec3 } from '../../model/types';
import { sampleCurve } from '../../lib/nurbs/evaluate';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { exactKernel, isRejection, openSolid } from './faceSession';
import { wrapRejection } from './codes';

/** Curves and edges returned at most (a drawing, not an export). */
const MAX_CURVES = 64;
const MAX_EDGES = 400;

const sampled = (curve: NurbsCurveEntity, count: number): Vec3[] =>
  sampleCurve(curve.curve, count).map((p): Vec3 => [p[0] + curve.position[0], p[1] + curve.position[1], p[2] + curve.position[2]]);

/**
 * @affects none (read-only); data.curves = the curves lying on a face (nurbs_curve with onFace) of the solid, or of an earlier solid that no longer exists (a silhouette split keeps its curves), sampled in world coordinates;
 *   data.edges = the B-rep edges of the solid with the faces they join and their convexity (what a chain of faces across them is built on), sampled, null without an exact kernel
 * @invariant computed on read, nothing stored; the viewport draws exactly these polylines (no geometry is derived in the UI); capped at 64 curves and 400 edges with data.truncated naming what was cut
 * @failure unknown id -> WRP_ENTITY_NOT_FOUND; not a solid -> WRP_NOT_A_SOLID; no exact kernel -> the curves only (data.edges null, data.edgesNote says why)
 */
export const wrapOverlay = defineCommand({
  name: 'wrap_overlay',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Geometry to DRAW the wrap results of a solid for review, in world coordinates (document units): data.curves [{ id, face, faceName, source: "solid" | "earlier", length, points[] }] (every curve with onFace that lies on this solid, ' +
    'or on an earlier solid that no longer exists, e.g. the curves of a split_at_silhouette; sampled along the curve), data.edges [{ edge, faces[], convexity: "smooth" | "convex" | "concave" | "unknown", points[] }] (the B-rep edges of the solid ' +
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
    const count = params.samples ?? 24;
    const curves: Array<Record<string, unknown>> = [];
    let skippedCurves = 0;
    for (const other of Object.values(doc.entities)) {
      if (other.kind !== 'nurbs_curve' || other.onFace === undefined) continue;
      const source = other.onFace.entityId === params.id ? 'solid' : doc.entities[other.onFace.entityId] === undefined ? 'earlier' : null;
      if (source === null) continue;
      if (curves.length >= MAX_CURVES) {
        skippedCurves += 1;
        continue;
      }
      const points = sampled(other, count);
      curves.push({
        id: other.id,
        face: other.onFace.faceIndex,
        faceName: other.onFace.faceName ?? null,
        source,
        length: other.onFace.chartLength ?? null,
        points,
      });
    }
    const exact = exactKernel(doc, 'wrap_overlay', ctx);
    let edges: Array<Record<string, unknown>> | null = null;
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
          edges = [];
          graph.edgeFaces.forEach((faces, edge) => {
            if (edges === null) return;
            if (edges.length >= MAX_EDGES) {
              skippedEdges += 1;
              return;
            }
            const points = session.query.edgeSamples(session.shape, edge, count)?.map((sample) => sample.point) ?? [];
            edges.push({ edge, faces: [...faces], convexity: graph.edgeConvexity[edge] ?? 'unknown', points });
          });
        }
      }
    }
    return report(
      doc,
      `wrap_overlay: '${params.id}' has ${curves.length} curve(s) on faces${skippedCurves > 0 ? ` (+${skippedCurves} left out)` : ''}${edges === null ? `; edges not drawn (${edgesNote})` : `, ${edges.length} edge(s) (${edges.filter((e) => e['convexity'] === 'smooth').length} smooth)`}.`,
      { curves, edges, edgesNote, truncated: { curves: skippedCurves, edges: skippedEdges }, unit: doc.units },
    );
  },
});
