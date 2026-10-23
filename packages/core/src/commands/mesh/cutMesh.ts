/** cut_mesh — cut a mesh with a plane, keep one or both sides, cap the section (07 MSH FR-MSH-16). Works on open meshes and without a B-rep kernel. */

import type { CadDocument, Entity, MeshData } from '../../model/types';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { MeshProvenance } from '../../geometry/mesh/engineTypes';
import { crossesPlane } from '../../geometry/mesh/planeCut';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import {
  addMeshEntity,
  commitMesh,
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  isStoreFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  namedDefault,
  outwardMesh,
  storeMesh,
  withConventions,
} from './meshCommon';

/** Vertices within this fraction of the bounding-box diagonal of the plane are snapped onto it (named default). */
const SNAP_FRACTION = 1e-12;

/**
 * @affects rewrites the mesh `id` as the kept side (positive first; with keep "both" the negative side is added as a new mesh), or adds the results with keepSource
 * @invariant exact clipping: every kept triangle lies on the kept side; cap triangles share the section vertices, so a closed input gives closed outputs; no B-rep kernel needed
 * @failure unknown id / non-solid -> MESH_*; zero normal -> MESH_PARAM_INVALID; the plane does not cross the mesh -> MESH_CUT_MISSES
 */
export const cutMesh = defineCommand({
  name: 'cut_mesh',
  description:
    'Cut a mesh (or the triangles of any 3D solid) with a plane and keep the positive side (the side the normal points to), the negative side, or ' +
    'both. Triangles are clipped exactly, so it works on open and dirty meshes and needs no B-rep kernel. `cap` (default true for a closed ' +
    'mesh) closes every section loop with a planar fill that respects holes (a hollowed shell gets a ring); the result of a closed mesh is closed ' +
    'and wound outward. keep "both" rewrites `id` as the positive half and adds the negative half as a new mesh (positive first). Reports ' +
    'data.volumes {positive, negative} (document units^3, closed results), capArea (units^2), section loops and the ids. ' +
    'Reference: the unit cube cut by x + y + z = 1.5 (normal [1,1,1]) keeps 0.5 below the plane with a hexagonal cap of area 1.299. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_CUT_MISSES.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to cut.'),
    plane: z
      .object({
        origin: vec3('A point [x, y, z] on the plane (document units, world).'),
        normal: vec3('Plane normal [x, y, z] (any non-zero length); the positive side is where it points.'),
      })
      .describe('The cutting plane.'),
    keep: z.enum(['positive', 'negative', 'both']).optional().describe('Side to keep: "positive" (default), "negative" or "both".'),
    cap: z.boolean().optional().describe('Close the section with planar caps. Default true for a closed mesh, false for an open one.'),
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, plane, keep, cap, keepSource }, ctx): CommandResult => {
    const reject = (code: string, message: string, path?: string): CommandResult =>
      meshRejection(doc, 'cut_mesh', code, message, [id], path === undefined ? [] : [path]);
    const assets = contextOf(ctx).meshAssets;
    const loaded = loadSolidMesh(doc, id, undefined, assets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'cut_mesh', loaded.code, loaded.message, loaded.ids);
    if (!(Math.hypot(...plane.normal) > 0)) return reject('MESH_PARAM_INVALID', 'plane.normal must be a non-zero vector', 'plane.normal');
    const epsilon = SNAP_FRACTION * meshDiagonal(loaded.mesh.positions);
    if (!crossesPlane(loaded.mesh, plane.origin, plane.normal, epsilon))
      return reject('MESH_CUT_MISSES', 'the plane does not cross the mesh (all vertices are on one side)', 'plane');
    const closed = measureMesh(loaded.mesh).closed;
    const capped = cap ?? closed;
    const input: MeshData = closed ? outwardMesh(loaded.mesh) : loaded.mesh;
    const sides: Array<1 | -1> = (keep ?? 'positive') === 'positive' ? [1] : keep === 'negative' ? [-1] : [1, -1];
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    const results: Array<{ side: 1 | -1; mesh: MeshData; report: Readonly<Record<string, unknown>>; provenance: MeshProvenance }> = [];
    for (const side of sides) {
      const outcome = engineOutcome(
        doc,
        'cut_mesh',
        engine.run({ mesh: input }, { op: 'cut', origin: plane.origin, normal: plane.normal, side, cap: capped, epsilon }),
        [id],
      );
      if (isCommandResult(outcome)) return outcome;
      if (outcome.mesh === undefined || outcome.mesh.indices.length === 0)
        return reject('MESH_CUT_MISSES', `nothing remains on the ${side === 1 ? 'positive' : 'negative'} side`, 'plane');
      results.push({ side, mesh: outcome.mesh, report: outcome.report, provenance: outcome.provenance });
    }
    let next: CadDocument = doc;
    const ids: string[] = [];
    const source = loaded.entity as Entity;
    for (const [index, result] of results.entries()) {
      const stored = storeMesh(result.mesh, assets);
      if (isStoreFailure(stored)) return reject(stored.code, stored.message);
      if (index === 0) {
        const committed = commitMesh(next, source, stored, { keepSource: keepSource ?? false, unverified: loaded.unverified });
        next = committed.document;
        ids.push(committed.id);
      } else {
        const added = addMeshEntity(next, stored, { unverified: loaded.unverified, color: source.color, layerId: source.layerId });
        next = added.document;
        ids.push(added.id);
      }
    }
    const volumes: Record<string, number | null> = {};
    const closedResults: Record<string, boolean> = {};
    results.forEach((result) => {
      const measured = measureMesh(result.mesh);
      const name = result.side === 1 ? 'positive' : 'negative';
      volumes[name] = measured.volume;
      closedResults[name] = measured.closed;
    });
    const first = results[0] as (typeof results)[number];
    const data = withConventions(
      next,
      {
        ids,
        sourceId: id,
        keep: keep ?? 'positive',
        plane: { origin: plane.origin, normal: plane.normal },
        cap: capped,
        inputClosed: closed,
        volumes,
        closed: closedResults,
        capArea: results.reduce<Record<string, unknown>>(
          (acc, r) => ({ ...acc, [r.side === 1 ? 'positive' : 'negative']: r.report['capArea'] }),
          {},
        ),
        loops: first.report['loops'],
        uncapped: results.reduce((sum, r) => sum + (r.report['uncapped'] as number), 0),
        epsilon,
      },
      {
        unverified: loaded.unverified,
        provenance: first.provenance,
        defaults: [namedDefault('snapTolerance', epsilon, doc.units, 'llull default 1e-12 x bbox diagonal')],
      },
    );
    const volumeText = (name: string): string =>
      volumes[name] === undefined ? '' : ` ${name} volume ${volumes[name] === null ? 'open' : (volumes[name] as number).toPrecision(10)}`;
    return {
      document: next,
      summary: `cut_mesh '${id}' -> ${ids.map((i) => `'${i}'`).join(', ')}:${Object.keys(volumes).map(volumeText).join(';')}${capped ? '' : ' (uncapped)'}.`,
      affected: ids,
      data,
    };
  },
});
