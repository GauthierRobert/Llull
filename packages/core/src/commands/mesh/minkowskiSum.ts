/** minkowski_sum — dilation (sum) or erosion (difference) of a closed solid by another (07 MSH M2, FR-MSH-13). */

import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { Entity } from '../../model/types';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import {
  commitMesh,
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  isStoreFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  outwardMesh,
  storeMesh,
  withConventions,
} from './meshCommon';

/**
 * @affects rewrites the mesh `a` in place with the result (keepSources true: adds one mesh and keeps `a`); `b` is never changed
 * @invariant sum of two convex solids = hull of all vertex sums (exact doubles); non-convex operands or a difference need the Manifold engine
 * @failure unknown id -> MESH_ENTITY_NOT_FOUND; open operand -> MESH_NOT_CLOSED; same id twice -> MESH_PARAM_INVALID; no engine -> MESH_ENGINE_UNSUPPORTED
 */
export const minkowskiSum = defineCommand({
  name: 'minkowski_sum',
  description:
    'Minkowski sum (dilation: grow `a` by the shape of `b`) or difference (erosion: the positions where `b` still fits inside `a`) of two closed ' +
    'meshes / solids. Sum with a small ball rounds every edge and corner of `a`; sum with a box grows it anisotropically; difference with a ' +
    'cutter gives the cutter-centre region. Convex x convex sums are exact in the TypeScript engine; non-convex operands and every difference ' +
    'use the Manifold engine (desktop app / CLI host). `b` is placed as modelled, so centre it on the origin for a symmetric result. Reports the ' +
    'result volume and area (document units). Refusals: MESH_NOT_CLOSED, MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_ENGINE_UNSUPPORTED.',
  params: z.object({
    a: z.string().describe('Id of the closed mesh / solid to dilate or erode; rewritten with the result unless keepSources.'),
    b: z.string().describe('Id of the closed mesh / solid used as the structuring element (centre it on the origin).'),
    op: z.enum(['sum', 'difference']).describe('"sum" (dilation) or "difference" (erosion).'),
    keepSources: z
      .boolean()
      .optional()
      .describe('true: keep `a` and add the result as a new mesh. Default false: `a` is rewritten in place.'),
  }),
  run: (doc, { a, b, op, keepSources }, ctx): CommandResult => {
    if (a === b) return meshRejection(doc, 'minkowski_sum', 'MESH_PARAM_INVALID', 'a and b must be different ids', [a], ['b']);
    const assets = contextOf(ctx).meshAssets;
    const first = loadSolidMesh(doc, a, undefined, assets);
    if (isLoadFailure(first)) return meshRejection(doc, 'minkowski_sum', first.code, first.message, first.ids);
    const second = loadSolidMesh(doc, b, undefined, assets);
    if (isLoadFailure(second)) return meshRejection(doc, 'minkowski_sum', second.code, second.message, second.ids);
    const [measureA, measureB] = [measureMesh(first.mesh), measureMesh(second.mesh)];
    const open = !measureA.closed ? a : !measureB.closed ? b : null;
    if (open !== null)
      return meshRejection(doc, 'minkowski_sum', 'MESH_NOT_CLOSED', `entity '${open}' has open or non-manifold edges`, [open]);
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    const outcome = engineOutcome(
      doc,
      'minkowski_sum',
      engine.run({ mesh: outwardMesh(first.mesh) }, { op: 'minkowski', kind: op, other: { mesh: outwardMesh(second.mesh) } }),
      [a, b],
    );
    if (isCommandResult(outcome)) return outcome;
    if (outcome.mesh === undefined || outcome.mesh.indices.length === 0) {
      return meshRejection(
        doc,
        'minkowski_sum',
        'MESH_PARAM_INVALID',
        op === 'difference' ? 'b does not fit inside a: the erosion is empty' : 'the sum is empty',
        [a, b],
      );
    }
    const unverified = first.unverified || second.unverified;
    const stored = storeMesh(outcome.mesh, assets);
    if (isStoreFailure(stored)) return meshRejection(doc, 'minkowski_sum', stored.code, stored.message, [a, b]);
    const committed = commitMesh(doc, first.entity as Entity, stored, { keepSource: keepSources ?? false, unverified });
    const after = measureMesh(outcome.mesh);
    const data = withConventions(
      doc,
      {
        id: committed.id,
        a,
        b,
        op,
        faces: after.faces,
        vertices: after.vertices,
        volume: after.volume,
        area: after.area,
        volumeA: measureA.volume,
        volumeB: measureB.volume,
        ...outcome.report,
      },
      { unverified, provenance: outcome.provenance },
    );
    return {
      document: committed.document,
      summary: `minkowski_sum ${op} '${a}' (+) '${b}' -> '${committed.id}': ${after.faces} triangles, volume ${after.volume?.toPrecision(12)} ${doc.units}^3 (a ${measureA.volume?.toPrecision(8)}, b ${measureB.volume?.toPrecision(8)}).`,
      affected: [committed.id],
      data,
    };
  },
});
