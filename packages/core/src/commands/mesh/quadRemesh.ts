/** quad_remesh — field-aligned quad remeshing of a closed or open mesh, optionally mirror-symmetric, into a subdivision cage or a quad-based mesh (07 MSH FR-MSH-22, M6). */

import { realignBoundaryRow } from '../../geometry/mesh/quadRow';
import { type Cage, cageProblem } from '../../geometry/subdivision';
import type { MeshOpResult } from '../../geometry/mesh/engineTypes';
import {
  SYMMETRY_AXIS,
  type SnapProblem,
  halfOf,
  mirrorWeld,
  orientQuadsToSource,
  snapQuadBoundary,
  symmetryProblem,
} from '../../geometry/mesh/quadOpen';
import { meshDiagonal } from '../../geometry/mesh/weld';
import { DEVIATION_MAX_SAMPLES } from '../../geometry/mesh/deviation';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import {
  hardEdgeCreases,
  offSourceProblem,
  outwardQuads,
  quadValence,
  resultBoxProblem,
  triangulateQuads,
} from '../../geometry/mesh/quadCage';
import { initialElementIds } from '../../geometry/subd/elements';
import { nextId } from '../../lib/id';
import type { MeshData, SubdivisionEntity, Vec3 } from '../../model/types';
import { defineCommand, z } from '../schema';
import { newEntity } from '../entity/newEntity';
import { commitSolid } from '../solids/shared';
import { MAX_REFINED_QUADS, levelsField, sizeProblem } from '../subdivision/shared';
import type { CommandResult } from '../types';
import {
  addMeshEntity,
  contextOf,
  engineOutcome,
  isCommandResult,
  isStoreFailure,
  meshRejection,
  namedDefault,
  storeMesh,
  withConventions,
} from './meshCommon';
import { prepareSolidMesh } from './preparedMesh';
import { DEVIATION_BASIS, engineDeviation } from './runMeshOp';

/** A closed quad surface has at least six faces (a cube). */
const MIN_TARGET_QUADS = 6;
/** Largest quad count: the engine lands up to about 15 % to 20 % over the target and a cage may have 50 000 vertices (D5); a 320-triangle input at 40 000 takes about two minutes. */
const MAX_TARGET_QUADS = 40_000;
const DEFAULT_HARD_EDGE_DEG = 30;
const DEFAULT_LEVELS = 2;
/** An open or symmetric result under this share of the target is asked again once (13.17.6). */
const RATIO_FLOOR = 0.85;
/** The counts a boundary that cannot be snapped is asked again at, as shares of the first (13.17.6). */
const RETRY_UP = 1.15;
const RETRY_DOWN = 0.87;

const isRefusal = (value: object): value is CommandResult => 'document' in value;

/** What one engine call made of its quads before the half is mirrored. */
interface Built {
  readonly positions: number[];
  readonly quads: number[];
  readonly boundary: {
    readonly loops: number;
    readonly worstMove: number;
    readonly row: { readonly stripQuads: number; readonly removedQuads: number; readonly evenness: number } | null;
  } | null;
  readonly outcome: MeshOpResult;
  readonly engineTarget: number;
}

/**
 * @affects adds 1 subdivision entity (output "subdivision": the quads are the cage, hard edges its creases) or 1 mesh entity (output "mesh": the quads split into triangles); the source stays
 * @invariant only quads; a closed source gives a closed 2-manifold with outward winding; an open source (output "mesh") gives quads whose boundary loops lie on the source's, one for one; with `symmetry` the source must be symmetric about the plane and the quads are exactly mirror-symmetric (the positive half is remeshed, its boundary snapped onto the source's and the plane, then mirrored and welded); the same input and parameters give the same result on the same platform build (the engine is deterministic and has no library-dependent random numbers, but floating-point code generation can differ between compilers and CPUs; provenance.version names the platform); data.deviation is measured on the quad faces, not on the smooth limit surface
 * @failure unknown id / non-solid -> MESH_*; open input with output "subdivision" -> MESH_NOT_CLOSED; non-manifold, inconsistently wound or degenerate input -> MESH_NON_MANIFOLD / MESH_ORIENTATION_INCONSISTENT / MESH_DEGENERATE; a source not symmetric about the plane -> MESH_QUAD_REMESH_NOT_SYMMETRIC; an open source whose boundary loops the engine's quads do not follow one for one (a hole it covers, loops it merges) -> MESH_QUAD_REMESH_BOUNDARY_LOST; a boundary that cannot be snapped onto the rim without folding quads (after retries) -> MESH_QUAD_REMESH_SNAP_FAILED; symmetry with nothing on the positive side of the plane, or triangles lying in it -> MESH_PARAM_INVALID; neither / both targets, target out of range -> MESH_PARAM_INVALID; no native engine -> MESH_ENGINE_UNSUPPORTED; input over the engine cap -> MESH_ENGINE_CAP_EXCEEDED; timeout -> MESH_TIMEOUT; engine failure or an unusable result -> MESH_QUAD_REMESH_FAILED
 */
export const quadRemesh = defineCommand({
  name: 'quad_remesh',
  description:
    'Rebuild a mesh (or the triangles of any 3D solid) as a clean quad mesh whose edge flow follows the surface (QuadriFlow, ' +
    'Huang et al., SGP 2018: orientation field, position field, integer-grid map; nearly all vertices have 4 quads around them, a few ' +
    '3 or 5 mark where the flow turns). Give EITHER `targetQuadCount` (6..' +
    `${MAX_TARGET_QUADS}) OR \`targetEdgeLength\` (document units; the count is surface area / length squared); a closed result usually lands within ` +
    '15 % of the count (coarse inputs and tiny targets can be further); an OPEN or SYMMETRIC result is further off: the engine answers 0.7 to 0.85 of it and the boundary row changes the count by a few quads, so the first answer is under or over (measured 0.83 to 1.2); when it is under 0.85 or the boundary cannot be made the command asks the engine again (at 1.15 x and 0.87 x, or for the count that would have given the target) and keeps the closer result: the finished results measured 0.87 to 1.17 of the target (data.attempts and data.engineTargets: the counts sent; data.targetRatio is the exact ratio, check it). `output` "subdivision" (default) creates a subdivision solid whose cage is the ' +
    'quads (levels `levels`, default 2) with the hard edges as creases, ready for edit_subdivision_cage and an exact B-spline solid with the OCC ' +
    'kernel; "mesh" creates a triangle mesh whose triangles are the quads split along the shorter diagonal. `detectHardEdgesDeg` (default 30; 0 = ' +
    'off) aligns quads to edges of the source sharper than that angle and, for "subdivision", makes the cage edges along them creases (a smooth surface gets none). `adaptiveSize` > 0 turns on curvature-adaptive ' +
    'quad size (smaller quads where the surface bends; the engine has this one mode, so any value above 0 is the same). The source is kept ' +
    '(it is the target of a later fit). Needs a manifold, consistently wound mesh without degenerate faces (repair_mesh, fill_mesh_holes ' +
    'first). An OPEN mesh (boundary loops) works with output "mesh" only: the quads keep its boundary, the outermost layer of the engine quads is replaced by ONE row of quads whose outer edge lies on the source boundary loop (no staircase: every boundary vertex has two quads but the corners of the rim, which are exact; data.boundaryRow "realigned", boundaryRowQuads, boundaryLayerRemoved, boundaryRowEvenness), or, when that row would fold, the vertices of the engine boundary are moved onto the rim ("snapped"); data.boundaryLoops; data.boundaryMove = how far the new boundary vertices are from the nearest vertex of the engine boundary (they are ON the source boundary, so it is not a deviation from it); output "subdivision" needs a closed mesh. ' +
    '`symmetry` {plane yz|xz|xy through the origin} makes the quads exactly mirror-symmetric: the source must already be symmetric about the plane (within 0.1 % of its diagonal, else MESH_QUAD_REMESH_NOT_SYMMETRIC), the half on the positive side is remeshed with its cut on the plane kept, and the half and its mirror image are welded on the plane (the count is the whole). A very uneven triangulation gives better quads after remesh_mesh. Runs on the native mesh engine (llull-compute); there is no ' +
    'TypeScript fallback. Reports quads, vertices, valence (vertices per number of quads around them), irregularVertices, creases, targetRatio and ' +
    'the symmetric deviation of the quad faces from the source (document units; for "subdivision" the smooth limit surface lies inside the cage ' +
    'and is NOT what is measured). Reference: an icosphere of radius 10 with targetQuadCount 600 (l4 icosphere, 5120 triangles) gave 614 quads, eight valence-3 vertices and ' +
    'all others valence 4. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_NOT_CLOSED (open input with output "subdivision"), MESH_QUAD_REMESH_NOT_SYMMETRIC, MESH_QUAD_REMESH_BOUNDARY_LOST (the engine kept fewer boundary loops than the source has: a mesh with holes, an annulus; close the holes with fill_mesh_holes or cut the mesh along its holes), MESH_QUAD_REMESH_SNAP_FAILED (the boundary loops are there but cannot be placed on the rim without folding quads, after retries at 1.15 x and 0.87 x the count: try another targetQuadCount), ' +
    'MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_PARAM_INVALID, MESH_ENGINE_UNSUPPORTED, MESH_ENGINE_CAP_EXCEEDED (input over 500000 triangles: decimate_mesh first), MESH_TIMEOUT (LLULL_MESH_OP_TIMEOUT_S), MESH_QUAD_REMESH_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to quad-remesh; open meshes need output "mesh".'),
    targetQuadCount: z
      .number()
      .int()
      .min(MIN_TARGET_QUADS)
      .max(MAX_TARGET_QUADS)
      .optional()
      .describe(`Wanted number of quads, ${MIN_TARGET_QUADS}..${MAX_TARGET_QUADS}. Not with targetEdgeLength.`),
    targetEdgeLength: z
      .number()
      .positive()
      .optional()
      .describe('Wanted quad edge length (document units); the quad count is surface area / length squared. Not with targetQuadCount.'),
    adaptiveSize: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        '0 (default): uniform quad size. Above 0: smaller quads where the surface curves more (one mode, any value above 0 is the same).',
      ),
    detectHardEdgesDeg: z
      .number()
      .min(0)
      .max(180)
      .optional()
      .describe(
        `Edges of the source whose faces meet at more than this angle (degrees) are hard: the quads align to them and, for output "subdivision", the cage edges along them become creases. 0 turns it off. Default ${DEFAULT_HARD_EDGE_DEG}.`,
      ),
    output: z
      .enum(['subdivision', 'mesh'])
      .optional()
      .describe(
        '"subdivision" (default): a subdivision solid with the quads as its cage. "mesh": a triangle mesh (each quad split in two).',
      ),
    symmetry: z
      .object({ plane: z.enum(['yz', 'xz', 'xy']).describe('Mirror plane through the origin: yz mirrors x, xz mirrors y, xy mirrors z.') })
      .optional()
      .describe(
        'Make the quads exactly symmetric about this plane. The source must be symmetric about it already (MESH_QUAD_REMESH_NOT_SYMMETRIC otherwise).',
      ),
    levels: levelsField
      .optional()
      .describe(
        `output "subdivision" only: subdivision levels of the new solid, 0..4 (default ${DEFAULT_LEVELS}; each level quadruples the faces).`,
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, targetQuadCount, targetEdgeLength } = params;
    const output = params.output ?? 'subdivision';
    const levels = params.levels ?? DEFAULT_LEVELS;
    const hardEdgeDeg = params.detectHardEdgesDeg ?? DEFAULT_HARD_EDGE_DEG;
    const fail = (code: string, message: string, path?: string): CommandResult =>
      meshRejection(doc, 'quad_remesh', code, message, [id], path !== undefined ? [path] : []);
    if ((targetQuadCount === undefined) === (targetEdgeLength === undefined))
      return fail('MESH_PARAM_INVALID', 'give exactly one of targetQuadCount or targetEdgeLength', 'targetQuadCount');
    const assets = contextOf(ctx).meshAssets;
    const prepared = prepareSolidMesh(doc, ctx, id, { outward: true });
    if ('code' in prepared) return meshRejection(doc, 'quad_remesh', prepared.code, prepared.message, prepared.ids);
    const { loaded, before, input } = prepared;
    const open = !before.closed;
    if (open && output !== 'mesh')
      return fail(
        'MESH_NOT_CLOSED',
        `entity '${id}' has open or non-manifold edges; output "subdivision" needs a closed surface (output "mesh" takes an open one)`,
      );
    const symmetry = params.symmetry?.plane;
    const axis = symmetry === undefined ? null : SYMMETRY_AXIS[symmetry];
    const diagonal = meshDiagonal(input.positions);
    if (symmetry !== undefined) {
      const asymmetric = symmetryProblem(input, symmetry, diagonal);
      if (asymmetric !== null) return fail('MESH_QUAD_REMESH_NOT_SYMMETRIC', asymmetric, 'symmetry');
    }
    const cut = symmetry === undefined ? null : halfOf(input, symmetry, diagonal);
    if (cut === 'empty')
      return fail('MESH_PARAM_INVALID', `nothing of the mesh is on the positive side of the ${symmetry} plane`, 'symmetry');
    if (cut !== null && 'flat' in cut)
      return fail(
        'MESH_PARAM_INVALID',
        `${cut.flat} triangle(s) lie in the ${symmetry} plane (a flat part on the symmetry plane has no side): move them off the plane or leave symmetry out`,
        'symmetry',
      );
    const half = cut;
    // the engine remeshes an open surface (the source, or the half of a symmetric one) and keeps its boundary
    const engineInput = half ?? input;
    const keepsBoundary = open || half !== null;
    const target = targetQuadCount ?? Math.round(before.area / ((targetEdgeLength as number) * (targetEdgeLength as number)));
    if (!(target >= MIN_TARGET_QUADS && target <= MAX_TARGET_QUADS))
      return fail(
        'MESH_PARAM_INVALID',
        `targetEdgeLength ${targetEdgeLength} gives ${target} quads on ${before.area.toPrecision(6)} ${doc.units}^2; the range is ${MIN_TARGET_QUADS}..${MAX_TARGET_QUADS}`,
        'targetEdgeLength',
      );
    if (output === 'subdivision' && target * 4 ** levels > MAX_REFINED_QUADS)
      return fail(
        'MESH_PARAM_INVALID',
        `${target} quads at ${levels} levels refine to over ${MAX_REFINED_QUADS} quads; lower levels`,
        'levels',
      );
    const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
    /** One engine call asked for `engineTarget` quads and what is made of its answer before the half is mirrored: snapped, wound, checked; a refusal, or why the boundary cannot be snapped. */
    const attempt = (engineTarget: number): Built | SnapProblem | CommandResult => {
      const outcome = engineOutcome(
        doc,
        'quad_remesh',
        engine.run(
          { mesh: engineInput },
          {
            op: 'quad_remesh',
            targetQuads: engineTarget,
            adaptive: (params.adaptiveSize ?? 0) > 0,
            ...(hardEdgeDeg > 0 ? { hardEdgeRad: (hardEdgeDeg * Math.PI) / 180 } : {}),
            ...(keepsBoundary ? { preserveBoundary: true } : { withDeviation: DEVIATION_MAX_SAMPLES }),
          },
        ),
        [id],
      );
      if (isCommandResult(outcome)) return outcome;
      if (outcome.quads === undefined) return fail('MESH_QUAD_REMESH_FAILED', 'the engine returned no quads');
      const raw = outcome.quads.positions;
      const vertexCount = raw.length / 3;
      if (
        raw.length % 3 !== 0 ||
        outcome.quads.quads.length % 4 !== 0 ||
        !raw.every(Number.isFinite) ||
        !outcome.quads.quads.every((v) => Number.isInteger(v) && v >= 0 && v < vertexCount)
      )
        return fail('MESH_QUAD_REMESH_FAILED', 'the engine returned a malformed quad mesh (counts, indices or non-finite coordinates)');
      // the box of a result that keeps a boundary is judged after the boundary was snapped (the engine's staircase boundary juts out of it)
      const rawBox = keepsBoundary ? null : resultBoxProblem(raw, engineInput);
      if (rawBox !== null) return fail('MESH_QUAD_REMESH_FAILED', rawBox);
      if (!keepsBoundary) return { positions: raw.slice(), quads: outcome.quads.quads.slice(), boundary: null, outcome, engineTarget };
      // an open surface (or the half of a symmetric one): the boundary loops are moved onto the source's and the pieces wound like the source
      // first the outermost layer is replaced by a row on the rim (no staircase); when that cannot be done the vertices of the engine's boundary are moved onto the rim
      const realigned = realignBoundaryRow(engineInput, raw, outcome.quads.quads, axis);
      if ('cause' in realigned && realigned.cause === 'source') return realigned;
      // a row whose box is not the source's (a runaway vertex) is given up for the snap too
      const row = 'cause' in realigned || resultBoxProblem(realigned.positions, engineInput) !== null ? null : realigned;
      const snapped = row ?? snapQuadBoundary(engineInput, raw, outcome.quads.quads, axis);
      if ('cause' in snapped) return snapped;
      const engineQuads = row !== null ? row.quads : outcome.quads.quads;
      const snappedBox = resultBoxProblem(snapped.positions, engineInput);
      if (snappedBox !== null) return fail('MESH_QUAD_REMESH_FAILED', snappedBox);
      return {
        positions: snapped.positions,
        quads: orientQuadsToSource(engineInput, snapped.positions, engineQuads),
        boundary: {
          loops: snapped.loops,
          worstMove: snapped.worstMove,
          row: row === null ? null : { stripQuads: row.stripQuads, removedQuads: row.removedQuads, evenness: row.evenness },
        },
        outcome,
        engineTarget,
      };
    };
    // The count of an open or symmetric result lands below the target (boundary rows of quads count twice at a seam): a result under RATIO_FLOOR of it is asked again once,
    // for the count that would have given the target, and the closer of the two is kept; a boundary that cannot be snapped is asked again at 1.15 x and 0.87 x the target.
    const base = half === null ? target : Math.max(1, Math.ceil(target / 2));
    const mirrored = axis === null ? 1 : 2;
    const ratioOf = (built: Built): number => (mirrored * built.quads.length) / 4 / target;
    const sent: number[] = [];
    let built: Built | null = null;
    let failure: SnapProblem | null = null;
    for (const asked of keepsBoundary ? [base, Math.ceil(base * RETRY_UP), Math.max(1, Math.ceil(base * RETRY_DOWN))] : [base]) {
      sent.push(asked);
      const result = attempt(asked);
      if (isRefusal(result)) return result;
      if ('cause' in result) {
        failure ??= result;
        if (result.cause === 'source') break;
        continue;
      }
      built = result;
      break;
    }
    if (built === null) {
      const cause = (failure as SnapProblem).cause;
      return fail(
        cause === 'loops' ? 'MESH_QUAD_REMESH_BOUNDARY_LOST' : cause === 'source' ? 'MESH_NON_MANIFOLD' : 'MESH_QUAD_REMESH_SNAP_FAILED',
        `${(failure as SnapProblem).message} (engine counts tried: ${sent.join(', ')})`,
      );
    }
    if (keepsBoundary && ratioOf(built) < RATIO_FLOOR) {
      const again = Math.min(MAX_TARGET_QUADS, Math.ceil(built.engineTarget / ratioOf(built)));
      sent.push(again);
      const second = attempt(again);
      if (isRefusal(second)) return second;
      if (!('cause' in second) && Math.abs(1 - ratioOf(second)) < Math.abs(1 - ratioOf(built))) built = second;
    }
    const { outcome, boundary } = built;
    let { positions, quads } = built;
    if (axis !== null) ({ positions, quads } = mirrorWeld(positions, quads, axis));
    if (!open) quads = outwardQuads(positions, quads);
    const vertices: Vec3[] = Array.from({ length: positions.length / 3 }, (_, i) => [
      positions[3 * i] as number,
      positions[3 * i + 1] as number,
      positions[3 * i + 2] as number,
    ]);
    const faces = Array.from({ length: quads.length / 4 }, (_, f) => quads.slice(4 * f, 4 * f + 4));
    const problem = cageProblem({ vertices, faces, creases: [], ...(open ? { boundary: 'edge_and_corner' as const } : {}) });
    if (problem !== null)
      return fail('MESH_QUAD_REMESH_FAILED', `the engine's quads are not a usable ${open ? 'open' : 'closed'} surface: ${problem}`);
    const sourceProblem = offSourceProblem(positions, quads, input);
    if (sourceProblem !== null) return fail('MESH_QUAD_REMESH_FAILED', sourceProblem);
    const creases =
      output === 'subdivision' && hardEdgeDeg > 0 ? hardEdgeCreases(positions, quads, input, (hardEdgeDeg * Math.PI) / 180) : [];
    const cage: Cage = { vertices, faces, creases };
    const size = output === 'subdivision' ? sizeProblem(cage, levels) : null;
    if (size !== null)
      return fail(
        'MESH_PARAM_INVALID',
        `${size.message}; lower targetQuadCount (the result can exceed it by 15 % to 20 %)`,
        'targetQuadCount',
      );

    const triangles: MeshData = { positions, indices: triangulateQuads(positions, quads) };
    // an engine that measured the quads in the same job (native) saves a second round; otherwise the separate deviation op
    const measured = (!keepsBoundary ? outcome.deviation : undefined) ?? engineDeviation(engine, input, triangles);
    const deviation = 'code' in measured ? null : measured;
    const valence = quadValence(quads, vertices.length);
    const irregular = vertices.length - (valence['4'] ?? 0);
    const fields = {
      sourceId: id,
      output,
      quads: faces.length,
      vertices: vertices.length,
      targetQuads: target,
      targetRatio: faces.length / target,
      attempts: sent.length,
      engineTargets: sent,
      valence,
      irregularVertices: irregular,
      creases: creases.length,
      open,
      ...(symmetry !== undefined ? { symmetry: { plane: symmetry } } : {}),
      ...(boundary !== null
        ? {
            boundaryLoops: boundary.loops,
            boundaryMove: boundary.worstMove,
            boundaryRow: boundary.row === null ? 'snapped' : 'realigned',
            ...(boundary.row === null
              ? {}
              : {
                  boundaryRowQuads: boundary.row.stripQuads,
                  boundaryLayerRemoved: boundary.row.removedQuads,
                  boundaryRowEvenness: boundary.row.evenness,
                }),
          }
        : {}),
      areaBefore: before.area,
      volumeBefore: before.volume,
      ...(output === 'subdivision' ? { levels } : {}),
      ...(deviation !== null
        ? { deviation: { ...deviation, max: deviation.hausdorff, unit: doc.units, basis: DEVIATION_BASIS } }
        : { deviation: null, deviationSkipped: 'code' in measured ? measured.code : null }),
    };
    const defaults = [
      ...(params.detectHardEdgesDeg === undefined
        ? [namedDefault('detectHardEdgesDeg', DEFAULT_HARD_EDGE_DEG, 'deg', 'FR-MSH-22 default')]
        : []),
      ...(output === 'subdivision' && params.levels === undefined
        ? [namedDefault('levels', DEFAULT_LEVELS, 'levels', 'TECHNICAL_SPEC D5')]
        : []),
    ];
    const context = { unverified: loaded.unverified, provenance: outcome.provenance, defaults };
    const text = (newId: string): string =>
      `quad_remesh '${id}' -> '${newId}' (${output}): ${faces.length} quads (target ${target}, ratio ${(faces.length / target).toFixed(3)}), ` +
      `${vertices.length} vertices, ${irregular} irregular, ${creases.length} crease(s)` +
      `${boundary !== null ? `, ${boundary.loops} boundary loop(s) kept (largest move ${boundary.worstMove.toPrecision(3)} ${doc.units})` : ''}` +
      `${symmetry !== undefined ? `, symmetric about ${symmetry}` : ''}` +
      `${deviation !== null ? `, max deviation ${deviation.hausdorff.toPrecision(3)} ${doc.units}` : ''}`;

    if (output === 'mesh') {
      const stored = storeMesh(triangles, assets);
      if (isStoreFailure(stored)) return meshRejection(doc, 'quad_remesh', stored.code, stored.message, [id]);
      const added = addMeshEntity(doc, stored, {
        unverified: loaded.unverified,
        color: loaded.entity.color,
        layerId: loaded.entity.layerId,
      });
      return {
        document: added.document,
        summary: `${text(added.id)}.`,
        affected: [added.id],
        data: withConventions(doc, { id: added.id, ...fields }, context),
      };
    }
    const subdivisionId = nextId('subd');
    const entity = newEntity(
      'subdivision',
      subdivisionId,
      { vertices, faces, creases, levels, elementIds: initialElementIds(vertices.length, faces.length) } satisfies Omit<
        SubdivisionEntity,
        'id' | 'kind' | 'position' | 'rotation' | 'layerId' | 'color' | 'name'
      >,
      [0, 0, 0],
      loaded.entity.color,
      { layerId: loaded.entity.layerId },
    );
    const committed = commitSolid(doc, entity, text(subdivisionId));
    return { ...committed, data: withConventions(doc, { id: subdivisionId, ...fields }, context) };
  },
});
