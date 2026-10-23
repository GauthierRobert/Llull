/** attach_mesh_asset — put a stored full-resolution mesh asset into the document as a mesh entity with a display LOD (07 MSH FR-MSH-02). */

import type { Entity, MeshSolidEntity } from '../../model/types';
import { MESH_INLINE_TRIANGLE_CAP, MESH_LOD_TRIANGLES } from '../../geometry/mesh/assets';
import { lodMesh } from '../../geometry/mesh/lod';
import { isHexColor } from '../../lib/isHexColor';
import { nextId } from '../../lib/id';
import { DEFAULT_MESH_COLOR } from '../exchange/importMesh';
import { newEntity } from '../entity/newEntity';
import { changed } from '../noop';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { contextOf, meshRejection, withConventions } from './meshCommon';

/**
 * @affects creates 1 mesh entity: the display LOD inline, the full-resolution triangles by reference (up to the inline cap the triangles are copied inline)
 * @invariant the asset is immutable and content addressed; every mesh command reads it at full resolution
 * @failure no asset store -> MESH_ASSET_UNAVAILABLE; key not in this machine's store -> MESH_ASSET_MISSING
 */
export const attachMeshAsset = defineCommand({
  name: 'attach_mesh_asset',
  description:
    "Attach a mesh stored in this machine's content-addressed mesh asset store (made by `llull mesh import <file> --units mm`, or by a mesh command on a " +
    'large mesh) as a mesh entity. The document keeps a display level of detail (about 50 000 triangles) and the asset key; analyze_mesh, ' +
    'repair_mesh, decimate_mesh, the exports and every other mesh command read the full-resolution triangles from the store. Meshes of ' +
    `at most ${MESH_INLINE_TRIANGLE_CAP} triangles are copied inline instead. The entity is \`unverified\` unless the importer pinned the source sha256. ` +
    'Refusals: MESH_ASSET_UNAVAILABLE (no store here), MESH_ASSET_MISSING (key unknown on this machine: re-import the source file).',
  params: z.object({
    assetKey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe('The 64-hex key printed by `llull mesh import` (sha256 of the canonical mesh bytes).'),
    name: z.string().optional().describe('Entity name. Default none.'),
    color: z.string().optional().describe('Display colour "#rrggbb". Default: light grey.'),
    position: vec3('Offset [x, y, z] of the entity in document units.').optional(),
  }),
  run: (doc, { assetKey, name, color, position }, ctx): CommandResult => {
    const assets = contextOf(ctx).meshAssets;
    if (assets === undefined || assets === null)
      return meshRejection(doc, 'attach_mesh_asset', 'MESH_ASSET_UNAVAILABLE', 'no mesh asset store is installed here', [], ['assetKey']);
    const manifest = assets.manifest(assetKey);
    const full = manifest === null ? null : assets.readMesh(assetKey);
    if (manifest === null || full === null)
      return meshRejection(
        doc,
        'attach_mesh_asset',
        'MESH_ASSET_MISSING',
        `mesh asset ${assetKey} is not in this machine's store`,
        [],
        ['assetKey'],
      );
    const inline = manifest.triangles <= MESH_INLINE_TRIANGLE_CAP;
    const id = nextId('mesh');
    const geometry: Omit<MeshSolidEntity, keyof Entity> = {
      mesh: inline ? full : lodMesh(full, MESH_LOD_TRIANGLES),
      ...(inline
        ? {}
        : { asset: { key: manifest.key, triangles: manifest.triangles, vertices: manifest.vertices, bounds: manifest.bounds } }),
      meshSource: manifest.source ?? { format: 'generated', unitScale: 1, verified: false },
    };
    const entity = newEntity('mesh', id, geometry, position ?? [0, 0, 0], isHexColor(color) ? color : DEFAULT_MESH_COLOR, { name });
    const unverified = !(manifest.source?.verified ?? false);
    const result = changed(
      { ...doc, entities: { ...doc.entities, [id]: entity }, order: [...doc.order, id] },
      `attach_mesh_asset: '${id}' <- asset ${assetKey.slice(0, 12)}... (${manifest.triangles} triangles, ${manifest.vertices} vertices${inline ? ', inline' : `, display LOD ${(entity as MeshSolidEntity).mesh.indices.length / 3} triangles`})${unverified ? '; unverified' : ''}.`,
      [id],
    );
    return {
      ...result,
      data: withConventions(
        doc,
        {
          id,
          assetKey,
          triangles: manifest.triangles,
          vertices: manifest.vertices,
          bounds: manifest.bounds,
          inline,
          lodTriangles: (entity as MeshSolidEntity).mesh.indices.length / 3,
        },
        { unverified },
      ),
    };
  },
});
