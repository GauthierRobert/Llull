/** Shared plumbing of the mesh commands (07 MSH): entity -> welded world mesh, coded refusals, result entities, the `data` conventions (units, unverified, provenance, defaults). */

import { DEFAULT_LAYER_ID, type CadDocument, type Entity, type MeshData, type MeshSolidEntity, is3D } from '../../model/types';
import { entityToTriangles } from '../../geometry/entityTriangles';
import { analyzeIndexedMesh } from '../../geometry/mesh/analysis';
import type { MeshEngineFailure, MeshOpResult, MeshProvenance } from '../../geometry/mesh/engineTypes';
import { meshDiagonal, weldMesh } from '../../geometry/mesh/weld';
import { orientOutward } from '../../geometry/meshVolume';
import { nextId } from '../../lib/id';
import { referenceLossSuffix, withEntity, withoutEntities } from '../entity/entityOps';
import { currentContext } from '../context';
import { tableRejection } from '../noop';
import type { CommandResult, ExecutionContext } from '../types';
import { DEFAULT_MESH_COLOR } from '../exchange/importMesh';

/** Remediation text per stable code (07 MSH TECHNICAL §7.1). */
export const MESH_REMEDIATION: Readonly<Record<string, string>> = {
  MESH_ENTITY_NOT_FOUND: 'Run `llull describe_scene` to list entity ids.',
  MESH_NOT_A_MESH: 'Pass a 3D solid or mesh id; 2D shapes, curves and sheets have no triangles to model.',
  MESH_NOT_CLOSED: 'Close the mesh first (analyze_mesh lists the boundary loops), or run repair_mesh mode=wrap.',
  MESH_NON_MANIFOLD: 'Edges with more than two faces: repair the mesh, or run repair_mesh mode=wrap.',
  MESH_PARAM_INVALID: 'Fix the named parameter; see `llull describe <command>`.',
  MESH_IMPORT_UNITS_REQUIRED: 'Give units (mm, cm, m, in or ft): STL, OBJ and PLY files carry no unit.',
  MESH_IMPORT_FORMAT_UNKNOWN: 'Pass format (stl, obj, ply or 3mf) or fix the file.',
  MESH_IMPORT_PARSE: 'Fix the file at the reported line or byte offset.',
  MESH_IMPORT_EMPTY: 'The file holds no triangles; check that it is the right file.',
  MESH_IMPORT_SHA_MISMATCH: 'The file is not the one pinned: re-export it, or pass the sha256 of the file you intend to use.',
  MESH_IMPORT_TOO_LARGE: 'Split the file, or decimate it before import (the asset store is a later milestone).',
  MESH_ENGINE_UNSUPPORTED: 'Run in the desktop app or the `llull` CLI host, which install the Manifold mesh engine.',
  MESH_ENGINE_CAP_EXCEEDED:
    'The input is above the TypeScript engine cap: use a host with the Manifold or native engine, or reduce the mesh.',
  MESH_OFFSET_RESOLUTION: 'Raise tolerance (or maxCells): the level-set grid would exceed the cell cap.',
  MESH_HULL_DEGENERATE: 'Give at least 4 points that are not coplanar.',
  MESH_BOOLEAN_FAILED: 'Run check_mesh purpose=boolean on the operands.',
};

export const meshRejection = tableRejection(MESH_REMEDIATION);

/** Triangles above which a mesh command refuses (the same cap as import). */
export const MESH_TRIANGLE_LIMIT = 2_000_000;

export interface SolidMesh {
  readonly entity: Entity;
  /** Welded, indexed, world-space triangles. */
  readonly mesh: MeshData;
  /** True when the triangles come from an unpinned import (07 MSH FR-MSH-32). */
  readonly unverified: boolean;
  readonly weldTolerance: number;
  readonly weldDefaulted: boolean;
}

export interface LoadFailure {
  readonly code: string;
  readonly message: string;
  readonly ids: string[];
}

/** An imported mesh without a pinned source (or with an unverified one) is `unverified`; everything else is exact or derived from exact input. */
export function isUnverified(entity: Entity): boolean {
  if (entity.kind !== 'mesh') return false;
  return entity.meshSource !== undefined ? !entity.meshSource.verified : entity.brep === undefined;
}

/** Default weld tolerance: 1e-6 x bounding-box diagonal (named default, TECHNICAL §5.12). */
export const WELD_TOLERANCE_FRACTION = 1e-6;

/**
 * Welded world-space triangles of any 3D solid.
 * @failure unknown id / 2D, curve, sheet or empty entity -> LoadFailure
 */
export function loadSolidMesh(doc: CadDocument, id: string, weldTolerance?: number): SolidMesh | LoadFailure {
  const entity = doc.entities[id];
  if (entity === undefined) return { code: 'MESH_ENTITY_NOT_FOUND', message: `entity '${id}' not found`, ids: [id] };
  if (!is3D(entity) || entity.kind === 'instance') {
    return { code: 'MESH_NOT_A_MESH', message: `entity '${id}' (${entity.kind}) is not a 3D solid with triangles`, ids: [id] };
  }
  const positions = entityToTriangles(entity, doc).flatMap((triangle) => triangle.flat());
  if (positions.length === 0) return { code: 'MESH_NOT_A_MESH', message: `entity '${id}' (${entity.kind}) has no triangles`, ids: [id] };
  const soup = { positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
  const tolerance = weldTolerance ?? WELD_TOLERANCE_FRACTION * meshDiagonal(positions);
  const welded = weldMesh(soup, tolerance);
  return {
    entity,
    mesh: { positions: welded.positions, indices: welded.triangles },
    unverified: isUnverified(entity),
    weldTolerance: tolerance,
    weldDefaulted: weldTolerance === undefined,
  };
}

export const isLoadFailure = (value: SolidMesh | LoadFailure): value is LoadFailure => 'code' in value;

/** Area, volume (outward-wound closed meshes) and closedness of an indexed mesh. */
export function measureMesh(mesh: MeshData): { area: number; volume: number | null; closed: boolean; faces: number; vertices: number } {
  const analysis = analyzeIndexedMesh(mesh.positions, mesh.indices, { selfIntersections: false, maxListed: 0 });
  return { area: analysis.area, volume: analysis.volume, closed: analysis.closed, faces: analysis.faces, vertices: analysis.vertices };
}

/** The mesh with outward winding (all triangles flipped when it is inside-out). */
export function outwardMesh(mesh: MeshData): MeshData {
  return { positions: mesh.positions, indices: orientOutward(mesh.positions, mesh.indices) };
}

export interface NamedDefault {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly defaulted: true;
}

export const namedDefault = (name: string, value: number, unit: string, source: string): NamedDefault => ({
  name,
  value,
  unit,
  source,
  defaulted: true,
});

/** The `data` every mesh command returns around its own fields: units on every number, unverified flag, provenance and the defaults used. */
export function withConventions(
  doc: CadDocument,
  fields: Record<string, unknown>,
  context: { unverified: boolean; provenance?: MeshProvenance; defaults?: ReadonlyArray<NamedDefault>; inputSha256?: string },
): Record<string, unknown> {
  return {
    ...fields,
    unit: doc.units,
    areaUnit: `${doc.units}^2`,
    volumeUnit: `${doc.units}^3`,
    unverified: context.unverified,
    ...(context.provenance !== undefined
      ? { provenance: { ...context.provenance, ...(context.inputSha256 !== undefined ? { inputSha256: context.inputSha256 } : {}) } }
      : {}),
    defaults: context.defaults ?? [],
  };
}

/** The context a command runs in (its own `ctx` or the process defaults). */
export const contextOf = (ctx: ExecutionContext | undefined): ExecutionContext => ctx ?? currentContext();

/** A new world-space mesh entity (id `mesh-<step>.<k>`); `unverified` keeps the provenance flag of its inputs. */
export function newMeshEntity(mesh: MeshData, options: { unverified: boolean; color?: string; layerId?: string }): MeshSolidEntity {
  return {
    id: nextId('mesh'),
    kind: 'mesh',
    mesh,
    meshSource: { format: 'generated', unitScale: 1, verified: !options.unverified },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: options.layerId ?? DEFAULT_LAYER_ID,
    color: options.color !== undefined && options.color !== '' ? options.color : DEFAULT_MESH_COLOR,
  };
}

/** Append a new mesh entity (see `newMeshEntity`). */
export function addMeshEntity(
  doc: CadDocument,
  mesh: MeshData,
  options: { unverified: boolean; color?: string; layerId?: string },
): { document: CadDocument; id: string } {
  const entity = newMeshEntity(mesh, options);
  return { document: withEntity(doc, entity), id: entity.id };
}

/**
 * Put `mesh` in the document: `keepSource` false rewrites `source` in place (same id, order slot and base fields: layer, colour, name, tags,
 * material, pattern seed; decals only while the source sat at the identity transform; it becomes a `mesh` entity), true appends a new
 * entity and keeps the source.
 * @invariant results are world-space (position and rotation zero), indexed, and carry a `meshSource` that stays unverified when the input was
 */
export function commitMesh(
  doc: CadDocument,
  source: Entity,
  mesh: MeshData,
  options: { keepSource: boolean; unverified: boolean },
): { document: CadDocument; id: string } {
  if (options.keepSource) return addMeshEntity(doc, mesh, { unverified: options.unverified, color: source.color, layerId: source.layerId });
  const placed = source.position.some((v) => v !== 0) || source.rotation.some((v) => v !== 0);
  const entity: MeshSolidEntity = {
    id: source.id,
    kind: 'mesh',
    mesh,
    meshSource: { format: 'generated', unitScale: 1, verified: !options.unverified },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: source.layerId,
    color: source.color,
    ...(source.name !== undefined ? { name: source.name } : {}),
    ...(source.tags !== undefined ? { tags: source.tags } : {}),
    ...(source.materialId !== undefined ? { materialId: source.materialId } : {}),
    ...(source.patternSourceId !== undefined ? { patternSourceId: source.patternSourceId } : {}),
    ...(source.decals !== undefined && !placed ? { decals: source.decals } : {}),
  };
  return { document: { ...doc, entities: { ...doc.entities, [source.id]: entity } }, id: source.id };
}

/** `doc` without the `removed` entities (selection, groups, constraints, joints and seeds follow) plus `entity` appended; the summary suffix names dropped references. */
export function replaceWith(doc: CadDocument, removed: ReadonlySet<string>, entity: Entity): { document: CadDocument; suffix: string } {
  const document = withEntity(withoutEntities(doc, removed).document, entity);
  return { document, suffix: referenceLossSuffix(doc, document) };
}

/** Unwrap an engine answer, or the coded refusal of `command`. */
export function engineOutcome(
  doc: CadDocument,
  command: string,
  outcome: MeshOpResult | MeshEngineFailure,
  ids: readonly string[] = [],
): MeshOpResult | CommandResult {
  if ('code' in outcome) return meshRejection(doc, command, outcome.code, outcome.message, ids);
  return outcome;
}

export const isCommandResult = (value: MeshOpResult | CommandResult): value is CommandResult => 'document' in value;
