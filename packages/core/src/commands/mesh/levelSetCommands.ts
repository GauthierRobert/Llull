/** offset_mesh, hollow_mesh, repair_mesh (mode wrap): level-set mesh operations (07 MSH M2, FR-MSH-07 / 14 / 15). The field mesher is an injected mesh engine (Manifold). */

import { analyzeIndexedMesh } from '../../geometry/mesh/analysis';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { type NamedDefault, namedDefault } from './meshCommon';
import { type Measure, runMeshOp } from './runMeshOp';

/** Vertex tolerance as a fraction of the bounding-box diagonal when the caller gives none (named default, TECHNICAL §5.12). */
const TOLERANCE_FRACTION = 0.002;
/** Level-set grid cells a call may use unless the caller raises it (the spec ceiling is 2e7). */
const DEFAULT_MAX_CELLS = 40_000;
const MAX_CELLS_CEILING = 20_000_000;

const toleranceParam = z
  .number()
  .positive()
  .optional()
  .describe(
    'Target distance (document units) between a result vertex and the exact surface: the level-set grid edge is set to it. When that needs more cells than maxCells the grid is coarsened to fit and the result reports the weaker bound it really has (data.toleranceMet false, data.errorBound). Default 0.002 x bounding-box diagonal (named default).',
  );
const maxCellsParam = z
  .number()
  .int()
  .positive()
  .max(MAX_CELLS_CEILING)
  .optional()
  .describe(
    `Level-set grid cell cap; a finer tolerance than the cap allows refuses with MESH_OFFSET_RESOLUTION. Default ${DEFAULT_MAX_CELLS}.`,
  );
const keepSourceParam = z
  .boolean()
  .optional()
  .describe(
    'true: keep the source and add the result as a new mesh. Default false: the source entity is rewritten in place (same id, name, layer, colour).',
  );

const toleranceOf = (given: number | undefined, positions: ReadonlyArray<number>): number =>
  given ?? TOLERANCE_FRACTION * meshDiagonal(positions);
const defaultsFor = (given: number | undefined, tolerance: number, unit: string): NamedDefault[] =>
  given === undefined ? [namedDefault('tolerance', tolerance, unit, 'llull default 0.002 x bbox diagonal')] : [];
const volumeText = (measure: Measure, unit: string): string =>
  measure.volume === null ? 'open' : `${measure.volume.toPrecision(10)} ${unit}^3`;

/**
 * @affects rewrites the mesh `id` (or adds one mesh with keepSource); the result is world-space, indexed, with no brep
 * @invariant level_set: parallel body, outward corners rounded, inward corners sharp; grid edge = tolerance unless the cell cap forces a coarser one; |dV| <= area x edge (reported as data.errorBound)
 * @failure unknown id / non-solid / zero distance / open mesh (level_set) / grid over maxCells / no Manifold engine -> no-op with a MESH_* code
 */
export const offsetMesh = defineCommand({
  name: 'offset_mesh',
  description:
    'Offset the surface of a mesh (or any 3D solid) by a signed distance: positive grows it, negative shrinks it. method "level_set" (default) ' +
    'builds the parallel body from a signed-distance field: robust on any closed mesh, outward corners become round, inward corners stay sharp, ' +
    'and the result is a clean manifold; it needs a closed mesh and the Manifold engine (desktop app / CLI host). The grid edge is the ' +
    '`tolerance`; a result vertex lies within one edge of the exact offset surface, so the volume is within area x edge (data.errorBound, data.toleranceMet says whether the tolerance itself was reached within maxCells; smooth surfaces are usually far better than the bound). method "normal" moves each ' +
    'vertex along its angle-weighted normal: works on open meshes and anywhere, but may self-intersect for large distances (data.selfIntersectionsCreated). ' +
    'Lengths in document units. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_NOT_CLOSED, MESH_PARAM_INVALID, MESH_OFFSET_RESOLUTION, MESH_ENGINE_UNSUPPORTED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to offset.'),
    distance: z.number().describe('Signed offset in document units: > 0 outward, < 0 inward. Must not be 0.'),
    method: z
      .enum(['level_set', 'normal'])
      .optional()
      .describe('"level_set" (default, closed meshes, needs Manifold) or "normal" (vertex normals, open meshes allowed).'),
    tolerance: toleranceParam,
    maxCells: maxCellsParam,
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, distance, method, tolerance: given, maxCells, keepSource }, ctx): CommandResult => {
    const chosen = method ?? 'level_set';
    return runMeshOp(doc, ctx, {
      command: 'offset_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: chosen === 'level_set',
      precheck: () =>
        distance === 0 || !Number.isFinite(distance)
          ? { code: 'MESH_PARAM_INVALID', message: 'distance must be a non-zero number', path: 'distance' }
          : null,
      op: (loaded) => ({
        op: 'offset',
        method: chosen,
        distance,
        tolerance: toleranceOf(given, loaded.mesh.positions),
        maxCells: maxCells ?? DEFAULT_MAX_CELLS,
      }),
      defaults: (loaded) => defaultsFor(given, toleranceOf(given, loaded.mesh.positions), doc.units),
      fields: (before, after, result) => ({
        method: chosen,
        distance,
        volumeBefore: before.volume,
        volumeAfter: after.volume,
        ...(chosen === 'level_set' ? { errorBound: after.area * (result.report['worstVertexError'] as number) } : {}),
        ...result.report,
      }),
      summary: (from, to, before, after, unit) =>
        `offset_mesh '${from}' by ${distance} ${unit} (${chosen}) -> '${to}': ${after.faces} triangles, volume ${volumeText(before, unit)} -> ${volumeText(after, unit)}.`,
    });
  },
});

/**
 * @affects rewrites the mesh `id` as a hollow shell with a sealed cavity (or adds one mesh with keepSource)
 * @invariant outer surface = the level-set rebuild of the input, cavity = parallel body at -wallThickness; material volume = outer - cavity
 * @failure open mesh -> MESH_NOT_CLOSED; wall >= half the smallest extent -> MESH_PARAM_INVALID; grid over maxCells -> MESH_OFFSET_RESOLUTION
 */
export const hollowMesh = defineCommand({
  name: 'hollow_mesh',
  description:
    'Hollow a closed mesh (or 3D solid) into a shell of constant wall thickness with a sealed internal cavity (print preparation: saves resin / ' +
    'filament). The cavity is the parallel body at -wallThickness from a signed-distance field, so inward corners stay sharp and the cavity is a ' +
    'clean manifold; the outer surface is kept from the input. Reports data.materialVolume and data.cavityVolume (document units^3). Needs the ' +
    'Manifold engine. A sealed cavity traps material in resin printing: add a drain hole before printing (drain holes are a later milestone). ' +
    'Refusals: MESH_NOT_CLOSED, MESH_PARAM_INVALID, MESH_OFFSET_RESOLUTION, MESH_ENGINE_UNSUPPORTED, MESH_BOOLEAN_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the closed mesh (or other 3D solid) to hollow.'),
    wallThickness: z.number().positive().describe('Wall thickness in document units, measured inward from the outer surface.'),
    tolerance: toleranceParam,
    maxCells: maxCellsParam,
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, wallThickness, tolerance: given, maxCells, keepSource }, ctx): CommandResult =>
    runMeshOp(doc, ctx, {
      command: 'hollow_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: true,
      precheck: (loaded) => {
        const diagonal = meshDiagonal(loaded.mesh.positions);
        return wallThickness >= diagonal / 2
          ? {
              code: 'MESH_PARAM_INVALID',
              message: `wallThickness ${wallThickness} is not smaller than half the bounding-box diagonal ${diagonal / 2}`,
              path: 'wallThickness',
            }
          : null;
      },
      op: (loaded) => ({
        op: 'hollow',
        wall: wallThickness,
        tolerance: toleranceOf(given, loaded.mesh.positions),
        maxCells: maxCells ?? DEFAULT_MAX_CELLS,
      }),
      defaults: (loaded) => defaultsFor(given, toleranceOf(given, loaded.mesh.positions), doc.units),
      fields: (before, after, result) => ({
        wallThickness,
        materialVolume: after.volume,
        cavityVolume: before.volume !== null && after.volume !== null ? before.volume - after.volume : null,
        volumeBefore: before.volume,
        ...result.report,
      }),
      summary: (from, to, before, after, unit) =>
        `hollow_mesh '${from}' wall ${wallThickness} ${unit} -> '${to}': material ${volumeText(after, unit)} of ${volumeText(before, unit)}, ${after.faces} triangles.`,
    }),
});

/**
 * @affects rewrites the mesh `id` with a closed manifold envelope of its triangles (or adds one mesh with keepSource)
 * @invariant inner structures, internal faces and sub-tolerance gaps are destroyed (data.innerStructuresDestroyed); the result has 0 crossing triangles
 * @failure unknown id / non-solid / grid over maxCells / no Manifold engine -> no-op with a MESH_* code
 */
export const repairMesh = defineCommand({
  name: 'repair_mesh',
  description:
    'Repair a mesh. mode "wrap" rebuilds a closed, manifold, non-self-intersecting envelope of ANY triangle soup (overlapping bodies, inner ' +
    'shells, open parts, duplicate or inverted faces, holes smaller than the tolerance) from a signed-distance field (generalized winding ' +
    'number for inside / outside), at the stated vertex tolerance. Inner structures are destroyed and the result says so ' +
    '(data.innerStructuresDestroyed). Needs the Manifold engine. Run analyze_mesh / check_mesh purpose=print first to see what is wrong. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_OFFSET_RESOLUTION, MESH_ENGINE_UNSUPPORTED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to repair.'),
    mode: z
      .enum(['wrap'])
      .describe(
        '"wrap": level-set rebuild (the only mode built so far; weld / clean / orient / stitch / close_holes come with the next milestone).',
      ),
    tolerance: toleranceParam,
    maxCells: maxCellsParam,
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, mode, tolerance: given, maxCells, keepSource }, ctx): CommandResult =>
    runMeshOp(doc, ctx, {
      command: 'repair_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      op: (loaded) => ({ op: 'wrap', tolerance: toleranceOf(given, loaded.mesh.positions), maxCells: maxCells ?? DEFAULT_MAX_CELLS }),
      defaults: (loaded) => defaultsFor(given, toleranceOf(given, loaded.mesh.positions), doc.units),
      fields: (before, after, result) => {
        const mesh = result.mesh;
        const crossings =
          mesh !== undefined && mesh.indices.length / 3 <= 100_000
            ? analyzeIndexedMesh(mesh.positions, mesh.indices, { selfIntersections: true, maxListed: 0 }).selfIntersectionPairs
            : null;
        return {
          mode,
          innerStructuresDestroyed: true,
          closedBefore: before.closed,
          volumeBefore: before.volume,
          volumeAfter: after.volume,
          areaBefore: before.area,
          selfIntersectionsAfter: crossings,
          errorBound: after.area * ((result.report['worstVertexError'] as number | undefined) ?? 0),
          ...result.report,
        };
      },
      summary: (from, to, before, after, unit) =>
        `repair_mesh '${from}' mode=wrap -> '${to}': ${after.closed ? 'closed' : 'OPEN'}, ${after.faces} triangles, volume ${volumeText(after, unit)} (input ${before.closed ? 'closed' : 'open'}); inner structures destroyed.`,
    }),
});
