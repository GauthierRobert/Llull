/** add_icosphere_mesh / add_grid_mesh — generated triangle meshes to sculpt, remesh or test with (07 MSH FR-MSH-27). */

import type { CadDocument, MeshData } from '../../model/types';
import { gridMeshOf, icosphereMesh } from '../../geometry/mesh/primitives';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult, ExecutionContext } from '../types';
import { addMeshEntity, contextOf, isStoreFailure, measureMesh, meshRejection, storeMesh, withConventions } from './meshCommon';

const MAX_GRID_VERTICES = 1_000_000;

function finish(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  mesh: MeshData,
  fields: Record<string, unknown>,
): CommandResult {
  const stored = storeMesh(mesh, contextOf(ctx).meshAssets);
  if (isStoreFailure(stored)) return meshRejection(doc, command, stored.code, stored.message);
  const added = addMeshEntity(doc, stored, { unverified: false });
  const measure = measureMesh(mesh);
  const data = withConventions(
    doc,
    {
      id: added.id,
      faces: measure.faces,
      vertices: measure.vertices,
      area: measure.area,
      volume: measure.volume,
      closed: measure.closed,
      ...fields,
    },
    { unverified: false },
  );
  const volume = measure.volume !== null ? `, volume ${measure.volume.toPrecision(8)} ${doc.units}^3` : '';
  return {
    document: added.document,
    summary: `${command} -> '${added.id}': ${measure.faces} triangles, ${measure.vertices} vertices, area ${measure.area.toPrecision(8)} ${doc.units}^2${volume}.`,
    affected: [added.id],
    data,
  };
}

/**
 * @affects adds one mesh entity (meshSource.format generated, verified) at `position`
 * @invariant closed, outward-wound, 20 x 4^level triangles, every vertex at distance `radius` from `position`
 * @failure radius <= 0 or level outside 0..7 -> CMD_INVALID_PARAMS
 */
export const addIcosphereMesh = defineCommand({
  name: 'add_icosphere_mesh',
  description:
    'Add a closed triangle mesh icosphere: a regular icosahedron projected onto the sphere of `radius`, subdivided `level` times (level 0 = 20 ' +
    'triangles, each level x4, 0..7), outward wound, all vertices exactly on the sphere. A mesh entity for sculpt_mesh, remesh_mesh, ' +
    'decimate_mesh or mesh_to_brep, not a primitive solid (use add_sphere for a parametric one). Reports triangles, vertices, the polyhedral volume ' +
    'and area (document units). Refusals: CMD_INVALID_PARAMS, MESH_ASSET_UNAVAILABLE (result above the inline cap and no asset store).',
  params: z.object({
    radius: z.number().positive().describe('Sphere radius (document units).'),
    level: z.number().int().min(0).max(7).describe('Subdivision level, 0..7: 20 x 4^level triangles.'),
    position: vec3('Centre [x, y, z] (document units). Default [0, 0, 0].').optional(),
  }),
  run: (doc, { radius, level, position }, ctx): CommandResult =>
    finish(doc, ctx, 'add_icosphere_mesh', icosphereMesh(radius, level, position ?? [0, 0, 0]), { radius, level }),
});

/**
 * @affects adds one mesh entity (flat grid, generated, verified) at `position`
 * @invariant cells[0] x cells[1] x 2 triangles wound +Z, centred on `position`, vertex spacing size / cells
 * @failure more than 1e6 vertices -> MESH_PARAM_INVALID
 */
export const addGridMesh = defineCommand({
  name: 'add_grid_mesh',
  description:
    'Add a flat triangle mesh grid in the plane z = position[2], centred on `position` (x, y), `size` [sx, sy] long, `cells` [nx, ny] cells ' +
    '(two triangles per cell, +Z normal, open mesh). The patch to sculpt on (sculpt_mesh) or to test smoothing on. Reports triangles, vertices, ' +
    'the cell size and the area (document units). Refusals: CMD_INVALID_PARAMS, MESH_PARAM_INVALID (over one million vertices), MESH_ASSET_UNAVAILABLE (no asset store for a result above the inline cap).',
  params: z.object({
    size: z.tuple([z.number().positive(), z.number().positive()]).describe('Grid extent [x, y] (document units).'),
    cells: z.tuple([z.number().int().min(1), z.number().int().min(1)]).describe('Cells along x and y.'),
    position: vec3('Centre [x, y, z] of the grid (document units). Default [0, 0, 0].').optional(),
  }),
  run: (doc, { size, cells, position }, ctx): CommandResult => {
    const vertices = (cells[0] + 1) * (cells[1] + 1);
    if (vertices > MAX_GRID_VERTICES)
      return meshRejection(doc, 'add_grid_mesh', 'MESH_PARAM_INVALID', `${vertices} vertices exceed ${MAX_GRID_VERTICES}`, [], ['cells']);
    return finish(doc, ctx, 'add_grid_mesh', gridMeshOf(size, cells, position ?? [0, 0, 0]), {
      cellSize: [size[0] / cells[0], size[1] / cells[1]],
    });
  },
});
