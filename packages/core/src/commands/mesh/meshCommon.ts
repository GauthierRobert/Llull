/** Shared plumbing of the mesh commands (07 MSH): entity -> welded world mesh, coded refusals, result entities, the `data` conventions (units, unverified, provenance, defaults). */

import {
  DEFAULT_LAYER_ID,
  type CadDocument,
  type Entity,
  type MeshData,
  type MeshSolidEntity,
  type ShapeRecipe,
  is3D,
} from '../../model/types';
import { entityToTriangles } from '../../geometry/entityTriangles';
import { type MeshAssetPort, MESH_INLINE_TRIANGLE_CAP, MESH_LOD_TRIANGLES, placeMesh } from '../../geometry/mesh/assets';
import { fastMeasure } from '../../geometry/mesh/fastMeasure';
import { lodMesh } from '../../geometry/mesh/lod';
import type { MeshAssetRef } from '../../model/meshProvenance';
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
  MESH_IMPORT_TOO_LARGE:
    'Import it through a host with the mesh asset store (llull mesh import FILE, then import_mesh_file fileKey), or split / decimate the file.',
  MESH_ASSET_MISSING: 'This machine does not hold the asset: re-import the source file (its sha256 is in meshSource).',
  MESH_ASSET_UNAVAILABLE:
    'No mesh asset store is installed here (run through the llull CLI or the desktop backend), or reduce the mesh below the inline cap.',
  MESH_ENGINE_UNSUPPORTED:
    'Run in the desktop app or the `llull` CLI host, which install the Manifold mesh engine and the native llull-compute (quad_remesh needs the native one).',
  MESH_ENGINE_CAP_EXCEEDED:
    'The input is above the engine cap (TypeScript 200 000 triangles; native: remesh_mesh 2 000 000, quad_remesh 500 000; the self-intersection search of analyze_mesh stays at 200 000, pass selfIntersections false above it): use a host with the native engine for the first, decimate_mesh the input for the others.',
  MESH_TIMEOUT:
    'Raise LLULL_MESH_OP_TIMEOUT_S, ask for less (a lower targetQuadCount: the time grows faster than linearly), or decimate_mesh the input first.',
  MESH_OFFSET_RESOLUTION: 'Raise tolerance (or maxCells): the level-set grid would exceed the cell cap.',
  MESH_HULL_DEGENERATE: 'Give at least 4 points that are not coplanar.',
  MESH_BOOLEAN_FAILED: 'Run check_mesh purpose=boolean on the operands.',
  MESH_ORIENTATION_INCONSISTENT: 'Faces disagree on winding: run repair_mesh mode=orient first.',
  MESH_DEGENERATE: 'The mesh has degenerate faces: run repair_mesh mode=clean first.',
  MESH_HOLE_NOT_FOUND: 'Run analyze_mesh to list the boundary loops (0-based), or pass holes "all".',
  MESH_HOLE_TOO_LARGE: 'Raise maxBoundaryEdges, or use repair_mesh mode=wrap.',
  MESH_HOLE_NON_SIMPLE: 'The loop touches itself: run repair_mesh mode=stitch, then fill again.',
  MESH_HOLE_NO_TRIANGULATION: 'No valid triangulation of the loop exists: split it with repair_mesh mode=stitch, or use mode=wrap.',
  MESH_TARGET_UNREACHABLE: 'Raise maxDeviation, lower the target, or set preserveBoundary false.',
  MESH_REMESH_EDGE_TOO_LARGE: 'Lower the target edge length (at most 0.25 x the bounding-box diagonal).',
  MESH_REMESH_RESULT_TOO_LARGE:
    'The target edge is so short that the remeshed surface passes 4 000 000 triangles: raise targetEdgeLength (or minEdge), or remesh a region.',
  MESH_BREP_SEW_FAILED: 'Use mode=faceted, repair_mesh first, or raise fitTolerance.',
  MESH_SCULPT_STAMP_OFF_SURFACE: 'Move the stamp centre within `radius` of the surface (analyze_mesh gives the bounds), or raise radius.',
  MESH_DISPLACE_FIELD:
    'Fix the expression (names: x, y, z, nx, ny, nz; no division by something that is 0 at a vertex), or give a heightMap whose pixels are width x height bytes.',
  MESH_DISPLACE_RESULT_TOO_LARGE:
    'The refineEdge is so short that the surface passes 4 000 000 triangles: raise refineEdge, or displace a coarser mesh.',
  MESH_SEGMENT_NO_GROUPS: 'The mesh has no face to segment: check it with analyze_mesh.',
  MESH_KERNEL_UNSUPPORTED: 'Run on the native OCC kernel (the llull CLI / desktop app default); Manifold has no exact B-rep builder.',
  MESH_QUAD_REMESH_FAILED:
    'Run remesh_mesh first for an even triangulation, raise targetQuadCount (very few quads on a detailed surface), or repair_mesh the input.',
  MESH_FIT_SYMMETRY: 'Clear the cage symmetry first (set_cage_symmetry planes []): a fit moves the vertices independently.',
  MESH_FIT_CAGE_INVALID: 'Repair the cage (check_subdivision lists the problem), then fit again.',
  MESH_FIT_TOO_LARGE:
    'fit_subdivision_to_mesh: lower levels, use a coarser cage, or decimate_mesh the target (at most 120000 limit samples and 500000 target triangles). fit_surface_to_mesh: pick a smaller region or decimate_mesh first (at most 200000 region triangles).',
  MESH_FIT_FOLDED:
    'Warning: part of the limit surface faces against the target. Undo the fit, repair the cage (check_subdivision), or fit a cage that is already on the outside of the target.',
  MESH_FIT_SOLVER_RESIDUAL: 'Warning: the linear solve stopped at its iteration cap. Raise smoothing, or fit again from the result.',
  MESH_FIT_PIN_SHARED:
    'Warning: the target is coarser than the cage, so several cage vertices were pinned to the same target vertex. Use the least-squares fit (interpolate off) or a coarser cage.',
  MESH_FIT_PIN_RESIDUAL: 'Warning: a pinned limit point misses its vertex. Fit again, or use the least-squares fit instead of interpolate.',
  MESH_FIT_FAILED: 'Raise smoothing, check the cage and the target with check_subdivision / analyze_mesh, or fit a coarser cage first.',
  MESH_FIT_CAGE_FAR:
    'Move and scale the cage onto the target first (edit_subdivision_cage), or make the cage from the target with quad_remesh.',
  MESH_FIT_NOT_CONVERGED: 'Raise iterations or maxDeviation, add cage detail (quad_remesh with more quads), or lower smoothing.',
  MESH_FIT_REGION_EMPTY: 'Move or enlarge the region sphere so that it holds triangle centres, or omit region.',
  MESH_FIT_NOT_PROJECTABLE:
    'Pick a smaller region that looks like a height field over one plane (a gently curved patch), or split the mesh with segment_mesh first.',
  MESH_FIT_TOO_FEW_SAMPLES: 'Give fewer controlPoints, a larger region, or refine the mesh (subdivide_mesh).',
  MESH_CUT_MISSES: 'Move the plane so that the mesh has vertices on both sides.',
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
export function loadSolidMesh(
  doc: CadDocument,
  id: string,
  weldTolerance?: number,
  assets?: MeshAssetPort | null,
): SolidMesh | LoadFailure {
  const entity = doc.entities[id];
  if (entity === undefined) return { code: 'MESH_ENTITY_NOT_FOUND', message: `entity '${id}' not found`, ids: [id] };
  if (!is3D(entity) || entity.kind === 'instance') {
    return { code: 'MESH_NOT_A_MESH', message: `entity '${id}' (${entity.kind}) is not a 3D solid with triangles`, ids: [id] };
  }
  if (entity.kind === 'mesh' && entity.asset !== undefined) {
    if (assets === undefined || assets === null)
      return {
        code: 'MESH_ASSET_UNAVAILABLE',
        message: `entity '${id}' is backed by mesh asset ${entity.asset.key.slice(0, 12)}... but no asset store is installed`,
        ids: [id],
      };
    const full = assets.readMesh(entity.asset.key);
    if (full === null)
      return {
        code: 'MESH_ASSET_MISSING',
        message: `mesh asset ${entity.asset.key} of entity '${id}' is not in this machine's store`,
        ids: [id],
      };
    const placedRaw = placeMesh(full, entity.position, entity.rotation);
    const welded =
      weldTolerance === undefined ? null : weldMesh({ positions: placedRaw.positions, indices: placedRaw.indices }, weldTolerance);
    const placed = welded === null ? placedRaw : { positions: welded.positions, indices: welded.triangles };
    return {
      entity,
      mesh: placed,
      unverified: isUnverified(entity),
      weldTolerance: weldTolerance ?? WELD_TOLERANCE_FRACTION * meshDiagonal(placed.positions),
      weldDefaulted: weldTolerance === undefined,
    };
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

/** Triangles above which `measureMesh` uses the typed-array measure instead of the full analysis. */
const FAST_MEASURE_TRIANGLES = 50_000;

/** Area, volume (outward-wound closed meshes) and closedness of an indexed mesh. */
export function measureMesh(mesh: MeshData): { area: number; volume: number | null; closed: boolean; faces: number; vertices: number } {
  if (mesh.indices.length / 3 > FAST_MEASURE_TRIANGLES) return fastMeasure(mesh);
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

export interface StoredMesh {
  /** Inline triangles: the whole mesh, or the display level of detail of an asset-backed one. */
  readonly mesh: MeshData;
  readonly asset?: MeshAssetRef;
  /** Exact construction tree of a kernel result (mesh_to_brep); absent on plain meshes. */
  readonly brep?: ShapeRecipe;
}

/**
 * Where a result mesh lives: inline up to MESH_INLINE_TRIANGLE_CAP, else in the asset store with a display LOD.
 * @failure above the cap without a store -> MESH_ASSET_UNAVAILABLE
 */
export function storeMesh(mesh: MeshData, assets: MeshAssetPort | null | undefined): StoredMesh | LoadFailure {
  const triangles = mesh.indices.length / 3;
  if (triangles <= MESH_INLINE_TRIANGLE_CAP) return { mesh };
  if (assets === undefined || assets === null)
    return {
      code: 'MESH_ASSET_UNAVAILABLE',
      message: `the result has ${triangles} triangles (inline cap ${MESH_INLINE_TRIANGLE_CAP}) and no mesh asset store is installed`,
      ids: [],
    };
  return { mesh: lodMesh(mesh, MESH_LOD_TRIANGLES), asset: assets.writeMesh(mesh) };
}

export const isStoreFailure = (value: StoredMesh | LoadFailure): value is LoadFailure => 'code' in value;

/** A new world-space mesh entity (id `mesh-<step>.<k>`); `unverified` keeps the provenance flag of its inputs. */
export function newMeshEntity(stored: StoredMesh, options: { unverified: boolean; color?: string; layerId?: string }): MeshSolidEntity {
  return {
    id: nextId('mesh'),
    kind: 'mesh',
    mesh: stored.mesh,
    ...(stored.asset !== undefined ? { asset: stored.asset } : {}),
    ...(stored.brep !== undefined ? { brep: stored.brep } : {}),
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
  stored: StoredMesh,
  options: { unverified: boolean; color?: string; layerId?: string },
): { document: CadDocument; id: string } {
  const entity = newMeshEntity(stored, options);
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
  stored: StoredMesh,
  options: { keepSource: boolean; unverified: boolean },
): { document: CadDocument; id: string } {
  if (options.keepSource)
    return addMeshEntity(doc, stored, { unverified: options.unverified, color: source.color, layerId: source.layerId });
  const placed = source.position.some((v) => v !== 0) || source.rotation.some((v) => v !== 0);
  const entity: MeshSolidEntity = {
    id: source.id,
    kind: 'mesh',
    mesh: stored.mesh,
    ...(stored.asset !== undefined ? { asset: stored.asset } : {}),
    ...(stored.brep !== undefined ? { brep: stored.brep } : {}),
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

/** Refusal of an export that reaches an asset-backed mesh whose full-resolution asset cannot be read (never the LOD), or null. */
export function exportAssetRefusal(
  doc: CadDocument,
  command: string,
  unreadable: ReadonlyArray<{ id: string; code: string }>,
): CommandResult | null {
  const first = unreadable[0];
  if (first === undefined) return null;
  return meshRejection(
    doc,
    command,
    first.code,
    `the full-resolution mesh asset of ${unreadable.map((u) => `'${u.id}'`).join(', ')} cannot be read (an export never writes the display level of detail)`,
    unreadable.map((u) => u.id),
  );
}
