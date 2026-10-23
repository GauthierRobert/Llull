/** repair_mesh — weld, clean, orient, stitch, close_holes and wrap repair of a triangle mesh (07 MSH FR-MSH-05 / 07). */

import type { RepairChanges } from '../../geometry/mesh/repair';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { DEFAULT_MAX_CELLS, keepSourceParam, maxCellsParam, toleranceParam, wrapMesh } from './levelSetCommands';
import { namedDefault } from './meshCommon';
import { runMeshOp } from './runMeshOp';

/** Boundary-vertex merge distance as a multiple of the weld tolerance (named default, TECHNICAL §5.2). */
const MAX_GAP_FACTOR = 100;
const DEFAULT_MAX_BOUNDARY_EDGES = 1000;

const changeText = (c: RepairChanges): string => {
  const parts = Object.entries({
    welded: c.welded,
    'duplicate faces removed': c.duplicatesRemoved,
    'degenerate faces removed': c.degenerateRemoved,
    flipped: c.flipped,
    stitched: c.stitched,
    'holes filled': c.holesFilled,
    'small shells removed': c.componentsRemoved,
  })
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${n} ${name}`);
  return parts.length > 0 ? parts.join(', ') : 'nothing to change';
};

/**
 * @affects rewrites the mesh `id` with the repaired triangles (or adds one mesh with keepSource); wrap delegates to the level-set rebuild
 * @invariant modes in increasing intrusiveness: weld < clean < orient < stitch < close_holes < wrap; vertices are never moved except by weld / stitch merging them onto the lowest-index one; data.changes counts what each step did
 * @failure unknown id / non-solid -> MESH_*; wrap without Manifold -> MESH_ENGINE_UNSUPPORTED; close_holes over maxBoundaryEdges leaves that hole open and counts it in data.skippedHoles
 */
export const repairMesh = defineCommand({
  name: 'repair_mesh',
  description:
    'Repair a mesh (or the triangles of any 3D solid). Modes, least to most intrusive: "weld" merges vertices closer than weldTolerance and drops faces ' +
    'that collapse; "clean" also removes degenerate (repeated vertex or zero area) and duplicate faces; "orient" makes every shell consistently wound ' +
    '(outward for closed shells; reports faces flipped); "stitch" closes gaps by merging boundary vertices closer than maxGap, then cleans; "close_holes" is ' +
    'stitch followed by a plain fill of every boundary loop up to maxBoundaryEdges (use fill_mesh_holes for faired patches); "wrap" rebuilds a ' +
    'closed manifold envelope from a signed-distance field (Manifold engine; destroys inner structures, reports innerStructuresDestroyed). ' +
    'removeSmallComponents deletes noise shells (at most maxFaces faces, or a closed shell of volume at most maxVolume) in any non-wrap mode; the ' +
    'largest shell is never removed. Typical order: analyze_mesh -> repair_mesh mode=stitch -> fill_mesh_holes -> repair_mesh mode=orient -> check_mesh. ' +
    'Reports data.changes {welded, duplicatesRemoved, degenerateRemoved, flipped, stitched, holesFilled, componentsRemoved}, closed, volume and the ' +
    'symmetric deviation from the input (document units). Lengths in document units. ' +
    'Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_OFFSET_RESOLUTION and MESH_ENGINE_UNSUPPORTED (wrap).',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to repair.'),
    mode: z
      .enum(['weld', 'clean', 'orient', 'stitch', 'close_holes', 'wrap'])
      .describe('Repair mode, least to most intrusive: weld, clean, orient, stitch, close_holes, wrap.'),
    weldTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Vertices closer than this (document units) are merged before repair. Default 1e-6 x bounding-box diagonal (named default).',
      ),
    maxGap: z
      .number()
      .positive()
      .optional()
      .describe(
        'stitch / close_holes: boundary vertices closer than this (document units) are merged. Default 100 x the weld tolerance (named default).',
      ),
    removeSmallComponents: z
      .object({
        maxFaces: z.number().int().positive().optional().describe('Remove shells with at most this many faces.'),
        maxVolume: z
          .number()
          .positive()
          .optional()
          .describe('Remove closed shells whose absolute volume is at most this (document units^3).'),
      })
      .optional()
      .describe('Delete small noise shells (not for wrap). Give maxFaces and / or maxVolume. The largest shell always stays.'),
    maxBoundaryEdges: z
      .number()
      .int()
      .min(3)
      .optional()
      .describe(`close_holes: loops with more edges than this stay open (reported). Default ${DEFAULT_MAX_BOUNDARY_EDGES}.`),
    tolerance: toleranceParam,
    maxCells: maxCellsParam,
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, mode, weldTolerance, maxGap, removeSmallComponents, maxBoundaryEdges, tolerance, maxCells, keepSource } = params;
    if (mode === 'wrap') return wrapMesh(doc, ctx, { id, tolerance, maxCells: maxCells ?? DEFAULT_MAX_CELLS, keepSource });
    const rule = removeSmallComponents;
    const small =
      rule !== undefined && (rule.maxFaces !== undefined || rule.maxVolume !== undefined)
        ? {
            smallComponents: {
              ...(rule.maxFaces !== undefined ? { maxFaces: rule.maxFaces } : {}),
              ...(rule.maxVolume !== undefined ? { maxVolume: rule.maxVolume } : {}),
            },
          }
        : {};
    return runMeshOp(doc, ctx, {
      command: 'repair_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      ...(weldTolerance !== undefined ? { weldTolerance } : {}),
      op: (loaded) => ({
        op: 'repair',
        mode,
        weldTolerance: loaded.weldTolerance,
        maxGap: maxGap ?? MAX_GAP_FACTOR * loaded.weldTolerance,
        maxBoundaryEdges: maxBoundaryEdges ?? DEFAULT_MAX_BOUNDARY_EDGES,
        ...small,
      }),
      defaults: (loaded) => [
        ...(weldTolerance === undefined
          ? [namedDefault('weldTolerance', loaded.weldTolerance, doc.units, 'llull default 1e-6 x bbox diagonal')]
          : []),
        ...(maxGap === undefined && (mode === 'stitch' || mode === 'close_holes')
          ? [namedDefault('maxGap', MAX_GAP_FACTOR * loaded.weldTolerance, doc.units, 'llull default 100 x weld tolerance')]
          : []),
      ],
      fields: (before, _after, result) => ({
        mode,
        changes: result.report['changes'],
        notes: result.report['notes'],
        skippedHoles: result.report['skippedHoles'],
        closedBefore: before.closed,
        volumeBefore: before.volume,
        facesBefore: before.faces,
      }),
      summary: (from, to, before, after, _unit, result) =>
        `repair_mesh '${from}' mode=${mode} -> '${to}': ${after.faces} triangles (was ${before.faces}), ${after.closed ? 'closed' : 'OPEN'}; ` +
        `${changeText(result.report['changes'] as RepairChanges)}.`,
    });
  },
});
