/** Run phases of quad_remesh (07 MSH FR-MSH-22): source and target checks, engine attempts with retries, the quad cage checks and the committed entity. */

import { realignBoundaryRow } from '../../geometry/mesh/quadRow';
import { cageProblem } from '../../geometry/subdivision';
import type { MeshOpResult } from '../../geometry/mesh/engineTypes';
import {
  SYMMETRY_AXIS,
  type SnapProblem,
  type SymmetryPlane,
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
import type { CadDocument, MeshData, SubdivisionEntity, Vec3 } from '../../model/types';
import { newEntity } from '../entity/newEntity';
import { commitSolid } from '../solids/shared';
import { MAX_REFINED_QUADS, sizeProblem } from '../subdivision/shared';
import type { CommandResult, ExecutionContext } from '../types';
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
import { type PreparedMesh, prepareSolidMesh } from './preparedMesh';
import { DEVIATION_BASIS, engineDeviation } from './runMeshOp';

/** A closed quad surface has at least six faces (a cube). */
export const MIN_TARGET_QUADS = 6;
/** Largest quad count: the engine lands up to about 15 % to 20 % over the target and a cage may have 50 000 vertices (D5); a 320-triangle input at 40 000 takes about two minutes. */
export const MAX_TARGET_QUADS = 40_000;
export const DEFAULT_HARD_EDGE_DEG = 30;
export const DEFAULT_LEVELS = 2;
/** An open or symmetric result under this share of the target is asked again once (13.17.6). */
const RATIO_FLOOR = 0.85;
/** The counts a boundary that cannot be snapped is asked again at, as shares of the first (13.17.6). */
const RETRY_UP = 1.15;
const RETRY_DOWN = 0.87;

const isRefusal = (value: object): value is CommandResult => 'document' in value;

type Fail = (code: string, message: string, path?: string) => CommandResult;

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

export interface QuadRemeshParams {
  readonly id: string;
  readonly targetQuadCount?: number | undefined;
  readonly targetEdgeLength?: number | undefined;
  readonly adaptiveSize?: number | undefined;
  readonly detectHardEdgesDeg?: number | undefined;
  readonly output?: 'subdivision' | 'mesh' | undefined;
  readonly symmetry?: { readonly plane: SymmetryPlane } | undefined;
  readonly levels?: number | undefined;
}

interface QuadSource {
  readonly assets: ReturnType<typeof contextOf>['meshAssets'];
  readonly loaded: PreparedMesh['loaded'];
  readonly before: PreparedMesh['before'];
  readonly input: MeshData;
  readonly open: boolean;
  readonly symmetry: SymmetryPlane | undefined;
  readonly axis: number | null;
  readonly half: MeshData | null;
}

/** The prepared source mesh, its symmetry cut (the positive half) and the checks on them; or the refusal. */
function openSource(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  params: QuadRemeshParams,
  output: 'subdivision' | 'mesh',
  fail: Fail,
): QuadSource | CommandResult {
  const { id, targetQuadCount, targetEdgeLength } = params;
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
  return { assets, loaded, before, input, open, symmetry, axis, half: cut };
}

interface QuadPlan extends QuadSource {
  readonly id: string;
  readonly output: 'subdivision' | 'mesh';
  readonly levels: number;
  readonly hardEdgeDeg: number;
  readonly adaptive: boolean;
  readonly engineInput: MeshData;
  readonly keepsBoundary: boolean;
  readonly target: number;
  readonly engine: ReturnType<typeof resolveMeshEngine>;
  readonly fail: Fail;
}

/** The quad count asked for (from the count or the edge length) checked against the range and the refinement budget, with the engine to run. */
function planTarget(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  params: QuadRemeshParams,
  source: QuadSource,
  settings: Pick<QuadPlan, 'output' | 'levels' | 'hardEdgeDeg' | 'fail'>,
): QuadPlan | CommandResult {
  const { id, targetQuadCount, targetEdgeLength } = params;
  const { output, levels, fail } = settings;
  const { before, open, half, input } = source;
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
  return { ...source, ...settings, id, adaptive: (params.adaptiveSize ?? 0) > 0, engineInput, keepsBoundary, target, engine };
}

type QuadMesh = NonNullable<MeshOpResult['quads']>;

const malformedQuads = (quads: QuadMesh): boolean => {
  const raw = quads.positions;
  const vertexCount = raw.length / 3;
  return (
    raw.length % 3 !== 0 ||
    quads.quads.length % 4 !== 0 ||
    !raw.every(Number.isFinite) ||
    !quads.quads.every((v) => Number.isInteger(v) && v >= 0 && v < vertexCount)
  );
};

/** The quads of an open surface (or the half of a symmetric one) with their boundary moved onto the source's and wound like it, or why that cannot be done. */
function boundaryQuads(
  plan: QuadPlan,
  outcome: MeshOpResult,
  quadMesh: QuadMesh,
  engineTarget: number,
): Built | SnapProblem | CommandResult {
  const { engineInput, axis, fail } = plan;
  const raw = quadMesh.positions;
  // an open surface (or the half of a symmetric one): the boundary loops are moved onto the source's and the pieces wound like the source
  // first the outermost layer is replaced by a row on the rim (no staircase); when that cannot be done the vertices of the engine's boundary are moved onto the rim
  const realigned = realignBoundaryRow(engineInput, raw, quadMesh.quads, axis);
  if ('cause' in realigned && realigned.cause === 'source') return realigned;
  // a row whose box is not the source's (a runaway vertex) is given up for the snap too
  const row = 'cause' in realigned || resultBoxProblem(realigned.positions, engineInput) !== null ? null : realigned;
  const snapped = row ?? snapQuadBoundary(engineInput, raw, quadMesh.quads, axis);
  if ('cause' in snapped) return snapped;
  const engineQuads = row !== null ? row.quads : quadMesh.quads;
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
}

/** One engine call asked for `engineTarget` quads and what is made of its answer before the half is mirrored: snapped, wound, checked; a refusal, or why the boundary cannot be snapped. */
function attemptQuads(doc: CadDocument, plan: QuadPlan, engineTarget: number): Built | SnapProblem | CommandResult {
  const { id, engine, engineInput, hardEdgeDeg, keepsBoundary, fail } = plan;
  const outcome = engineOutcome(
    doc,
    'quad_remesh',
    engine.run(
      { mesh: engineInput },
      {
        op: 'quad_remesh',
        targetQuads: engineTarget,
        adaptive: plan.adaptive,
        ...(hardEdgeDeg > 0 ? { hardEdgeRad: (hardEdgeDeg * Math.PI) / 180 } : {}),
        ...(keepsBoundary ? { preserveBoundary: true } : { withDeviation: DEVIATION_MAX_SAMPLES }),
      },
    ),
    [id],
  );
  if (isCommandResult(outcome)) return outcome;
  if (outcome.quads === undefined) return fail('MESH_QUAD_REMESH_FAILED', 'the engine returned no quads');
  const raw = outcome.quads.positions;
  if (malformedQuads(outcome.quads))
    return fail('MESH_QUAD_REMESH_FAILED', 'the engine returned a malformed quad mesh (counts, indices or non-finite coordinates)');
  // the box of a result that keeps a boundary is judged after the boundary was snapped (the engine's staircase boundary juts out of it)
  const rawBox = keepsBoundary ? null : resultBoxProblem(raw, engineInput);
  if (rawBox !== null) return fail('MESH_QUAD_REMESH_FAILED', rawBox);
  if (!keepsBoundary) return { positions: raw.slice(), quads: outcome.quads.quads.slice(), boundary: null, outcome, engineTarget };
  return boundaryQuads(plan, outcome, outcome.quads, engineTarget);
}

/** The first accepted attempt (retried at other counts when the boundary cannot be snapped) and, when it landed under the target, a second try at the corrected count. */
function buildQuads(doc: CadDocument, plan: QuadPlan): { readonly built: Built; readonly sent: number[] } | CommandResult {
  const { target, keepsBoundary, axis, half, fail } = plan;
  // The count of an open or symmetric result lands below the target (boundary rows of quads count twice at a seam): a result under RATIO_FLOOR of it is asked again once,
  // for the count that would have given the target, and the closer of the two is kept; a boundary that cannot be snapped is asked again at 1.15 x and 0.87 x the target.
  const base = half === null ? target : Math.max(1, Math.ceil(target / 2));
  const mirrored = axis === null ? 1 : 2;
  const ratioOf = (made: Built): number => (mirrored * made.quads.length) / 4 / target;
  const sent: number[] = [];
  let built: Built | null = null;
  let failure: SnapProblem | null = null;
  for (const asked of keepsBoundary ? [base, Math.ceil(base * RETRY_UP), Math.max(1, Math.ceil(base * RETRY_DOWN))] : [base]) {
    sent.push(asked);
    const result = attemptQuads(doc, plan, asked);
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
    const second = attemptQuads(doc, plan, again);
    if (isRefusal(second)) return second;
    if (!('cause' in second) && Math.abs(1 - ratioOf(second)) < Math.abs(1 - ratioOf(built))) built = second;
  }
  return { built, sent };
}

interface QuadGeometry {
  readonly positions: number[];
  readonly quads: number[];
  readonly vertices: Vec3[];
  readonly faces: number[][];
  readonly creases: ReturnType<typeof hardEdgeCreases>;
}

/** The mirrored, wound quads as a cage, checked as a surface, against the source and against the subdivision budget; or the refusal. */
function quadGeometry(plan: QuadPlan, built: Built): QuadGeometry | CommandResult {
  const { axis, open, input, output, hardEdgeDeg, levels, fail } = plan;
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
  const size = output === 'subdivision' ? sizeProblem({ vertices, faces, creases }, levels) : null;
  if (size !== null)
    return fail(
      'MESH_PARAM_INVALID',
      `${size.message}; lower targetQuadCount (the result can exceed it by 15 % to 20 %)`,
      'targetQuadCount',
    );
  return { positions, quads, vertices, faces, creases };
}

function boundaryFields(boundary: Built['boundary']): Record<string, unknown> {
  if (boundary === null) return {};
  return {
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
  };
}

/** The entity (a mesh of the triangulated quads, or the subdivision cage) with the measured deviation and the report of the remesh. */
function commitQuads(
  doc: CadDocument,
  plan: QuadPlan,
  params: QuadRemeshParams,
  built: Built,
  sent: readonly number[],
  geometry: QuadGeometry,
): CommandResult {
  const { id, output, levels, keepsBoundary, open, symmetry, engine, input, before, loaded, assets, target } = plan;
  const { outcome, boundary } = built;
  const { positions, quads, vertices, faces, creases } = geometry;
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
    ...boundaryFields(boundary),
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
    const added = addMeshEntity(doc, stored, { unverified: loaded.unverified, color: loaded.entity.color, layerId: loaded.entity.layerId });
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
}

export function runQuadRemesh(doc: CadDocument, ctx: ExecutionContext | undefined, params: QuadRemeshParams): CommandResult {
  const { id } = params;
  const output = params.output ?? 'subdivision';
  const levels = params.levels ?? DEFAULT_LEVELS;
  const hardEdgeDeg = params.detectHardEdgesDeg ?? DEFAULT_HARD_EDGE_DEG;
  const fail: Fail = (code, message, path) => meshRejection(doc, 'quad_remesh', code, message, [id], path !== undefined ? [path] : []);
  const source = openSource(doc, ctx, params, output, fail);
  if ('document' in source) return source;
  const plan = planTarget(doc, ctx, params, source, { output, levels, hardEdgeDeg, fail });
  if ('document' in plan) return plan;
  const made = buildQuads(doc, plan);
  if ('document' in made) return made;
  const geometry = quadGeometry(plan, made.built);
  if ('document' in geometry) return geometry;
  return commitQuads(doc, plan, params, made.built, made.sent, geometry);
}
