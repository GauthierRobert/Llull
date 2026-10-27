/** fit_subdivision_to_mesh — move a subdivision cage so that its limit surface follows a target mesh (07 MSH FR-MSH-23, M6). */

import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { sub3 } from '../../lib/vec3';
import { type Cage, cageProblem } from '../../geometry/subdivision';
import { fullSettleLevels } from '../../geometry/subd/settle';
import { type FitStop, type SubdFitFailure, type SubdFitResult, WORK_PER_QUERY, fitSubdivision } from '../../geometry/mesh/subdFit';
import type { MeshData, SubdivisionEntity, Vec3 } from '../../model/types';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import { defineCommand, z } from '../schema';
import { cageData, cageText, isEntity, levelsField, sizeProblem, subdivisionOf } from '../subdivision/shared';
import type { CommandResult } from '../types';
import {
  contextOf,
  isLoadFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  namedDefault,
  outwardMesh,
  withConventions,
} from './meshCommon';

const DEFAULT_ITERATIONS = 10;
const MAX_ITERATIONS = 30;
const DEFAULT_SMOOTHING = 1e-3;
/** Most limit samples the fit solves for (rows of the operator): vertices of the level-k refinement of the cage. */
const MAX_FIT_SAMPLES = 120_000;
/** Most triangles of the target (the same cap as the native mesh ops). */
const MAX_TARGET_TRIANGLES = 500_000;
const DEFAULT_LEVELS = 2;
/** Pinned limit points must hit their vertices to this fraction of the cage size, or the result says so. */
const PIN_TOLERANCE = 1e-9;

const quadsAt = (cage: Cage, level: number): number => cage.faces.length * 4 ** level;

const STOP_TEXT: Readonly<Record<FitStop, string>> = {
  met: 'maxDeviation reached',
  met_on_samples: 'maxDeviation reached on the fit samples but not on the finer verification mesh',
  stalled: 'a round gained under 1 %',
  rounds: 'all rounds used',
  budget: 'the closest-point work cap was reached',
  pinned: 'limit points pinned',
};

/**
 * @affects rewrites the vertex positions of 1 subdivision entity (topology, creases, sharpness and element ids unchanged; `levels` set when given); the target is not touched
 * @invariant the returned cage is the best of the input and every round on the fit samples, so the fit never worsens the surface it was given; the limit surface is sampled at the vertices of the level-`fitLevel` refinement (at least the levels the semi-sharp creases need to decay) and verified on level fitLevel + 1, in both directions; the closest-point work of a round is capped; no kernel or native engine is used
 * @failure unknown / wrong-kind ids, cage with symmetry, invalid or too large cage, too large target -> MESH_* / DIR_*; a cage far from the target, or one whose first closest-point round exceeds the work cap -> MESH_FIT_CAGE_FAR; the solve breaks down -> MESH_FIT_FAILED; maxDeviation not reached -> result applied, warning MESH_FIT_NOT_CONVERGED in data.warnings
 */
export const fitSubdivisionToMesh = defineCommand({
  name: 'fit_subdivision_to_mesh',
  description:
    "Move the vertices of a subdivision solid's cage so that its smooth Catmull-Clark limit surface follows a target mesh (typically the " +
    'mesh quad_remesh was made from). The limit surface is a fixed linear function of the cage, so each round is one sparse least-squares ' +
    'solve: limit samples (the vertices of the level-`levels` refinement) are pulled to their closest points on the target, target ' +
    'vertices are pulled to their closest points on the limit surface, and a small fairing term keeps the cage displacement smooth ' +
    '(`smoothing`); the closest points are refreshed each round. It stops when the largest distance in either direction is <= ' +
    '`maxDeviation`, after `iterations` rounds, when a round gains under 1 %, or when the closest-point work cap is hit; data.stop says ' +
    'which (met, met_on_samples, stalled, rounds, budget, pinned). The best cage found is kept, so the fit never worsens the input. ' +
    "The cage's creases and semi-sharp edges stay and are honoured (a crease follows a sharp edge of the target; semi-sharp edges raise " +
    'the sampling level to the levels they need to decay); topology and element ids are unchanged, the solid is rewritten in place and ' +
    'the target is not touched. A cage that does not reach `maxDeviation` is still updated and the result carries warning ' +
    'MESH_FIT_NOT_CONVERGED in data.warnings (more `iterations`, a finer cage, or a larger `maxDeviation`). `interpolate` true instead ' +
    'pins the limit point of every cage vertex EXACTLY to the nearest target vertex (hard constraints, one solve; `smoothing` and ' +
    '`iterations` do not apply; a surface through the data points, noise included; data.pinResidual is the round-off miss; data.sharedPins counts cage vertices that got a target vertex another cage vertex already has (warning MESH_FIT_PIN_SHARED, open or closed target); two cage ' +
    'vertices may share a target vertex when the cage is denser than the target). `levels` is the sampling level (default the cage ' +
    `level, at least 1; lowered when the samples would exceed ${MAX_FIT_SAMPLES}, reported as data.fitLevel) and, when given, the ` +
    "solid's new display levels. data.maxDeviation, data.mean and data.rms are measured on a finer limit mesh (fitLevel + 1) at its vertices, " +
    'edge midpoints and triangle centres, and at the same kinds of points of the target, each against the other surface (a lower bound ' +
    'of the Hausdorff distance, tight for fine meshes); data.initial is the same measure on the input cage at the fit level. With a ' +
    'closed target, warning MESH_FIT_FOLDED counts limit triangles whose normal opposes the target normal at their closest point (an ' +
    'inside-out or folded cage; the result is still applied). The cage must already sit on the target (box diagonals within a factor ' +
    '10, centres within one target diagonal, and a first closest-point round within the work cap), else MESH_FIT_CAGE_FAR; the target ' +
    'may be open or closed. Pure TypeScript, no kernel needed (about 1 s for a 600-face cage at level 2); the exact B-spline faces come ' +
    'afterwards from the OCC kernel. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, DIR_ENTITY_NOT_FOUND, MESH_FIT_SYMMETRY, ' +
    'MESH_FIT_CAGE_INVALID, MESH_FIT_CAGE_FAR, MESH_FIT_TOO_LARGE, MESH_PARAM_INVALID, MESH_FIT_FAILED.',
  params: z.object({
    cageId: z.string().describe('Id of the subdivision solid whose cage is moved (for example the result of quad_remesh).'),
    targetId: z
      .string()
      .describe('Id of the mesh (or any other 3D solid, tessellated) the limit surface should follow. Not the cage itself.'),
    maxDeviation: z
      .number()
      .positive()
      .describe(
        'Wanted largest distance between the limit surface and the target, in either direction (document units), sampled at vertices, edge midpoints and triangle centres of both meshes.',
      ),
    levels: levelsField
      .min(1)
      .optional()
      .describe(
        `Sampling level 1..4: the limit surface is sampled at the vertices of the cage refined this many times (default the cage level, else ${DEFAULT_LEVELS}; never below what the semi-sharp creases need); also becomes the solid's display levels when given. Lowered automatically above ${MAX_FIT_SAMPLES} samples.`,
      ),
    iterations: z
      .number()
      .int()
      .min(1)
      .max(MAX_ITERATIONS)
      .optional()
      .describe(
        `Most solve rounds, 1..${MAX_ITERATIONS} (default ${DEFAULT_ITERATIONS}); it stops earlier when maxDeviation is met or a round gains under 1 %. Not used with interpolate.`,
      ),
    interpolate: z
      .boolean()
      .optional()
      .describe(
        'true: pin the limit point of each cage vertex exactly to the nearest target vertex (passes through the data, noise included). Default false: least squares over the whole surface.',
      ),
    smoothing: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `Weight of the fairing of the cage displacement (mean squared umbrella Laplacian per cage vertex), 0..1 (default ${DEFAULT_SMOOTHING}). Raise it for a noisy target. Not used with interpolate.`,
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { cageId, targetId, maxDeviation } = params;
    const fail = (code: string, message: string, path?: string): CommandResult =>
      meshRejection(doc, 'fit_subdivision_to_mesh', code, message, [cageId, targetId], path !== undefined ? [`params.${path}`] : []);
    if (cageId === targetId) return fail('MESH_PARAM_INVALID', 'the target must be a different entity than the cage', 'targetId');
    const entity = subdivisionOf(doc, cageId, 'fit_subdivision_to_mesh');
    if (!isEntity(entity)) return entity;
    if (entity.symmetry !== undefined)
      return fail('MESH_FIT_SYMMETRY', `cage '${cageId}' is mirror-symmetric and a fit would break the mirror`);
    const cage: Cage = {
      vertices: entity.vertices,
      faces: entity.faces,
      creases: entity.creases,
      ...(entity.edgeSharpness !== undefined ? { edgeSharpness: entity.edgeSharpness } : {}),
      ...(entity.vertexSharpness !== undefined ? { vertexSharpness: entity.vertexSharpness } : {}),
      ...(entity.creaseMethod !== undefined ? { creaseMethod: entity.creaseMethod } : {}),
      ...(entity.boundary !== undefined ? { boundary: entity.boundary } : {}),
    };
    const problem = cage.vertices.every((vertex) => vertex.every(Number.isFinite)) ? cageProblem(cage) : 'a cage vertex is not finite';
    if (problem !== null) return fail('MESH_FIT_CAGE_INVALID', `cage '${cageId}' is not a usable cage: ${problem}`);
    const size = sizeProblem(cage, params.levels ?? entity.levels);
    if (size !== null) return fail(size.code === 'DIR_LEVELS_RANGE' ? 'MESH_PARAM_INVALID' : 'MESH_FIT_TOO_LARGE', size.message, 'levels');
    const settle = fullSettleLevels(cage);
    const floorLevel = Math.max(1, settle);
    let fitLevel = Math.max(params.levels ?? (entity.levels >= 1 ? entity.levels : DEFAULT_LEVELS), floorLevel);
    while (fitLevel > floorLevel && quadsAt(cage, fitLevel) > MAX_FIT_SAMPLES) fitLevel--;
    if (quadsAt(cage, fitLevel) > MAX_FIT_SAMPLES)
      return fail(
        'MESH_FIT_TOO_LARGE',
        `${cage.faces.length} cage faces need ${quadsAt(cage, fitLevel)} limit samples at level ${fitLevel}${settle > 0 ? ` (its largest edge or vertex sharpness, ${[...(cage.edgeSharpness ?? []), ...(cage.vertexSharpness ?? [])].reduce((m, e) => Math.max(m, e.s), 0)}, needs ${settle} levels to decay; lower the sharpness or use a cage with fewer faces)` : ''} (max ${MAX_FIT_SAMPLES})`,
      );
    const loaded = loadSolidMesh(doc, targetId, undefined, contextOf(ctx).meshAssets);
    if (isLoadFailure(loaded)) return meshRejection(doc, 'fit_subdivision_to_mesh', loaded.code, loaded.message, loaded.ids);
    const triangles = loaded.mesh.indices.length / 3;
    if (triangles > MAX_TARGET_TRIANGLES)
      return fail('MESH_FIT_TOO_LARGE', `target '${targetId}' has ${triangles} triangles (max ${MAX_TARGET_TRIANGLES})`);
    if (!loaded.mesh.positions.every(Number.isFinite)) return fail('MESH_FIT_FAILED', `target '${targetId}' has non-finite coordinates`);
    const targetClosed = measureMesh(loaded.mesh).closed;
    const world = targetClosed ? outwardMesh(loaded.mesh) : loaded.mesh;
    const positions: number[] = [];
    for (let i = 0; i < world.positions.length; i += 3) {
      const point: Vec3 = [world.positions[i] as number, world.positions[i + 1] as number, world.positions[i + 2] as number];
      positions.push(...inverseEulerXYZ(sub3(point, entity.position), entity.rotation));
    }
    const target: MeshData = { positions, indices: world.indices };
    const smoothing = params.smoothing ?? DEFAULT_SMOOTHING;
    const fit: SubdFitResult | SubdFitFailure = fitSubdivision(cage, target, {
      level: fitLevel,
      maxDeviation,
      iterations: params.iterations ?? DEFAULT_ITERATIONS,
      interpolate: params.interpolate === true,
      smoothing,
      targetClosed,
    });
    if ('code' in fit) return fail(fit.code, fit.message);
    const updated: SubdivisionEntity = { ...entity, vertices: fit.vertices, levels: params.levels ?? entity.levels };
    const unit = doc.units;
    const verdict = fit.converged
      ? `converged (${STOP_TEXT[fit.stop]})`
      : `NOT converged (${STOP_TEXT[fit.stop]}; wanted <= ${maxDeviation} ${unit})`;
    const scale = entity.vertices.reduce((m, p) => Math.max(m, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])), 1e-300);
    const warnings: Array<{ code: string; message: string }> = [];
    if (!fit.converged)
      warnings.push({
        code: 'MESH_FIT_NOT_CONVERGED',
        message: `largest distance ${fit.final.max.toPrecision(4)} ${unit} > ${maxDeviation} after ${fit.rounds} round(s) (${STOP_TEXT[fit.stop]}); the best cage was kept${fit.stop === 'budget' ? ` (limit ${WORK_PER_QUERY} triangle tests per query)` : ''}`,
      });
    if (fit.folded.count > 0)
      warnings.push({
        code: 'MESH_FIT_FOLDED',
        message: `${fit.folded.count} of ${fit.folded.checked} limit triangles face against the target (normals more than 100 degrees apart): the cage is inside out or folded there; check_subdivision lists self-intersections`,
      });
    if (!fit.cg.converged)
      warnings.push({
        code: 'MESH_FIT_SOLVER_RESIDUAL',
        message: `the linear solve ended with relative residual ${fit.cg.relativeResidual.toExponential(2)} at its iteration cap; the cage is the best found, not an exact minimum`,
      });
    if (fit.pinResidual !== null && fit.pinResidual > PIN_TOLERANCE * scale)
      warnings.push({
        code: 'MESH_FIT_PIN_RESIDUAL',
        message: `a pinned limit point misses its target vertex by ${fit.pinResidual.toExponential(2)} ${unit}`,
      });
    if (fit.sharedPins !== null && fit.sharedPins > 0)
      warnings.push({
        code: 'MESH_FIT_PIN_SHARED',
        message: `${fit.sharedPins} of ${entity.vertices.length} cage vertices are pinned to a target vertex that another cage vertex already has: the target is coarser than the cage and the surface collapses there (max deviation ${fit.final.max.toPrecision(3)} ${unit}); use the least-squares fit (interpolate off) or a coarser cage`,
      });
    const defaults = [
      ...(params.iterations === undefined ? [namedDefault('iterations', DEFAULT_ITERATIONS, 'rounds', 'TECHNICAL_SPEC 5.9')] : []),
      ...(params.smoothing === undefined ? [namedDefault('smoothing', DEFAULT_SMOOTHING, '1', 'TECHNICAL_SPEC 5.9 (alpha)')] : []),
    ];
    const fields = {
      cageId,
      targetId,
      ...cageData(updated),
      levels: updated.levels,
      fitLevel: fit.fitLevel,
      verifyLevel: fit.verifyLevel,
      samples: fit.rows,
      rounds: fit.rounds,
      stop: fit.stop,
      cgIterations: fit.cg.iterations,
      cgConverged: fit.cg.converged,
      cgRelativeResidual: fit.cg.relativeResidual,
      converged: fit.converged,
      interpolate: params.interpolate === true,
      pinResidual: fit.pinResidual,
      sharedPins: fit.sharedPins,
      smoothing,
      requestedMaxDeviation: maxDeviation,
      maxDeviation: fit.final.max,
      mean: fit.final.mean,
      rms: fit.final.rms,
      forwardMax: fit.final.forwardMax,
      backwardMax: fit.final.backwardMax,
      worst: fit.final.worst,
      measuredSamples: fit.final.samples,
      initial: { ...fit.initial, level: fit.fitLevel },
      foldedTriangles: fit.folded.count,
      foldedChecked: fit.folded.checked,
      targetTriangles: triangles,
      targetClosed,
      warnings,
    };
    return {
      ...changed(
        replaceEntity(doc, updated),
        `fit_subdivision_to_mesh '${cageId}' to '${targetId}': max deviation ${fit.final.max.toPrecision(3)} ${unit} (rms ${fit.final.rms.toPrecision(3)}; input ${fit.initial.max.toPrecision(3)}) in ${fit.rounds} round(s), ${verdict}${fit.folded.count > 0 ? `; WARNING ${fit.folded.count} folded limit triangles` : ''}; ${cageText(updated, updated.levels)}, sampled at level ${fit.fitLevel} (${fit.rows} samples).`,
        [cageId],
      ),
      data: withConventions(doc, fields, { unverified: loaded.unverified, defaults }),
    };
  },
});
