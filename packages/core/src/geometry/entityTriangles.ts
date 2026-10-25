import { type CadDocument, type Entity, is3D } from '../model/types';
import type { MeshAssetPort } from './mesh/assets';
import { isSheet } from '../model/curveKinds';
import { sheetTriangles } from './nurbsSurface';
import { expandInstance } from './instanceExpansion';
import { solidTriangles } from './solidTriangles';
import type { Triangle } from './triangles';
import { isZeroRotation } from '../lib/eulerRotation';
import type { Vec3 } from '../model/vectors';

/** World-space triangles of one entity; instances are expanded through their component (`doc`). 2D shapes return []. */
export function entityToTriangles(e: Entity, doc: Pick<CadDocument, 'components'>): Triangle[] {
  if (e.kind === 'instance') {
    const component = doc.components[e.componentId];
    if (!component) return [];
    return expandInstance(e, component).flatMap((child) => entityToTriangles(child, doc));
  }
  if (isSheet(e)) return sheetTriangles(e);
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
  /** World-space triangles, built on first read (a multi-million-triangle body costs gigabytes as `Triangle` objects, so exports that do not need them never read it). */
  readonly tris: Triangle[];
  /** Number of triangles, known without building them for an indexed mesh. */
  readonly triangleCount: number;
  /** A mesh entity without rotation: its indexed arrays and the offset to world space, for writers that stream instead of reading `tris`. */
  readonly indexed?: { readonly positions: ReadonlyArray<number>; readonly indices: ReadonlyArray<number>; readonly offset: Vec3 };
}

/** The indexed arrays of a rotation-free mesh entity (its vertices plus `position` are world space), else undefined. */
function indexedOf(entity: Entity, mesh: { positions: ReadonlyArray<number>; indices: ReadonlyArray<number> }): ExportPart['indexed'] {
  if (entity.kind !== 'mesh' || !isZeroRotation(entity.rotation) || mesh.indices.length === 0) return undefined;
  return { positions: mesh.positions, indices: mesh.indices, offset: entity.position };
}

/** A part whose triangles are built by `make` on first read (`count`: their number when known beforehand). */
function lazyPart(id: string, entity: Entity, make: () => Triangle[], count?: number, indexed?: ExportPart['indexed']): ExportPart {
  let built: Triangle[] | undefined;
  return {
    ...(indexed === undefined ? {} : { indexed }),
    id,
    name: entity.name,
    color: entity.color,
    get tris(): Triangle[] {
      built ??= make();
      return built;
    },
    get triangleCount(): number {
      return count ?? this.tris.length;
    },
  };
}

/**
 * The exportable 3D entities named by `requestedIds` (all of `doc.order` when undefined/empty), each with its world-space triangles.
 * Unknown ids are reported, 2D entities are counted and skipped. An asset-backed mesh exports at full resolution (07 MSH FR-MSH-27); one
 * whose asset cannot be read is listed in `unreadable` (with its code) and contributes no triangle.
 */
export function collectExportParts(
  doc: CadDocument,
  requestedIds: readonly string[] | undefined,
  assets?: MeshAssetPort | null,
): { parts: ExportPart[]; skipped2D: number; unknownIds: string[]; unreadable: Array<{ id: string; code: string }> } {
  const unreadable: Array<{ id: string; code: string }> = [];
  const unknownIds: string[] = [];
  let idsToProcess: readonly string[] = doc.order;
  if (requestedIds && requestedIds.length > 0)
    idsToProcess = requestedIds.filter((id) => {
      const known = doc.entities[id] !== undefined;
      if (!known) unknownIds.push(id);
      return known;
    });
  const parts: ExportPart[] = [];
  let skipped2D = 0;
  for (const id of idsToProcess) {
    const entity = doc.entities[id];
    if (!entity) continue;
    if (!is3D(entity) && !isSheet(entity)) {
      skipped2D++;
      continue;
    }
    if (entity.kind === 'mesh' && entity.asset !== undefined) {
      const full = assets?.readMesh(entity.asset.key) ?? null;
      if (full === null) {
        unreadable.push({ id, code: assets === undefined || assets === null ? 'MESH_ASSET_UNAVAILABLE' : 'MESH_ASSET_MISSING' });
        continue;
      }
      parts.push(
        lazyPart(
          id,
          entity,
          () => entityToTriangles({ ...entity, mesh: full }, doc),
          full.indices.length > 0 ? full.indices.length / 3 : Math.floor(full.positions.length / 9),
          indexedOf(entity, full),
        ),
      );
      continue;
    }
    parts.push(
      lazyPart(
        id,
        entity,
        () => entityToTriangles(entity, doc),
        undefined,
        entity.kind === 'mesh' ? indexedOf(entity, entity.mesh) : undefined,
      ),
    );
  }
  return { parts, skipped2D, unknownIds, unreadable };
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
  const parts = [`${command}: ${tris.length} triangle${tris.length !== 1 ? 's' : ''} exported (format=${format}).`];
  if (skipped2D > 0) parts.push(`${skipped2D} non-solid entit${skipped2D !== 1 ? 'ies' : 'y'} (2D shapes, 3D curves) skipped.`);
  if (unknownIds.length > 0) parts.push(`Unknown ids skipped: ${unknownIds.join(', ')}.`);
  return parts.join(' ');
}

/** `doc` with every asset-backed mesh among `ids` carrying its full-resolution triangles instead of the display LOD (an unreadable one is left as is). */
export function withFullResolution(doc: CadDocument, ids: readonly string[], assets: MeshAssetPort | null | undefined): CadDocument {
  let entities = doc.entities;
  for (const id of ids) {
    const entity = doc.entities[id];
    if (entity?.kind !== 'mesh' || entity.asset === undefined) continue;
    const full = assets?.readMesh(entity.asset.key) ?? null;
    if (full !== null) entities = { ...entities, [id]: { ...entity, mesh: full } };
  }
  return entities === doc.entities ? doc : { ...doc, entities };
}
