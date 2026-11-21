/**
 * Kernel-result meshes as a derived cache (`kernelSettings.meshStorage: 'recipe'`): files omit the triangles of `mesh` entities that carry a
 * `brep` recipe and the loader re-evaluates the recipe with the kernel it is given.
 * @invariant only top-level `mesh` entities with a `brep` built from primitives are omitted: no `asset` / `meshSource`, and no `{ op: 'brep' }`
 *   leaf (an imported exact solid needs the document blobs inside the kernel, so its triangles stay stored)
 * @invariant an untrusted recipe never reaches the kernel: each listed entity passes the persistence entity check first
 * @invariant a rebuilt mesh must hash to the stored `sha256` (content hashes, PLM release integrity), unless the caller accepts drift
 * @failure no kernel -> KRN_DERIVED_MESH_NO_KERNEL; listed id not a valid kernel-result mesh -> KRN_DERIVED_MESH_INVALID; kernel refuses / empties
 *   / throws -> KRN_DERIVED_MESH_UNBUILT; rebuilt triangles differ from the saved ones -> KRN_DERIVED_MESH_DRIFT (all throw)
 */

import type { CadDocument, Entity, MeshData, ShapeRecipe } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { validateShapeRecipe } from '../../geometry/shapeRecipe';
import { sha256Hex } from '../../lib/sha256';
import { isRecord } from '../../lib/isRecord';
import { evaluateRecipe } from '../kernelShape';
import { validateEntityValue } from './guards';

interface DerivedMeshRecord {
  readonly triangles: number;
  readonly sha256: string;
}

export type DerivedMeshTable = Readonly<Record<string, DerivedMeshRecord>>;

const EMPTY_MESH: MeshData = { positions: [], indices: [] };
const MAX_LEAF_SCAN_DEPTH = 4096;
const LISTED_IDS_IN_MESSAGE = 10;

const meshHash = (mesh: MeshData): string => sha256Hex(JSON.stringify([mesh.positions, mesh.indices]));

/** True when `value` holds an `{ op: 'brep' }` leaf (or nests too deep to tell: treated as holding one, so the triangles stay stored). */
function hasBrepLeaf(value: unknown, depth = 0): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth > MAX_LEAF_SCAN_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => hasBrepLeaf(item, depth + 1));
  if ((value as Record<string, unknown>)['op'] === 'brep') return true;
  return Object.values(value).some((item) => hasBrepLeaf(item, depth + 1));
}

/** True for a kernel-result mesh whose triangles the file may omit (non-empty so a stripped entity is never re-listed). */
function isOmittable(entity: Entity): boolean {
  return (
    entity.kind === 'mesh' &&
    entity.brep !== undefined &&
    entity.asset === undefined &&
    entity.meshSource === undefined &&
    entity.mesh.indices.length > 0 &&
    !hasBrepLeaf(entity.brep)
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

/**
 * The envelope's `derivedMeshes` as a table; null when the envelope has none. Only a version-4 envelope carries one, and it always does.
 * @failure malformed table, a table outside v4, or v4 without one -> throws
 */
export function derivedMeshTableOf(value: unknown, version: unknown): DerivedMeshTable | null {
  if (version !== 4) {
    if (value !== undefined) throw new Error('load_document: derivedMeshes is only valid in a version 4 file.');
    return null;
  }
  const valid =
    isRecord(value) &&
    Object.values(value).every(
      (record) => isRecord(record) && Number.isSafeInteger(record['triangles']) && typeof record['sha256'] === 'string',
    );
  if (!valid) throw new Error('load_document: a version 4 file needs derivedMeshes: an object of entity id -> { triangles, sha256 }.');
  return value as DerivedMeshTable;
}

const listed = (ids: readonly string[]): string =>
  `${ids.slice(0, LISTED_IDS_IN_MESSAGE).join(', ')}${ids.length > LISTED_IDS_IN_MESSAGE ? ', …' : ''}`;

/** The listed entity as a checked kernel-result mesh with an empty mesh, or null (unknown id, not a mesh, bad entity or recipe). */
function checkedEntity(entities: Record<string, unknown>, id: string): Record<string, unknown> | null {
  const entity = Object.hasOwn(entities, id) ? entities[id] : undefined;
  if (!isRecord(entity) || entity['kind'] !== 'mesh' || !isRecord(entity['brep']) || hasBrepLeaf(entity['brep'])) return null;
  if (validateEntityValue(entity) !== null || validateShapeRecipe(entity['brep'], validateEntityValue) !== null) return null;
  return entity;
}

function rebuiltMesh(kernel: GeometryKernel, recipe: ShapeRecipe): MeshData | null {
  try {
    const result = evaluateRecipe(kernel, recipe);
    return typeof result === 'string' ? null : result.mesh;
  } catch {
    return null;
  }
}

interface RebuildOptions {
  readonly kernel: GeometryKernel | null | undefined;
  /** Accept rebuilt triangles that differ from the saved ones (another kernel or kernel build); the document content hash then changes. */
  readonly acceptDrift?: boolean;
}

/** Raw document with every listed entity's mesh re-evaluated from its recipe. */
export function rebuildDerivedMeshes(
  raw: Record<string, unknown>,
  table: DerivedMeshTable,
  options: RebuildOptions,
): Record<string, unknown> {
  const ids = Object.keys(table);
  if (ids.length === 0) return raw;
  const { kernel } = options;
  if (kernel === null || kernel === undefined)
    throw new Error(
      `KRN_DERIVED_MESH_NO_KERNEL: this file omits the triangles of ${ids.length} kernel-result ${ids.length === 1 ? 'mesh' : 'meshes'} ` +
        '(mesh storage "recipe") and no geometry kernel is available to rebuild them — open it in the desktop app or with `llull`.',
    );
  const entities = isRecord(raw['entities']) ? raw['entities'] : {};
  const checked = ids.map((id) => [id, checkedEntity(entities, id)] as const);
  const invalid = checked.filter(([, entity]) => entity === null).map(([id]) => id);
  if (invalid.length > 0)
    throw new Error(
      `KRN_DERIVED_MESH_INVALID: derivedMeshes lists ${listed(invalid)}, which is not a valid kernel-result mesh in this file.`,
    );
  const rebuilt = new Map<string, Record<string, unknown>>();
  const unbuilt: string[] = [];
  const drifted: string[] = [];
  for (const [id, entity] of checked) {
    const mesh = rebuiltMesh(kernel, (entity as Record<string, unknown>)['brep'] as ShapeRecipe);
    if (mesh === null) unbuilt.push(id);
    else {
      if (meshHash(mesh) !== table[id]?.sha256) drifted.push(id);
      rebuilt.set(id, { ...(entity as Record<string, unknown>), mesh });
    }
  }
  if (unbuilt.length > 0)
    throw new Error(
      `KRN_DERIVED_MESH_UNBUILT: the kernel cannot rebuild ${unbuilt.length} omitted mesh${unbuilt.length === 1 ? '' : 'es'} ` +
        `(${listed(unbuilt)}) — open the file with the exact kernel (set LLULL_KERNEL=occt-native or run \`llull --kernel occt-native\`).`,
    );
  if (drifted.length > 0 && options.acceptDrift !== true)
    throw new Error(
      `KRN_DERIVED_MESH_DRIFT: this kernel rebuilds ${drifted.length} omitted mesh${drifted.length === 1 ? '' : 'es'} (${listed(drifted)}) ` +
        'with different triangles than the saved ones, which would change the document content hash (released revisions) — open it with the ' +
        'kernel that saved it (kernelSettings.kernel), or load it with acceptMeshDrift: true to take the new triangles.',
    );
  return { ...raw, entities: { ...entities, ...Object.fromEntries(rebuilt) } };
}
