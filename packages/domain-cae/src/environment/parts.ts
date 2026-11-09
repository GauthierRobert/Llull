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

/** Nesting depth of instances followed; deeper (or cyclic) nesting stops. */
const MAX_DEPTH = 8;
/** Parts returned at most (hostile documents). */
const MAX_PARTS = 100000;

function expandPart(
  doc: CadDocument,
  rootId: string,
  instance: Entity & { kind: 'instance' },
  inherited: string | undefined,
  depth: number,
  into: Part[],
): void {
  const component = Object.hasOwn(doc.components, instance.componentId) ? doc.components[instance.componentId] : undefined;
  if (component === undefined || depth >= MAX_DEPTH) return;
  const instanceMaterial = instance.materialId ?? inherited;
  for (const baked of expandInstance(instance, component)) {
    if (into.length >= MAX_PARTS) return;
    const material = baked.materialId ?? instanceMaterial;
    if (baked.kind === 'instance') {
      expandPart(doc, rootId, baked, material, depth + 1, into);
      continue;
    }
    if (material === undefined) continue;
    into.push({
      rootId,
      entityId: baked.id,
      material,
      measureIn: { ...doc, entities: { ...doc.entities, [baked.id]: { ...baked, materialId: material } as Entity } },
    });
  }
}

/** Parts of `entityIds` (default: every top-level entity) that carry a material; instances expand to their children, once per instance. */
export function partsOf(doc: CadDocument, entityIds?: readonly string[]): Part[] {
  const roots =
    entityIds === undefined
      ? Object.values(doc.entities)
      : entityIds.flatMap((id) => (Object.hasOwn(doc.entities, id) ? [doc.entities[id] as Entity] : []));
  const parts: Part[] = [];
  for (const root of roots) {
    if (root.kind === 'instance') expandPart(doc, root.id, root, undefined, 0, parts);
    else if (root.materialId !== undefined) parts.push({ rootId: root.id, entityId: root.id, material: root.materialId, measureIn: doc });
  }
  return parts;
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
