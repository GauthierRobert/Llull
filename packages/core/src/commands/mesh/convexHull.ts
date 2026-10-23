/** convex_hull — closed convex mesh around entities and / or explicit points (07 MSH M2, FR-MSH-12). */

import type { Entity, MeshData } from '../../model/types';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import { emptyMeshInput } from '../../geometry/mesh/engineTypes';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import {
  newMeshEntity,
  replaceWith,
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  isStoreFailure,
  loadSolidMesh,
  measureMesh,
  storeMesh,
  meshRejection,
  withConventions,
} from './meshCommon';

/**
 * @affects creates 1 mesh entity (the hull); with keepSources false removes the source entities
 * @invariant exact doubles: hull vertices are a subset of the input points; points within 1e-12 x diameter of a face plane are not vertices
 * @failure no points / fewer than 4 non-coplanar points -> MESH_HULL_DEGENERATE; unknown id -> MESH_ENTITY_NOT_FOUND
 */
export const convexHull = defineCommand({
  name: 'convex_hull',
  description:
    'Convex hull of 3D entities and / or explicit points: one closed, outward-wound mesh with the fewest vertices (coplanar points are merged, ' +
    'interior points dropped). Use it for packaging volumes, wrapping, collision proxies, or to build a convex body from points. Give `ids` ' +
    '(every vertex of those solids counts) and / or `points` (document units); at least 4 points must not be coplanar. Reports vertices, faces, ' +
    'volume and area (document units). The sources are kept unless keepSources is false. Refusals: MESH_HULL_DEGENERATE, MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH.',
  params: z.object({
    ids: z.array(z.string()).max(1000).optional().describe('Ids of 3D solids whose vertices join the hull.'),
    points: z
      .array(vec3('A point [x, y, z] in document units.'))
      .max(200_000)
      .optional()
      .describe('Extra points [[x, y, z], ...] in document units.'),
    keepSources: z.boolean().optional().describe('false: remove the source entities `ids`. Default true.'),
  }),
  run: (doc, { ids, points, keepSources }, ctx): CommandResult => {
    const cloud: number[] = (points ?? []).flat();
    let unverified = false;
    const sources: Entity[] = [];
    for (const id of ids ?? []) {
      const loaded = loadSolidMesh(doc, id, undefined, contextOf(ctx).meshAssets);
      if (isLoadFailure(loaded)) return meshRejection(doc, 'convex_hull', loaded.code, loaded.message, loaded.ids);
      for (const value of loaded.mesh.positions) cloud.push(value);
      unverified ||= loaded.unverified;
      sources.push(loaded.entity);
    }
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    const outcome = engineOutcome(doc, 'convex_hull', engine.run(emptyMeshInput, { op: 'hull', points: cloud }), ids ?? []);
    if (isCommandResult(outcome)) return outcome;
    const mesh = outcome.mesh as MeshData;
    const stored = storeMesh(mesh, contextOf(ctx).meshAssets);
    if (isStoreFailure(stored)) return meshRejection(doc, 'convex_hull', stored.code, stored.message, ids ?? []);
    const entity = newMeshEntity(stored, {
      unverified,
      ...(sources[0] !== undefined ? { color: sources[0].color, layerId: sources[0].layerId } : {}),
    });
    const removed = keepSources === false ? new Set(sources.map((source) => source.id)) : new Set<string>();
    const replaced = replaceWith(doc, removed, entity);
    const measure = measureMesh(mesh);
    const data = withConventions(
      doc,
      {
        id: entity.id,
        vertices: measure.vertices,
        faces: measure.faces,
        closed: measure.closed,
        volume: measure.volume,
        area: measure.area,
        inputPoints: cloud.length / 3,
        removed: [...removed],
      },
      { unverified, provenance: outcome.provenance },
    );
    return {
      document: replaced.document,
      summary: `convex_hull: '${entity.id}' from ${cloud.length / 3} points: ${measure.vertices} vertices, ${measure.faces} triangles, volume ${measure.volume?.toPrecision(10)} ${doc.units}^3, area ${measure.area.toPrecision(10)} ${doc.units}^2.${replaced.suffix}`,
      affected: [entity.id],
      data,
    };
  },
});
