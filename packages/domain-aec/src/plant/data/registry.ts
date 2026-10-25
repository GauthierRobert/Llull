/**
 * The tag registry (plant 08 DAT §5.3, TR-DAT-07): derived from the plant objects on demand and cached by the identity of the data record, never
 * stored, so it cannot diverge from the objects. A tag is unique per scope; scopes are keyed by the hierarchy ancestor of the class tag scope, and
 * scopes of different width collide: a project-scoped tag collides with the same tag anywhere, a site-scoped one with the plants below that site.
 * `extendRegistry` derives the registry of a data record that only appended one object from the previous registry (Map copies, no object walk).
 */

import { resolvedOrNull } from './classes';
import { ancestry, scopeKey } from './hierarchy';
import { targetKey, type PlantDataModel, type PlantObject, type TagScope } from './model';
import { normaliseTag } from './tagFormat';

export interface ScopeInfo {
  readonly key: string;
  readonly kind: TagScope;
}

export interface ObjectRegistry {
  /** scope key -> normalised tag -> ids of the objects holding it, in object order. */
  readonly byScope: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  readonly scopeOf: ReadonlyMap<string, ScopeInfo>;
  /** normalised tag -> ids over all scopes. */
  readonly byTag: ReadonlyMap<string, readonly string[]>;
  /** provider target key (`buildingElement:equipment-2`) -> id of the plant object standing for it. */
  readonly byTarget: ReadonlyMap<string, string>;
  /** Objects indexed: the registry is valid for a data record with this many objects only (it is shared along an append-only lineage). */
  readonly count: number;
}

/** Scope of an object: its class tag scope applied to its hierarchy node. */
export function objectScopeInfo(data: PlantDataModel, object: Pick<PlantObject, 'className' | 'hierarchyId'>): ScopeInfo {
  const kind = resolvedOrNull(data, object.className)?.tagScope ?? data.settings.defaultTagScope;
  return { key: scopeKey(data, object.hierarchyId, kind), kind };
}

/** Do two scopes share tags? Equal scopes do, a project scope meets everything, a site scope meets the plants below it. */
export function scopesCollide(data: PlantDataModel, a: ScopeInfo, b: ScopeInfo): boolean {
  if (a.kind === 'project' || b.kind === 'project') return true;
  if (a.kind === b.kind) return a.key === b.key;
  const [wide, narrow] = a.kind === 'site' ? [a, b] : [b, a];
  return ancestry(data, narrow.key).some((node) => node.id === wide.key);
}

const cache = new WeakMap<PlantDataModel, ObjectRegistry>();

interface Mutable {
  byScope: Map<string, Map<string, string[]>>;
  scopeOf: Map<string, ScopeInfo>;
  byTag: Map<string, string[]>;
  byTarget: Map<string, string>;
  count: number;
}

function add(registry: Mutable, object: PlantObject, scope: ScopeInfo): void {
  const tag = normaliseTag(object.tag);
  registry.scopeOf.set(object.id, scope);
  let tags = registry.byScope.get(scope.key);
  if (tags === undefined) registry.byScope.set(scope.key, (tags = new Map()));
  tags.set(tag, [...(tags.get(tag) ?? []), object.id]);
  registry.byTag.set(tag, [...(registry.byTag.get(tag) ?? []), object.id]);
  const key = targetKey(object.target);
  if (key !== null) registry.byTarget.set(key, object.id);
  registry.count += 1;
}

export function objectRegistry(data: PlantDataModel): ObjectRegistry {
  const cached = cache.get(data);
  if (cached !== undefined && cached.count === data.objectOrder.length) return cached;
  const registry: Mutable = { byScope: new Map(), scopeOf: new Map(), byTag: new Map(), byTarget: new Map(), count: 0 };
  for (const id of data.objectOrder) {
    const object = data.objects[id];
    if (object !== undefined) add(registry, object, objectScopeInfo(data, object));
  }
  cache.set(data, registry);
  return registry;
}

/**
 * Moves the registry of `previous` on to `next` (= `previous` plus the appended `object`) in place, O(1): the registry is shared along the lineage and
 * stays valid for the newest record only (a record of another length rebuilds its own). A no-op when `previous` has no valid registry cached.
 */
export function extendRegistry(previous: PlantDataModel, next: PlantDataModel, object: PlantObject): void {
  const base = cache.get(previous);
  if (base === undefined || base.count !== previous.objectOrder.length) return;
  add(base as Mutable, object, objectScopeInfo(next, object));
  cache.set(next, base);
}

/** Ids holding `tag` in a scope that collides with `scope`. */
export function collidingHolders(data: PlantDataModel, registry: ObjectRegistry, scope: ScopeInfo, tag: string): string[] {
  return (registry.byTag.get(normaliseTag(tag)) ?? []).filter((id) => {
    const other = registry.scopeOf.get(id);
    return other !== undefined && scopesCollide(data, scope, other);
  });
}

/** Every tag (normalised) held in a scope that collides with `scope`. */
export function collidingTags(data: PlantDataModel, registry: ObjectRegistry, scope: ScopeInfo): string[] {
  const tags: string[] = [];
  for (const inner of registry.byScope.values()) {
    const first = inner.values().next().value?.[0];
    const other = first === undefined ? undefined : registry.scopeOf.get(first);
    if (other !== undefined && scopesCollide(data, scope, other)) tags.push(...inner.keys());
  }
  return tags;
}

/** Tags held by several objects whose scopes collide: one entry per tag with all the colliding holders. */
export function duplicateTags(data: PlantDataModel, registry: ObjectRegistry): Array<{ tag: string; ids: string[] }> {
  const groups: Array<{ tag: string; ids: string[] }> = [];
  for (const [tag, ids] of registry.byTag) {
    if (ids.length < 2) continue;
    const clash = ids.filter((id, index) =>
      ids.some(
        (other, otherIndex) =>
          otherIndex !== index && scopesCollide(data, registry.scopeOf.get(id) as ScopeInfo, registry.scopeOf.get(other) as ScopeInfo),
      ),
    );
    if (clash.length > 1) groups.push({ tag, ids: clash });
  }
  return groups;
}

/** Ids of the objects that hold `tag` in any scope. */
export const idsWithTag = (registry: ObjectRegistry, tag: string): readonly string[] => registry.byTag.get(normaliseTag(tag)) ?? [];

/** The object a caller means by an id or a tag; `ambiguous` when a tag is held in several (disjoint) scopes. */
export function objectByRef(data: PlantDataModel, reference: string): PlantObject | 'ambiguous' | null {
  const byId = data.objects[reference];
  if (byId !== undefined) return byId;
  const ids = idsWithTag(objectRegistry(data), reference);
  if (ids.length > 1) return 'ambiguous';
  return ids[0] === undefined ? null : (data.objects[ids[0]] ?? null);
}
