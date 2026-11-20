/**
 * Kernel-result meshes as a derived cache (`kernelSettings.meshStorage: 'recipe'`): files omit the triangles of `mesh` entities that carry a
 * `brep` recipe and the loader re-evaluates the recipe with the kernel it is given.
 * @invariant only top-level `mesh` entities with `brep` and without `asset` / `meshSource` are omitted (imported or pinned triangles are the truth)
 * @failure no kernel -> KRN_DERIVED_MESH_NO_KERNEL; kernel refuses / empties / throws on a recipe -> KRN_DERIVED_MESH_UNBUILT (both throw)
 */

import type { CadDocument, Entity, MeshData, ShapeRecipe } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { sha256Hex } from '../../lib/sha256';
import { isRecord } from '../../lib/isRecord';
import { evaluateRecipe } from '../kernelShape';

export interface DerivedMeshRecord {
  readonly triangles: number;
  readonly sha256: string;
}

export type DerivedMeshTable = Readonly<Record<string, DerivedMeshRecord>>;

const EMPTY_MESH: MeshData = { positions: [], indices: [] };

export const meshHash = (mesh: MeshData): string => sha256Hex(JSON.stringify([mesh.positions, mesh.indices]));

/** True for a kernel-result mesh whose triangles the file may omit (non-empty so a stripped entity is never re-listed). */
function isOmittable(entity: Entity): boolean {
  return (
    entity.kind === 'mesh' &&
    entity.brep !== undefined &&
    entity.asset === undefined &&
    entity.meshSource === undefined &&
    entity.mesh.indices.length > 0
  );
}

export function omittableMeshCount(doc: CadDocument): number {
  return Object.values(doc.entities).filter(isOmittable).length;
}

/** `doc` with the omittable meshes emptied, and the table the loader needs (null when nothing was omitted). */
export function withoutDerivedMeshes(doc: CadDocument): { document: CadDocument; table: DerivedMeshTable | null } {
  const table: Record<string, DerivedMeshRecord> = {};
  const entries = Object.entries(doc.entities).map(([id, entity]): [string, Entity] => {
    if (entity.kind !== 'mesh' || !isOmittable(entity)) return [id, entity];
    table[id] = { triangles: entity.mesh.indices.length / 3, sha256: meshHash(entity.mesh) };
    return [id, { ...entity, mesh: EMPTY_MESH }];
  });
  if (Object.keys(table).length === 0) return { document: doc, table: null };
  return { document: { ...doc, entities: Object.fromEntries(entries) }, table };
}

/** The envelope's `derivedMeshes` as a table, or an error text when malformed; undefined -> null (nothing omitted). */
export function derivedMeshTableOf(value: unknown): DerivedMeshTable | null {
  if (value === undefined) return null;
  const valid =
    isRecord(value) &&
    Object.values(value).every(
      (record) => isRecord(record) && typeof record['triangles'] === 'number' && typeof record['sha256'] === 'string',
    );
  if (!valid) throw new Error('load_document: derivedMeshes must be an object of entity id -> { triangles, sha256 }.');
  return value as DerivedMeshTable;
}

function rebuiltMesh(kernel: GeometryKernel, entity: unknown): MeshData | null {
  if (!isRecord(entity) || entity['kind'] !== 'mesh' || !isRecord(entity['brep'])) return null;
  try {
    const result = evaluateRecipe(kernel, entity['brep'] as unknown as ShapeRecipe);
    return typeof result === 'string' ? null : result.mesh;
  } catch {
    return null;
  }
}

/** Raw document with every listed entity's mesh re-evaluated from its recipe (a different hash than stored is accepted: the recipe is the truth). */
export function rebuildDerivedMeshes(
  raw: Record<string, unknown>,
  table: DerivedMeshTable,
  kernel: GeometryKernel | null | undefined,
): Record<string, unknown> {
  const ids = Object.keys(table);
  if (ids.length === 0) return raw;
  if (kernel === null || kernel === undefined)
    throw new Error(
      `KRN_DERIVED_MESH_NO_KERNEL: this file omits the triangles of ${ids.length} kernel-result ${ids.length === 1 ? 'mesh' : 'meshes'} ` +
        '(mesh storage "recipe") and no geometry kernel is available to rebuild them — open it in the desktop app or with `llull`.',
    );
  const entities = isRecord(raw['entities']) ? raw['entities'] : {};
  const rebuilt: Record<string, unknown> = {};
  const unbuilt: string[] = [];
  for (const id of ids) {
    const entity = entities[id];
    const mesh = rebuiltMesh(kernel, entity);
    if (mesh === null) unbuilt.push(id);
    else rebuilt[id] = { ...(entity as Record<string, unknown>), mesh };
  }
  if (unbuilt.length > 0)
    throw new Error(
      `KRN_DERIVED_MESH_UNBUILT: the kernel cannot rebuild ${unbuilt.length} omitted mesh${unbuilt.length === 1 ? '' : 'es'} ` +
        `(${unbuilt.slice(0, 10).join(', ')}${unbuilt.length > 10 ? ', …' : ''}) — open the file with the exact kernel ` +
        '(set LLULL_KERNEL=occt-native or run `llull --kernel occt-native`).',
    );
  return { ...raw, entities: { ...entities, ...rebuilt } };
}
