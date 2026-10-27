/**
 * Which asset-backed meshes a command can read (07 MSH FR-MSH-02, TECHNICAL_SPEC 13.11). A command names its targets through params, but
 * a param may be an entity, a group, a layer, a component, an instance, or the id of any record of the document (a joint, a sheet, a
 * plugin's case or study) that in turn names entities. The reach is the closure of those references; no param naming any entity at all
 * means the command's default scope (the selection or the whole document), so every asset-backed mesh. The result is always a superset
 * of what the command reads: loading too much is safe, loading too little is a silently wrong number.
 */

import type { CadDocument, Entity, MeshSolidEntity } from '../model/types';
import type { MeshAssetRef } from '../model/meshProvenance';
import { assetLeaves } from '../geometry/recipeLeaves';

/**
 * A mesh entity that depends on stored assets: its own (`entity.asset`), or those of the mesh leaves of its construction tree (`brep`; a
 * kernel result built from a scan). It is an entity of the document (`componentId` null) or one inside a component definition.
 */
export interface BackedMesh {
  readonly id: string;
  readonly componentId: string | null;
  readonly entity: MeshSolidEntity;
  /** The assets the entity depends on, its own first. */
  readonly assets: readonly MeshAssetRef[];
}

function assetRefsOf(entity: Entity): readonly MeshAssetRef[] {
  if (entity.kind !== 'mesh') return [];
  const own = entity.asset === undefined ? [] : [entity.asset];
  return entity.brep === undefined ? own : [...own, ...assetLeaves(entity.brep).map((leaf) => leaf.asset)];
}

const backedOf = (id: string, componentId: string | null, entity: Entity): BackedMesh | null => {
  const assets = assetRefsOf(entity);
  return assets.length > 0 && entity.kind === 'mesh' ? { id, componentId, entity, assets } : null;
};

/** Top-level document fields that are not records an id can name (entities, components and groups are resolved on their own). */
const NOT_RECORDS: ReadonlySet<string> = new Set([
  'entities',
  'order',
  'layers',
  'layerOrder',
  'selection',
  'camera',
  'groups',
  'featureHistory',
  'blobs',
  'recipes',
  'components',
  'parameters',
  'configurations',
  'materials',
  'animations',
  'units',
]);

/** Entity fields that hold ids of things other than the entities the entity depends on. */
const NOT_REFERENCES: ReadonlySet<string> = new Set(['id', 'kind', 'layerId', 'materialId', 'color', 'name', 'mesh', 'brep', 'stepSlab']);

const MAX_INDEX_DEPTH = 6;
const MAX_TOKEN_DEPTH = 12;

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null && !ArrayBuffer.isView(value);

/** The ids a params object or a record can name: its string values, and its object keys (map-shaped params keyed by entity id). */
interface Tokens {
  readonly values: Set<string>;
  readonly keys: Set<string>;
}

const newTokens = (): Tokens => ({ values: new Set(), keys: new Set() });

function collectTokens(value: unknown, into: Tokens, seen: WeakSet<object> = new WeakSet(), depth = 0): void {
  if (typeof value === 'string') into.values.add(value);
  else if (isRecord(value) && depth < MAX_TOKEN_DEPTH && !seen.has(value)) {
    seen.add(value);
    if (Array.isArray(value)) {
      if (typeof value[0] === 'number') return;
      for (const item of value) collectTokens(item, into, seen, depth + 1);
    } else
      for (const [key, item] of Object.entries(value)) {
        into.keys.add(key);
        collectTokens(item, into, seen, depth + 1);
      }
  }
}

const recordIndexes = new WeakMap<object, ReadonlyMap<string, readonly object[]>>();

/** Real records under `slice`: a table entry whose key is its own `id`, or an array item with an `id` (a slice object that is unchanged keeps its index). */
function recordIndex(slice: object): ReadonlyMap<string, readonly object[]> {
  const cached = recordIndexes.get(slice);
  if (cached !== undefined) return cached;
  const index = new Map<string, object[]>();
  const add = (key: string, record: object): void => {
    const list = index.get(key);
    if (list === undefined) index.set(key, [record]);
    else list.push(record);
  };
  const seen = new WeakSet<object>();
  const visit = (value: object, depth: number): void => {
    if (depth > MAX_INDEX_DEPTH || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (!isRecord(value[0])) return;
      for (const item of value) {
        if (!isRecord(item) || Array.isArray(item)) continue;
        const own = (item as { readonly id?: unknown }).id;
        if (typeof own === 'string') add(own, item);
        visit(item, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (!isRecord(child)) continue;
      if (!Array.isArray(child) && (child as { readonly id?: unknown }).id === key) add(key, child);
      visit(child, depth + 1);
    }
  };
  visit(slice, 0);
  recordIndexes.set(slice, index);
  return index;
}

/** Records of `doc` (plugin slices and the other record tables) that `token` is the key or `id` of. */
function recordsNamed(doc: CadDocument, token: string): readonly object[] {
  const found: object[] = [];
  for (const [field, slice] of Object.entries(doc)) {
    if (NOT_RECORDS.has(field) || !isRecord(slice)) continue;
    const records = recordIndex(slice).get(token);
    if (records !== undefined) found.push(...records);
  }
  return found;
}

function allBacked(doc: CadDocument): BackedMesh[] {
  const found: BackedMesh[] = [];
  for (const [id, entity] of Object.entries(doc.entities)) {
    const backed = backedOf(id, null, entity);
    if (backed !== null) found.push(backed);
  }
  for (const [componentId, component] of Object.entries(doc.components))
    for (const [id, entity] of Object.entries(component.entities)) {
      const backed = backedOf(id, componentId, entity);
      if (backed !== null) found.push(backed);
    }
  return found;
}

/** The slot key of a mesh: unique across the document and its components. */
const slotKey = (mesh: Pick<BackedMesh, 'id' | 'componentId'>): string => `${mesh.componentId ?? ''}\u0000${mesh.id}`;

/**
 * The asset-backed meshes `params` reach in `doc`: every one of them for a whole-document command (`readsMeshTriangles: 'document'`) and when
 * no param names an entity, group, layer, component or record of the document (the default scope).
 * @invariant a superset of the meshes the command reads; empty when `doc` holds no asset-backed mesh
 */
export function reachedMeshes(doc: CadDocument, params: unknown, wholeDocument: boolean): BackedMesh[] {
  const all = allBacked(doc);
  if (all.length === 0 || wholeDocument) return all;
  const reached = new Map<string, BackedMesh>();
  const seenTokens = new Set<string>();
  const seenComponents = new Set<string>();
  let touched = 0;
  const visitEntity = (id: string, entity: Entity, componentId: string | null): void => {
    touched++;
    const backed = backedOf(id, componentId, entity);
    if (backed !== null) reached.set(slotKey({ id, componentId }), backed);
    else if (entity.kind === 'instance') visitComponent(entity.componentId);
    else {
      const named = newTokens();
      for (const [field, value] of Object.entries(entity)) if (!NOT_REFERENCES.has(field)) collectTokens(value, named);
      visitAll(named);
    }
  };
  const visitComponent = (componentId: string): void => {
    const component = Object.hasOwn(doc.components, componentId) ? doc.components[componentId] : undefined;
    if (component === undefined || seenComponents.has(componentId)) return;
    seenComponents.add(componentId);
    touched++;
    for (const [id, entity] of Object.entries(component.entities)) visitEntity(id, entity, componentId);
  };
  const visitAll = (named: Tokens): void => {
    for (const token of named.values) visitToken(token, true);
    for (const token of named.keys) visitToken(token, false);
  };
  const visitToken = (token: string, asRecordId: boolean): void => {
    const seenKey = `${asRecordId ? 'v' : 'k'}${token}`;
    if (seenTokens.has(seenKey)) return;
    seenTokens.add(seenKey);
    if (Object.hasOwn(doc.entities, token)) visitEntity(token, doc.entities[token] as Entity, null);
    if (Object.hasOwn(doc.groups, token)) {
      touched++;
      for (const member of (doc.groups[token] as { memberIds: string[] }).memberIds) visitToken(member, true);
    }
    if (Object.hasOwn(doc.layers, token)) {
      touched++;
      for (const [id, entity] of Object.entries(doc.entities)) if (entity.layerId === token) visitEntity(id, entity, null);
    }
    visitComponent(token);
    if (!asRecordId) return;
    for (const record of recordsNamed(doc, token)) {
      touched++;
      const named = newTokens();
      collectTokens(record, named);
      visitAll(named);
    }
  };
  const paramTokens = newTokens();
  collectTokens(params, paramTokens);
  visitAll(paramTokens);
  return touched === 0 ? all : [...reached.values()];
}
