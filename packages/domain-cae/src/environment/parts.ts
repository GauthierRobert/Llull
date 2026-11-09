/** The physical parts of a scope for the screening: top-level solids and, through component instances, every instanced child once per instance (multiplicity counts). */

import { expandInstance } from '@core/geometry/instanceExpansion';
import type { CadDocument, Entity } from '@core/model/types';

/** One part with the material that applies to it and a document in which `entityId` can be measured. */
export interface Part {
  /** The entity the caller named (an instance for its children). */
  readonly rootId: string;
  /** The measurable entity: the root itself, or `expanded::<instance>::<source>` for an instanced child. */
  readonly entityId: string;
  readonly material: string;
  readonly measureIn: CadDocument;
}

/** Nesting depth of instances followed; an instance deeper (or a cyclic component) is skipped with a reason. */
const MAX_DEPTH = 8;
/** Baked children visited at most (hostile documents); the rest is skipped with a reason. */
const MAX_PARTS = 100000;

/** A root whose parts could not all be listed: never silently dropped. */
export interface SkippedPart {
  readonly rootId: string;
  readonly reason: 'component missing' | 'nesting deeper than 8 or cyclic' | 'part cap reached';
}

interface Walk {
  readonly parts: Part[];
  readonly skipped: SkippedPart[];
  visited: number;
}

function skip(walk: Walk, rootId: string, reason: SkippedPart['reason']): void {
  if (!walk.skipped.some((entry) => entry.rootId === rootId && entry.reason === reason)) walk.skipped.push({ rootId, reason });
}

function expandPart(
  doc: CadDocument,
  rootId: string,
  instance: Entity & { kind: 'instance' },
  inherited: string | undefined,
  depth: number,
  walk: Walk,
): void {
  const component = Object.hasOwn(doc.components, instance.componentId) ? doc.components[instance.componentId] : undefined;
  if (component === undefined) return skip(walk, rootId, 'component missing');
  if (depth >= MAX_DEPTH) return skip(walk, rootId, 'nesting deeper than 8 or cyclic');
  const instanceMaterial = instance.materialId ?? inherited;
  for (const baked of expandInstance(instance, component)) {
    if (walk.visited >= MAX_PARTS) return skip(walk, rootId, 'part cap reached');
    walk.visited += 1;
    const material = baked.materialId ?? instanceMaterial;
    if (baked.kind === 'instance') {
      expandPart(doc, rootId, baked, material, depth + 1, walk);
      continue;
    }
    if (material === undefined) continue;
    walk.parts.push({
      rootId,
      entityId: baked.id,
      material,
      measureIn: { ...doc, entities: { ...doc.entities, [baked.id]: { ...baked, materialId: material } as Entity } },
    });
  }
}

/** Parts of `entityIds` (default: every top-level entity) that carry a material, and the roots that could not be fully listed; instances expand to their children, once per instance. */
export function partsOf(doc: CadDocument, entityIds?: readonly string[]): { parts: Part[]; skipped: SkippedPart[] } {
  const roots =
    entityIds === undefined
      ? Object.values(doc.entities)
      : entityIds.flatMap((id) => (Object.hasOwn(doc.entities, id) ? [doc.entities[id] as Entity] : []));
  const walk: Walk = { parts: [], skipped: [], visited: 0 };
  for (const root of roots) {
    if (root.kind === 'instance') expandPart(doc, root.id, root, undefined, 0, walk);
    else if (root.materialId !== undefined)
      walk.parts.push({ rootId: root.id, entityId: root.id, material: root.materialId, measureIn: doc });
  }
  return { parts: walk.parts, skipped: walk.skipped };
}

/** Material -> ids of the entities (roots) that carry it. */
export function usersOf(parts: readonly Part[]): Map<string, string[]> {
  const seen = new Map<string, Set<string>>();
  for (const part of parts) {
    const roots = seen.get(part.material);
    if (roots === undefined) seen.set(part.material, new Set([part.rootId]));
    else roots.add(part.rootId);
  }
  return new Map([...seen].map(([material, roots]) => [material, [...roots]]));
}
