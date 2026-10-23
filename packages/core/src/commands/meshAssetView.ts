/**
 * Full-resolution view of asset-backed meshes for commands that read triangles (`annotations.readsMeshTriangles`, 07 MSH FR-MSH-02).
 * An asset-backed mesh entity holds only a display level of detail; a command that measures, analyses or exports must see the stored
 * mesh. `execute` swaps it in for the entities the params name (all of them for a read-only command that names none), runs the command,
 * and puts the level of detail back wherever the result still carries the swapped mesh. An asset the host cannot read refuses with
 * MESH_ASSET_LOD_ONLY rather than report a result about the display mesh.
 */

import type { CadDocument, Entity, MeshData } from '../model/types';
import type { MeshAssetPort } from '../geometry/mesh/assets';
import type { CommandResult, ExecutionContext } from './types';
import { commandError, rejection } from './noop';

function assetBackedIds(doc: CadDocument): string[] {
  return Object.keys(doc.entities).filter((id) => {
    const entity = doc.entities[id];
    return entity?.kind === 'mesh' && entity.asset !== undefined;
  });
}

function namedIds(value: unknown, known: ReadonlySet<string>, found: Set<string>): void {
  if (typeof value === 'string') {
    if (known.has(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) namedIds(item, known, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) namedIds(item, known, found);
  }
}

/** Run `run` on a document whose asset-backed meshes (named by `params`, or all when `allWhenUnnamed`) carry their full-resolution triangles. */
export function runWithFullMeshes(
  doc: CadDocument,
  commandName: string,
  params: unknown,
  ctx: ExecutionContext,
  allWhenUnnamed: boolean,
  run: (view: CadDocument) => CommandResult,
): CommandResult {
  const backed = assetBackedIds(doc);
  if (backed.length === 0) return run(doc);
  const named = new Set<string>();
  namedIds(params, new Set(backed), named);
  const wanted = named.size > 0 ? [...named] : allWhenUnnamed ? backed : [];
  if (wanted.length === 0) return run(doc);
  const assets: MeshAssetPort | null = ctx.meshAssets ?? null;
  const originals = new Map<string, Entity>();
  const fulls = new Map<string, MeshData>();
  let entities = doc.entities;
  for (const id of wanted) {
    const entity = doc.entities[id];
    if (entity?.kind !== 'mesh' || entity.asset === undefined) continue;
    const full = assets?.readMesh(entity.asset.key) ?? null;
    if (full === null)
      return rejection(
        doc,
        `${commandName} rejected: entity '${id}' keeps only a display level of detail of mesh asset ${entity.asset.key.slice(0, 12)}... and ` +
          `${assets === null ? 'no asset store is installed' : 'this machine does not hold the asset'}; a result computed from it would be wrong.`,
        commandError(
          'MESH_ASSET_LOD_ONLY',
          'Run on the machine that imported the mesh, or re-import it with import_mesh_file / attach_mesh_asset.',
          [id],
        ),
      );
    originals.set(id, entity);
    fulls.set(id, full);
    entities = { ...entities, [id]: { ...entity, mesh: full } };
  }
  const view: CadDocument = { ...doc, entities };
  const result = run(view);
  if (result.document === view) return { ...result, document: doc };
  let restored = result.document.entities;
  for (const [id, full] of fulls) {
    const after = restored[id];
    if (after?.kind === 'mesh' && after.mesh === full)
      restored = { ...restored, [id]: { ...after, mesh: (originals.get(id) as typeof after).mesh } };
  }
  return restored === result.document.entities ? result : { ...result, document: { ...result.document, entities: restored } };
}
