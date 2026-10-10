import { type CadDocument, type Entity, is3D } from '../model/types';
import { expandInstance } from './instanceExpansion';
import { solidTriangles } from './solidTriangulation';
import type { Triangle } from './exportMath';

/**
 * World-space triangles of one entity; instances are expanded through their component (`doc`).
 * 2D shapes return [].
 */
export function entityToTriangles(e: Entity, doc: CadDocument): Triangle[] {
  if (e.kind === 'instance') {
    const component = doc.components[e.componentId];
    if (!component) return [];
    return expandInstance(e, component).flatMap((child) => entityToTriangles(child, doc));
  }
  return solidTriangles(e);
}

/**
 * World-space triangles of the entities named by `requestedIds` (all of `doc.order` when
 * undefined/empty). Unknown ids are reported, 2D entities are counted and skipped.
 */
export function collectExportTriangles(
  doc: CadDocument,
  requestedIds: readonly string[] | undefined,
): { tris: Triangle[]; skipped2D: number; unknownIds: string[] } {
  const unknownIds: string[] = [];
  let idsToProcess: readonly string[] = doc.order;
  if (requestedIds && requestedIds.length > 0) {
    idsToProcess = requestedIds.filter((id) => {
      const known = doc.entities[id] !== undefined;
      if (!known) unknownIds.push(id);
      return known;
    });
  }
  const tris: Triangle[] = [];
  let skipped2D = 0;
  for (const id of idsToProcess) {
    const entity = doc.entities[id];
    if (!entity) continue;
    if (!is3D(entity)) {
      skipped2D++;
      continue;
    }
    for (const t of entityToTriangles(entity, doc)) tris.push(t);
  }
  return { tris, skipped2D, unknownIds };
}

/** Summary line shared by the mesh export commands. */
export function exportSummary(
  command: string,
  format: string,
  { tris, skipped2D, unknownIds }: ReturnType<typeof collectExportTriangles>,
): string {
  const parts = [
    `${command}: ${tris.length} triangle${tris.length !== 1 ? 's' : ''} exported (format=${format}).`,
  ];
  if (skipped2D > 0) parts.push(`${skipped2D} 2D entit${skipped2D !== 1 ? 'ies' : 'y'} skipped.`);
  if (unknownIds.length > 0) parts.push(`Unknown ids skipped: ${unknownIds.join(', ')}.`);
  return parts.join(' ');
}
