/**
 * The tag registry (plant 08 DAT §5.3, TR-DAT-07): derived from the plant objects on demand and cached by the identity of the data record, never
 * stored, so it cannot diverge from the objects. A tag is unique per scope; scopes are keyed by the hierarchy ancestor of the class tag scope.
 */

import { resolvedOrNull } from './classes';
import { scopeKey } from './hierarchy';
import type { PlantDataModel, PlantObject } from './model';
import { normaliseTag } from './tagFormat';

export interface ObjectRegistry {
  /** scope key -> normalised tag -> ids of the objects holding it, in object order. */
  readonly byScope: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly scopeOf: ReadonlyMap<string, string>;
  /** normalised tag -> ids over all scopes (resolving a tag typed by a caller). */
  readonly byTag: ReadonlyMap<string, readonly string[]>;
}

/** Scope key of an object: its class tag scope applied to its hierarchy node. */
export function objectScope(data: PlantDataModel, object: PlantObject): string {
  const scope = resolvedOrNull(data, object.className)?.tagScope ?? data.settings.defaultTagScope;
  return scopeKey(data, object.hierarchyId, scope);
}

const cache = new WeakMap<PlantDataModel, ObjectRegistry>();

function push<K>(map: Map<K, string[]>, key: K, id: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [id]);
  else list.push(id);
}

export function objectRegistry(data: PlantDataModel): ObjectRegistry {
  const cached = cache.get(data);
  if (cached !== undefined) return cached;
  const byScope = new Map<string, Map<string, string[]>>();
  const scopeOf = new Map<string, string>();
  const byTag = new Map<string, string[]>();
  for (const id of data.objectOrder) {
    const object = data.objects[id];
    if (object === undefined) continue;
    const scope = objectScope(data, object);
    const tag = normaliseTag(object.tag);
    scopeOf.set(id, scope);
    let tags = byScope.get(scope);
    if (tags === undefined) {
      tags = new Map();
      byScope.set(scope, tags);
    }
    push(tags, tag, id);
    push(byTag, tag, id);
  }
  const registry = { byScope, scopeOf, byTag };
  cache.set(data, registry);
  return registry;
}

/** Ids holding `tag` in `scope`. */
export const holdersOf = (registry: ObjectRegistry, scope: string, tag: string): readonly string[] =>
  registry.byScope.get(scope)?.get(normaliseTag(tag)) ?? [];

/** Every tag of a scope, normalised. */
export const tagsInScope = (registry: ObjectRegistry, scope: string): string[] => [...(registry.byScope.get(scope)?.keys() ?? [])];

/** Ids of the objects that hold `tag` in any scope. */
export const idsWithTag = (registry: ObjectRegistry, tag: string): readonly string[] => registry.byTag.get(normaliseTag(tag)) ?? [];

/** The object a caller means by an id or a tag; `ambiguous` when a tag is held in several scopes. */
export function objectByRef(data: PlantDataModel, reference: string): PlantObject | 'ambiguous' | null {
  const byId = data.objects[reference];
  if (byId !== undefined) return byId;
  const ids = idsWithTag(objectRegistry(data), reference);
  if (ids.length > 1) return 'ambiguous';
  return ids[0] === undefined ? null : (data.objects[ids[0]] ?? null);
}
