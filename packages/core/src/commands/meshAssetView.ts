/**
 * Full-resolution view of asset-backed meshes for commands that read triangles (`annotations.readsMeshTriangles`, 07 MSH FR-MSH-02).
 * An asset-backed mesh entity holds only a display level of detail; a command that measures, analyses or exports must see the stored
 * mesh. `execute` swaps it in for every mesh the params reach (`meshReach`: entities, groups, layers, components, instances, records, or
 * the whole document when nothing is named) and for the asset-backed leaves of the construction trees (`brep`) of the entities it reaches,
 * runs the command, and puts the display level of detail back wherever the result still carries a swapped mesh, in the entity or in the
 * leaves of a new construction tree: a kernel result never keeps a stored mesh inline. An asset the host cannot read refuses with
 * MESH_ASSET_LOD_ONLY, and a reach above MESH_FULL_READ_TRIANGLE_CAP with MESH_ASSET_TOO_LARGE, rather than report a result about the
 * display mesh.
 */

import type { CadDocument, Entity, MeshData, MeshSolidEntity } from '../model/types';
import { MESH_FULL_READ_TRIANGLE_CAP, type MeshAssetPort } from '../geometry/mesh/assets';
import { mapSolidLeaves } from '../geometry/recipeLeaves';
import type { CommandResult, ExecutionContext } from './types';
import { commandError, rejection } from './noop';
import { type LoadFailure, isStoreFailure, meshRejection, storeMesh } from './mesh/meshCommon';
import { type BackedMesh, reachedMeshes } from './meshReach';

type Slot = Pick<BackedMesh, 'id' | 'componentId'>;

const where = (mesh: BackedMesh): string =>
  mesh.componentId === null ? `entity '${mesh.id}'` : `entity '${mesh.id}' of component '${mesh.componentId}'`;

const trianglesOf = (mesh: BackedMesh): number => mesh.assets.reduce((sum, asset) => sum + asset.triangles, 0);

const entityAt = (doc: CadDocument, slot: Slot): Entity | undefined =>
  slot.componentId === null ? doc.entities[slot.id] : doc.components[slot.componentId]?.entities[slot.id];

/** `doc` with the entity of each given slot replaced. */
function withEntities(doc: CadDocument, replacements: ReadonlyArray<readonly [Slot, Entity]>): CadDocument {
  let entities = doc.entities;
  let components = doc.components;
  for (const [slot, entity] of replacements) {
    if (slot.componentId === null) {
      entities = { ...entities, [slot.id]: entity };
      continue;
    }
    const component = components[slot.componentId];
    if (component !== undefined)
      components = { ...components, [slot.componentId]: { ...component, entities: { ...component.entities, [slot.id]: entity } } };
  }
  return entities === doc.entities && components === doc.components ? doc : { ...doc, entities, components };
}

/** The refusal when the reach holds more full-resolution triangles than one command may load, naming the meshes. */
function tooLarge(doc: CadDocument, commandName: string, wanted: readonly BackedMesh[], assetCount: number, total: number): CommandResult {
  const listed = [...wanted]
    .sort((a, b) => trianglesOf(b) - trianglesOf(a))
    .slice(0, 5)
    .map((mesh) => `${where(mesh)} (${trianglesOf(mesh)} triangles)`)
    .join(', ');
  return rejection(
    doc,
    `${commandName} rejected: the meshes it reaches hold ${total} full-resolution triangles in ${assetCount} asset(s), above the ${MESH_FULL_READ_TRIANGLE_CAP} ` +
      `a single command may load: ${listed}${wanted.length > 5 ? ', ...' : ''}; a result computed from the display level of detail would be wrong.`,
    commandError(
      'MESH_ASSET_TOO_LARGE',
      'Name fewer meshes in the params (a command that names none reads them all), or decimate_mesh them first.',
      wanted.map((mesh) => mesh.id),
    ),
  );
}

/** A stored mesh that was swapped in, with the display mesh it replaced and the key of its asset. */
interface Swapped {
  readonly display: MeshData;
  readonly key: string;
}

/**
 * `entity` with every swapped full mesh put back: its own mesh becomes the display mesh when the entity carries the asset of that stored mesh; an entity that
 * holds a stored mesh WITHOUT its reference (a command built a new entity from the view) has it written through `storeMesh` (a new asset and display mesh, or inline
 * below the cap); the leaves of its construction tree get their display mesh. A failure to store is returned for the caller to refuse by name.
 */
function withDisplayMeshes(
  entity: MeshSolidEntity,
  swapped: ReadonlyMap<MeshData, Swapped>,
  assets: MeshAssetPort | null,
): MeshSolidEntity | LoadFailure {
  const own = swapped.get(entity.mesh);
  let next = entity;
  if (own !== undefined && entity.asset?.key === own.key) next = { ...entity, mesh: own.display };
  else if (own !== undefined) {
    const stored = storeMesh(entity.mesh, assets);
    if (isStoreFailure(stored)) return stored;
    const { asset: _stale, ...bare } = entity;
    void _stale;
    next = { ...bare, mesh: stored.mesh, ...(stored.asset === undefined ? {} : { asset: stored.asset }) };
  }
  const brep =
    next.brep === undefined
      ? undefined
      : mapSolidLeaves(next.brep, (leaf) => {
          const shown = leaf.kind === 'mesh' ? swapped.get(leaf.mesh) : undefined;
          return leaf.kind === 'mesh' && shown !== undefined && leaf.asset?.key === shown.key
            ? { ...leaf, mesh: shown.display }
            : undefined;
        });
  return brep === next.brep || brep === undefined ? next : { ...next, brep };
}

/** The refusal when a new entity holds a stored mesh that cannot be written back to the asset store. */
function refuseUnstored(doc: CadDocument, commandName: string, failure: LoadFailure): CommandResult {
  return meshRejection(doc, commandName, failure.code, failure.message, failure.ids);
}

interface LostAsset {
  readonly id: string;
  readonly key: string;
}

/**
 * A read-only query ran on the display mesh of the entities whose asset this machine cannot read: the answer says so, by name, in the summary and
 * in `data` (`lodOnly`: the entity ids; `warnings`: code, ids and asset keys), so an agent can detect it.
 */
function withLodOnlyWarning(result: CommandResult, lost: readonly LostAsset[]): CommandResult {
  if (lost.length === 0) return result;
  const ids = [...new Set(lost.map((asset) => asset.id))];
  const keys = [...new Set(lost.map((asset) => asset.key))];
  const message = `MESH_ASSET_LOD_ONLY: ${ids.map((id) => `'${id}'`).join(', ')} (asset ${keys.map((key) => key.slice(0, 12)).join(', ')}...) not held on this machine: computed from the display level of detail`;
  const data =
    typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data) ? (result.data as Record<string, unknown>) : {};
  const earlier = Array.isArray(data['warnings']) ? (data['warnings'] as unknown[]) : [];
  return {
    ...result,
    summary: `${result.summary} WARNING ${message}.`,
    data: { ...data, lodOnly: ids, warnings: [...earlier, { code: 'MESH_ASSET_LOD_ONLY', ids, assetKeys: keys, message }] },
  };
}

/** Run `run` on a document whose asset-backed meshes reached by `params` carry their full-resolution triangles. */
export function runWithFullMeshes(
  doc: CadDocument,
  commandName: string,
  params: unknown,
  ctx: ExecutionContext,
  wholeDocument: boolean,
  degradable: boolean,
  run: (view: CadDocument) => CommandResult,
): CommandResult {
  const wanted = reachedMeshes(doc, params, wholeDocument);
  if (wanted.length === 0) return run(doc);
  const keys = new Map(wanted.flatMap((mesh) => mesh.assets).map((asset) => [asset.key, asset.triangles]));
  const total = [...keys.values()].reduce((sum, triangles) => sum + triangles, 0);
  if (total > MESH_FULL_READ_TRIANGLE_CAP) return tooLarge(doc, commandName, wanted, keys.size, total);
  const assets: MeshAssetPort | null = ctx.meshAssets ?? null;
  const fulls = new Map<string, MeshData>();
  const lost: LostAsset[] = [];
  const readable: BackedMesh[] = [];
  for (const mesh of wanted) {
    let held = true;
    for (const { key } of mesh.assets) {
      const full = fulls.get(key) ?? assets?.readMesh(key) ?? null;
      if (full === null && degradable) {
        lost.push({ id: mesh.id, key });
        held = false;
        break;
      }
      if (full === null)
        return rejection(
          doc,
          `${commandName} rejected: ${where(mesh)} keeps only a display level of detail of mesh asset ${key.slice(0, 12)}... and ` +
            `${assets === null ? 'no asset store is installed' : 'this machine does not hold the asset'}; a result computed from it would be wrong.`,
          commandError(
            'MESH_ASSET_LOD_ONLY',
            'Run on the machine that imported the mesh, or re-import it with import_mesh_file / attach_mesh_asset.',
            [mesh.id],
          ),
        );
      fulls.set(key, full);
    }
    if (held) readable.push(mesh);
  }
  if (readable.length === 0) return withLodOnlyWarning(run(doc), lost);
  const display = new Map<MeshData, Swapped>();
  const swapped = readable.map((slot): [BackedMesh, MeshSolidEntity] => {
    const { entity } = slot;
    let mesh = entity.mesh;
    if (entity.asset !== undefined) {
      mesh = fulls.get(entity.asset.key) as MeshData;
      display.set(mesh, { display: entity.mesh, key: entity.asset.key });
    }
    const brep =
      entity.brep === undefined
        ? undefined
        : mapSolidLeaves(entity.brep, (leaf) => {
            if (leaf.kind !== 'mesh' || leaf.asset === undefined) return undefined;
            const full = fulls.get(leaf.asset.key) as MeshData;
            display.set(full, { display: leaf.mesh, key: leaf.asset.key });
            return { ...leaf, mesh: full };
          });
    return [slot, { ...entity, mesh, ...(brep === undefined ? {} : { brep }) }];
  });
  const view = withEntities(doc, swapped);
  const result = run(view);
  if (result.document === view) return withLodOnlyWarning({ ...result, document: doc }, lost);
  const restores: Array<[Slot, Entity]> = [];
  const handled = new Set<string>();
  for (const [slot, viewEntity] of swapped) {
    handled.add(`${slot.componentId ?? ''}\u0000${slot.id}`);
    const current = entityAt(result.document, slot);
    if (current === viewEntity) restores.push([slot, slot.entity]);
    else if (current?.kind === 'mesh') {
      const patched = withDisplayMeshes(current, display, assets);
      if ('code' in patched) return refuseUnstored(doc, commandName, patched);
      if (patched !== current) restores.push([slot, patched]);
    }
  }
  for (const [id, entity] of Object.entries(result.document.entities)) {
    const before = doc.entities[id];
    if (entity.kind !== 'mesh' || handled.has(`\u0000${id}`) || before === entity) continue;
    const patched = withDisplayMeshes(entity, display, assets);
    if ('code' in patched) return refuseUnstored(doc, commandName, patched);
    if (patched !== entity) restores.push([{ id, componentId: null }, patched]);
  }
  return withLodOnlyWarning(restores.length === 0 ? result : { ...result, document: withEntities(result.document, restores) }, lost);
}
