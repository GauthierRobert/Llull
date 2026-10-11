import { type CadDocument, type Entity, is3D } from '../model/types';
import { expandInstance } from './instanceExpansion';
import { solidTriangles } from './solidTriangles';
import type { Triangle } from './triangles';

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

/** Flat xyz triple list of `entityToTriangles` (the input of mesh welding / sewing). */
export function entityTrianglePositions(e: Entity, doc: CadDocument): number[] {
  return entityToTriangles(e, doc).flatMap((triangle) => triangle.flat());
}

/** One exportable 3D entity with its world-space triangles (the unit of per-entity exports). */
export interface ExportPart {
  readonly id: string;
  /** `set_entity_name` label, when set. */
  readonly name: string | undefined;
  /** Entity hex color, e.g. "#c8553d". */
  readonly color: string;
  readonly tris: Triangle[];
}

/**
 * The exportable 3D entities named by `requestedIds` (all of `doc.order` when undefined/empty),
 * each with its world-space triangles. Unknown ids are reported, 2D entities are counted and skipped.
 */
export function collectExportParts(
  doc: CadDocument,
  requestedIds: readonly string[] | undefined,
): { parts: ExportPart[]; skipped2D: number; unknownIds: string[] } {
  const unknownIds: string[] = [];
  let idsToProcess: readonly string[] = doc.order;
  if (requestedIds && requestedIds.length > 0) {
    idsToProcess = requestedIds.filter((id) => {
      const known = doc.entities[id] !== undefined;
      if (!known) unknownIds.push(id);
      return known;
    });
  }
  const parts: ExportPart[] = [];
  let skipped2D = 0;
  for (const id of idsToProcess) {
    const entity = doc.entities[id];
    if (!entity) continue;
    if (!is3D(entity)) {
      skipped2D++;
      continue;
    }
    parts.push({
      id,
      name: entity.name,
      color: entity.color,
      tris: entityToTriangles(entity, doc),
    });
  }
  return { parts, skipped2D, unknownIds };
}

/** Flattened `collectExportParts`: every triangle of the selection in one list. */
export function collectExportTriangles(
  doc: CadDocument,
  requestedIds: readonly string[] | undefined,
): { tris: Triangle[]; skipped2D: number; unknownIds: string[] } {
  const { parts, skipped2D, unknownIds } = collectExportParts(doc, requestedIds);
  return { tris: parts.flatMap((part) => part.tris), skipped2D, unknownIds };
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
