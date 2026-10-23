/** offset_mesh, hollow_mesh and the wrap rebuild of repair_mesh: level-set mesh operations (07 MSH M2, FR-MSH-07 / 14 / 15). The field mesher is an injected mesh engine (Manifold). */

import { analyzeIndexedMesh } from '../../geometry/mesh/analysis';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { type DrainTool, drainTool } from '../../geometry/mesh/drainHole';
import type { MeshEngineFailure, MeshOpResult } from '../../geometry/mesh/engineTypes';
import { SurfaceIndex } from '../../geometry/mesh/surfaceIndex';
import { defineCommand, vec3, z } from '../schema';
import type { CadDocument } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { type NamedDefault, namedDefault } from './meshCommon';
import { type Measure, runMeshOp } from './runMeshOp';

/** Vertex tolerance as a fraction of the bounding-box diagonal when the caller gives none (named default, TECHNICAL §5.12). */
const TOLERANCE_FRACTION = 0.002;
/** Level-set grid cells a call may use unless the caller raises it (the spec ceiling is 2e7). */
export const DEFAULT_MAX_CELLS = 40_000;
const MAX_CELLS_CEILING = 20_000_000;

export const toleranceParam = z
  .number()
  .positive()
  .optional()
  .describe(
    'Target distance (document units) between a result vertex and the exact surface: the level-set grid edge is set to it. When that needs more cells than maxCells the grid is coarsened to fit and the result reports the weaker bound it really has (data.toleranceMet false, data.errorBound). Default 0.002 x bounding-box diagonal (named default).',
  );
export const maxCellsParam = z
  .number()
  .int()
  .positive()
  .max(MAX_CELLS_CEILING)
  .optional()
  .describe(
    `Level-set grid cell cap; a finer tolerance than the cap allows refuses with MESH_OFFSET_RESOLUTION. Default ${DEFAULT_MAX_CELLS}.`,
  );
export const keepSourceParam = z
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
    'Manifold engine. A sealed cavity traps material in resin printing: give `drainHoles` ({near, diameter}): each is a cylinder 3 x the wall long along the outward surface normal at the surface point nearest to `near`, subtracted so the cavity opens to the outside (data.drainHoles lists the points; data.cavityOpen). ' +
    'Refusals: MESH_NOT_CLOSED, MESH_PARAM_INVALID, MESH_OFFSET_RESOLUTION, MESH_ENGINE_UNSUPPORTED, MESH_BOOLEAN_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the closed mesh (or other 3D solid) to hollow.'),
    wallThickness: z.number().positive().describe('Wall thickness in document units, measured inward from the outer surface.'),
    drainHoles: z
      .array(
        z.object({
          near: vec3('Point [x, y, z] (document units, world); the hole is centred on the surface point nearest to it.'),
          diameter: z.number().positive().describe('Hole diameter in document units.'),
        }),
      )
      .max(16)
      .optional()
      .describe('Drain holes that open the cavity to the outside (up to 16). Default none: the cavity stays sealed.'),
    tolerance: toleranceParam,
    maxCells: maxCellsParam,
    keepSource: keepSourceParam,
  }),
  run: (doc, { id, wallThickness, drainHoles, tolerance: given, maxCells, keepSource }, ctx): CommandResult =>
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
      ...(drainHoles !== undefined && drainHoles.length > 0
        ? {
            post: (result, _loaded, input, engine): MeshOpResult | MeshEngineFailure => {
              const index = new SurfaceIndex(input.positions, input.indices);
              const tools = drainHoles.map((hole) => drainTool(input, index, hole.near, hole.diameter, wallThickness));
              if (result.mesh === undefined || tools.some((tool) => tool === null))
                return { code: 'MESH_PARAM_INVALID', message: 'a drain hole needs a surface to sit on' };
              const found = tools as DrainTool[];
              const cut = engine.run(
                { mesh: result.mesh },
                { op: 'boolean', kind: 'subtract', others: found.map((tool) => ({ mesh: tool.mesh })) },
              );
              if ('code' in cut) return cut;
              return {
                ...cut,
                report: {
                  ...result.report,
                  drainHoles: found.map((tool, k) => ({
                    near: drainHoles[k]?.near,
                    at: tool.at,
                    normal: tool.normal,
                    diameter: drainHoles[k]?.diameter,
                    distance: tool.distance,
                  })),
                  cavityOpen:
                    cut.mesh !== undefined &&
                    analyzeIndexedMesh(cut.mesh.positions, cut.mesh.indices, { selfIntersections: false, maxListed: 0 }).shellCount === 1,
                },
              };
            },
          }
        : {}),
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
 * Level-set rebuild of any triangle soup into a closed manifold envelope (repair_mesh mode wrap).
 * @invariant inner structures, internal faces and sub-tolerance gaps are destroyed (data.innerStructuresDestroyed); the result has 0 crossing triangles
 */
export function wrapMesh(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  {
    id,
    tolerance: given,
    maxCells,
    keepSource,
  }: { id: string; tolerance?: number | undefined; maxCells?: number | undefined; keepSource?: boolean | undefined },
): CommandResult {
  return runMeshOp(doc, ctx, {
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
        mode: 'wrap',
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
  });
}
