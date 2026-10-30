/** analyze_mesh — numeric inspector of a mesh or any 3D solid's triangles (07 MSH M0, FR-MSH-03). Read-only. */

import { resolveMeshEngine } from '../../geometry/mesh/engine';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import {
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  loadSolidMesh,
  meshRejection,
  namedDefault,
  withConventions,
} from './meshCommon';

/**
 * @affects none (read-only); data = counts, topology, shells, loops, orientation, area, volume, quality, self-intersections
 * @invariant welding is the only preprocessing: the entity is not changed; every length is in document units
 * @failure unknown id -> MESH_ENTITY_NOT_FOUND; 2D / curve / sheet -> MESH_NOT_A_MESH; over 200000 triangles without the native engine -> MESH_ENGINE_CAP_EXCEEDED ; a crossing-pair search that would examine more than 4e10 candidate pairs above 200000 triangles (a mesh whose triangles pile up on each other) -> MESH_ENGINE_CAP_EXCEEDED
 */
export const analyzeMesh = defineCommand({
  name: 'analyze_mesh',
  annotations: { readOnly: true },
  description:
    'Numeric health report of a mesh (or the triangles of any 3D solid): vertex / edge / face counts, Euler characteristic and genus, closed and ' +
    'manifold flags, orientation consistency, boundary loops (edges, length, centroid), non-manifold edges, shells (faces, volume, genus each), ' +
    'degenerate and duplicate faces, crossing triangle pairs, area, volume and centroid (closed shells), edge-length and triangle-quality ' +
    '(aspect ratio, min angle) statistics. Vertices within weldTolerance are welded first (default 1e-6 x bounding-box diagonal, reported as a ' +
    'named default). Lengths in document units, areas in units^2, volumes in units^3. Next: check_mesh for a pass / fail verdict. ' +
    'Meshes above 200000 triangles are analysed by the native engine (the desktop app and the llull CLI have it); without it they are refused with MESH_ENGINE_CAP_EXCEEDED. ' +
    'The crossing-pair search runs at any size (natively above 200000 triangles); a mesh whose triangles pile up on each other so that more than 4e10 candidate pairs overlap is refused above 200000 triangles (pass selfIntersections false). ' +
    'Refusals carry error.code MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_ENGINE_CAP_EXCEEDED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to analyse.'),
    weldTolerance: z
      .number()
      .positive()
      .optional()
      .describe('Vertices closer than this (document units) are merged. Default: 1e-6 x bounding-box diagonal.'),
    selfIntersections: z
      .boolean()
      .optional()
      .describe(`Search for crossing triangle pairs (counts transversal crossings; touching contacts are not counted). Default true.`),
    maxListed: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .optional()
      .describe('Longest list returned (loops, shells, pairs, non-manifold edges); totals are always exact. Default 20.'),
  }),
  run: (doc, { id, weldTolerance, selfIntersections, maxListed }, ctx): CommandResult => {
    const loaded = loadSolidMesh(doc, id, weldTolerance, contextOf(ctx).meshAssets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'analyze_mesh', loaded.code, loaded.message, loaded.ids);
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    const outcome = engineOutcome(
      doc,
      'analyze_mesh',
      engine.run(
        { mesh: loaded.mesh },
        { op: 'analyze', weldTolerance: 0, selfIntersections: selfIntersections ?? true, maxListed: maxListed ?? 20 },
      ),
      [id],
    );
    if (isCommandResult(outcome)) return outcome;
    const analysis = outcome.analysis;
    if (analysis === undefined)
      return meshRejection(doc, 'analyze_mesh', 'MESH_ENGINE_UNSUPPORTED', 'the engine returned no analysis', [id]);
    const defaults = loaded.weldDefaulted
      ? [namedDefault('weldTolerance', loaded.weldTolerance, doc.units, 'llull default 1e-6 x bbox diagonal')]
      : [];
    const data = withConventions(
      doc,
      { id, weldTolerance: loaded.weldTolerance, ...analysis },
      { unverified: loaded.unverified, provenance: outcome.provenance, defaults },
    );
    const topology = `${analysis.vertices} vertices, ${analysis.faces} faces, ${analysis.shellCount} shell(s), ${analysis.boundaryLoopCount} boundary loop(s)`;
    const measures = analysis.volume !== null ? `volume ${analysis.volume.toPrecision(10)} ${doc.units}^3, ` : '';
    return report(
      doc,
      `analyze_mesh '${id}': ${topology}; ${analysis.closed ? 'closed' : 'open'}, ${analysis.manifold ? 'manifold' : `${analysis.nonManifoldEdgeCount} non-manifold edge(s)`}, ` +
        `${analysis.orientationConsistent ? 'consistently oriented' : 'inconsistent orientation'}; ${measures}area ${analysis.area.toPrecision(10)} ${doc.units}^2` +
        `${analysis.selfIntersectionPairs !== null ? `; ${analysis.selfIntersectionPairs} crossing pair(s)` : ''}.`,
      data,
    );
  },
});
