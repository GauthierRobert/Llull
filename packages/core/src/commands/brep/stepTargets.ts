/** Which solids `export_step_exact` writes: loose 3D solids and component instances (with the unique occurrence label of each). */

import { type CadDocument, type Entity, type InstanceEntity, is3D } from '../../model/types';
import { isCurve3D, isSheet } from '../../model/curveKinds';
import { expandInstance } from '../../geometry/instanceExpansion';
import type { StepLabel } from './stepLabels';

/** A loose solid, or an instance with its label (`Name`, or `Name 1`, `Name 2` when several share one) and its solids baked in world space. */
export type StepEntry =
  | { readonly kind: 'solid'; readonly entity: Entity }
  | { readonly kind: 'instance'; readonly instance: InstanceEntity; readonly label: string; readonly baked: readonly Entity[] };

/** Product name (entity name, else id), group name as description, and color of each solid. */
export function stepLabels(doc: CadDocument, solids: readonly Entity[]): StepLabel[] {
  const groups = Object.values(doc.groups);
  return solids.map((entity) => {
    const group = groups.find((candidate) => candidate.memberIds.includes(entity.id));
    return { name: entity.name ?? entity.id, color: entity.color, ...(group !== undefined ? { description: group.name } : {}) };
  });
}

/** Component instances nested deeper than this are not exported (guards against reference cycles). */
export const MAX_INSTANCE_DEPTH = 4;

/** The 3D solids of a component instance in world space (nested instances expanded), named `<instance>/<part>`. */
export function instanceSolids(doc: CadDocument, instance: InstanceEntity, label: string, depth: number): Entity[] {
  const component = doc.components[instance.componentId];
  if (component === undefined || depth >= MAX_INSTANCE_DEPTH) return [];
  const children = expandInstance(instance, component);
  return children.flatMap((child, index): Entity[] => {
    const nestedComponent = child.kind === 'instance' ? doc.components[child.componentId] : undefined;
    const fallback = nestedComponent?.name ?? (children.length === 1 ? component.name : `${component.name} ${index + 1}`);
    const name = `${label}/${child.name ?? fallback}`;
    if (child.kind === 'instance') return instanceSolids(doc, child, name, depth + 1);
    return is3D(child) ? [{ ...child, name }] : [];
  });
}

/**
 * The exportable entries in `entityIds` (or the whole document), their flat solids, the surface sheets (written as faces when the kernel can build
 * them), plus the ids skipped and why.
 */
export function stepTargets(
  doc: CadDocument,
  entityIds: readonly string[] | undefined,
): { solids: Entity[]; sheets: Entity[]; skipped: string[]; entries: StepEntry[] } {
  const ids = entityIds !== undefined && entityIds.length > 0 ? entityIds : doc.order;
  const entries: StepEntry[] = [];
  const skipped: string[] = [];
  const sheets: Entity[] = [];
  const baseOf = (instance: InstanceEntity): string => instance.name ?? doc.components[instance.componentId]?.name ?? 'instance';
  const bases = ids.flatMap((id) => {
    const entity = doc.entities[id];
    return entity?.kind === 'instance' ? [baseOf(entity)] : [];
  });
  const seen = new Map<string, number>();
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity === undefined) skipped.push(`${id} (not found)`);
    else if (entity.kind === 'instance') {
      const base = baseOf(entity);
      const ordinal = (seen.get(base) ?? 0) + 1;
      seen.set(base, ordinal);
      const label = bases.filter((candidate) => candidate === base).length > 1 ? `${base} ${ordinal}` : base;
      const baked = instanceSolids(doc, entity, label, 0);
      if (baked.length === 0) skipped.push(`${id} (instance without solids)`);
      else entries.push({ kind: 'instance', instance: entity, label, baked });
    } else if (is3D(entity)) entries.push({ kind: 'solid', entity });
    else if (isSheet(entity)) sheets.push(entity);
    else if (entityIds !== undefined && entityIds.length > 0) skipped.push(`${id} (${isCurve3D(entity) ? '3D curve' : '2D'})`);
  }
  const solids = entries.flatMap((entry) => (entry.kind === 'solid' ? [entry.entity] : [...entry.baked]));
  return { solids, sheets, skipped, entries };
}
