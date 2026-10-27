/** quad_remesh — field-aligned quad remeshing of a closed mesh into a subdivision cage or a quad-based mesh (07 MSH FR-MSH-22, M6). */

import { type Cage, cageProblem } from '../../geometry/subdivision';
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
/** Largest quad count: the engine lands up to about 15 % over the target and a cage may have 50 000 vertices (D5); a 320-triangle input at 40 000 takes about two minutes. */
const MAX_TARGET_QUADS = 40_000;
const DEFAULT_HARD_EDGE_DEG = 30;
const DEFAULT_LEVELS = 2;

/**
 * @affects adds 1 subdivision entity (output "subdivision": the quads are the cage, hard edges its creases) or 1 mesh entity (output "mesh": the quads split into triangles); the source stays
 * @invariant closed 2-manifold, outward winding, only quads; the same input and parameters give the same result on the same platform build (the engine is deterministic and has no library-dependent random numbers, but floating-point code generation can differ between compilers and CPUs; provenance.version names the platform); data.deviation is measured on the quad faces, not on the smooth limit surface
 * @failure unknown id / non-solid -> MESH_*; open or non-manifold, inconsistently wound or degenerate input -> MESH_NOT_CLOSED / MESH_NON_MANIFOLD / MESH_ORIENTATION_INCONSISTENT / MESH_DEGENERATE; neither / both targets, target out of range -> MESH_PARAM_INVALID; no native engine -> MESH_ENGINE_UNSUPPORTED; input over the engine cap -> MESH_ENGINE_CAP_EXCEEDED; timeout -> MESH_TIMEOUT; engine failure or an unusable result -> MESH_QUAD_REMESH_FAILED
 */
export const quadRemesh = defineCommand({
  name: 'quad_remesh',
  description:
    'Rebuild a CLOSED mesh (or the triangles of any closed 3D solid) as a clean quad mesh whose edge flow follows the surface (QuadriFlow, ' +
    'Huang et al., SGP 2018: orientation field, position field, integer-grid map; nearly all vertices have 4 quads around them, a few ' +
    '3 or 5 mark where the flow turns). Give EITHER `targetQuadCount` (6..' +
    `${MAX_TARGET_QUADS}) OR \`targetEdgeLength\` (document units; the count is surface area / length squared); the result usually lands within ` +
    '15 % of the count (coarse inputs and tiny targets can be further); data.targetRatio says how close. `output` "subdivision" (default) creates a subdivision solid whose cage is the ' +
    'quads (levels `levels`, default 2) with the hard edges as creases, ready for edit_subdivision_cage and an exact B-spline solid with the OCC ' +
    'kernel; "mesh" creates a triangle mesh whose triangles are the quads split along the shorter diagonal. `detectHardEdgesDeg` (default 30; 0 = ' +
    'off) aligns quads to edges of the source sharper than that angle and, for "subdivision", makes the cage edges along them creases (a smooth surface gets none). `adaptiveSize` > 0 turns on curvature-adaptive ' +
    'quad size (smaller quads where the surface bends; the engine has this one mode, so any value above 0 is the same). The source is kept ' +
    '(it is the target of a later fit). Needs a closed, manifold, consistently wound mesh without degenerate faces (repair_mesh, fill_mesh_holes ' +
    'first); a very uneven triangulation gives better quads after remesh_mesh. Runs on the native mesh engine (llull-compute); there is no ' +
    'TypeScript fallback. Reports quads, vertices, valence (vertices per number of quads around them), irregularVertices, creases, targetRatio and ' +
    'the symmetric deviation of the quad faces from the source (document units; for "subdivision" the smooth limit surface lies inside the cage ' +
    'and is NOT what is measured). Reference: an icosphere of radius 10 with targetQuadCount 600 (l4 icosphere, 5120 triangles) gave 614 quads, eight valence-3 vertices and ' +
    'all others valence 4. Symmetry is not offered (the engine has none). Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_NOT_CLOSED, ' +
    'MESH_NON_MANIFOLD, MESH_ORIENTATION_INCONSISTENT, MESH_DEGENERATE, MESH_PARAM_INVALID, MESH_ENGINE_UNSUPPORTED, MESH_ENGINE_CAP_EXCEEDED (input over 500000 triangles: decimate_mesh first), MESH_TIMEOUT (LLULL_MESH_OP_TIMEOUT_S), MESH_QUAD_REMESH_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the closed mesh (or other closed 3D solid) to quad-remesh.'),
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
    if (!before.closed) return fail('MESH_NOT_CLOSED', `entity '${id}' has open or non-manifold edges; quad_remesh needs a closed surface`);
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
    const outcome = engineOutcome(
      doc,
      'quad_remesh',
      engine.run(
        { mesh: input },
        {
          op: 'quad_remesh',
          targetQuads: target,
          adaptive: (params.adaptiveSize ?? 0) > 0,
          ...(hardEdgeDeg > 0 ? { hardEdgeRad: (hardEdgeDeg * Math.PI) / 180 } : {}),
          withDeviation: DEVIATION_MAX_SAMPLES,
        },
      ),
      [id],
    );
    if (isCommandResult(outcome)) return outcome;
    if (outcome.quads === undefined) return fail('MESH_QUAD_REMESH_FAILED', 'the engine returned no quads');
    const { positions } = outcome.quads;
    const vertexCount = positions.length / 3;
    if (
      positions.length % 3 !== 0 ||
      outcome.quads.quads.length % 4 !== 0 ||
      !positions.every(Number.isFinite) ||
      !outcome.quads.quads.every((v) => Number.isInteger(v) && v >= 0 && v < vertexCount)
    )
      return fail('MESH_QUAD_REMESH_FAILED', 'the engine returned a malformed quad mesh (counts, indices or non-finite coordinates)');
    const boxProblem = resultBoxProblem(positions, input);
    if (boxProblem !== null) return fail('MESH_QUAD_REMESH_FAILED', boxProblem);
    const quads = outwardQuads(positions, outcome.quads.quads);
    const vertices: Vec3[] = Array.from({ length: positions.length / 3 }, (_, i) => [
      positions[3 * i] as number,
      positions[3 * i + 1] as number,
      positions[3 * i + 2] as number,
    ]);
    const faces = Array.from({ length: quads.length / 4 }, (_, f) => quads.slice(4 * f, 4 * f + 4));
    const problem = cageProblem({ vertices, faces, creases: [] });
    if (problem !== null) return fail('MESH_QUAD_REMESH_FAILED', `the engine's quads are not a usable closed surface: ${problem}`);
    const sourceProblem = offSourceProblem(positions, quads, input);
    if (sourceProblem !== null) return fail('MESH_QUAD_REMESH_FAILED', sourceProblem);
    const creases =
      output === 'subdivision' && hardEdgeDeg > 0 ? hardEdgeCreases(positions, quads, input, (hardEdgeDeg * Math.PI) / 180) : [];
    const cage: Cage = { vertices, faces, creases };
    const size = output === 'subdivision' ? sizeProblem(cage, levels) : null;
    if (size !== null)
      return fail(
        'MESH_PARAM_INVALID',
        `${size.message}; lower targetQuadCount (the result can exceed it by about 15 %)`,
        'targetQuadCount',
      );

    const triangles: MeshData = { positions, indices: triangulateQuads(positions, quads) };
    // an engine that measured the quads in the same job (native) saves a second round; otherwise the separate deviation op
    const measured = outcome.deviation ?? engineDeviation(engine, input, triangles);
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
      valence,
      irregularVertices: irregular,
      creases: creases.length,
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
