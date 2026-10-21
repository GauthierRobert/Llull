/**
 * fillet_edge with per-edge radius laws and chord-length sizing (SC-F3): resolves each entry to a unique-edge index, converts chords to radii
 * from the planar faces at the edge, and builds one fillet node. Uniform laws keep the single-`size` recipe form every kernel reads; differing
 * laws use `radii` (a kernel that does not read it refuses).
 */

import { round6 } from '../../lib/compactNumber';
import type { CadDocument, EdgeRadius, ShapeRecipe, Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop } from '../noop';
import { selectEdges } from './edgeSelection';
import { type EdgeLawInput, type FilletMode, chordToRadius, lawOf, lawProblem, sameLaw, scaleLaw, wedgeAngle } from './filletSpec';
import { commitKernelResult, evaluateRecipe, operandRecipe } from './kernelShape';
import { modifyFailure, validateSolidTarget } from './modifyTarget';
import { hasNames, namesOf, referenceProblem, resolveNames } from '../../geometry/naming/references';
import { commandError } from '../noop';
import { REPICK_EDGES } from './edgeReferences';

export interface FilletRequest {
  readonly id: string;
  readonly mode: FilletMode;
  readonly edges: readonly EdgeLawInput[] | undefined;
  readonly edgeIndices: readonly number[];
  readonly edgesNear: readonly Vec3[];
  readonly radius: number | undefined;
  readonly radiusEnd: number | undefined;
  /** Persistent names of the planned edges, in plan order, recorded by an earlier run (SC-N1). */
  readonly edgeNames?: readonly string[] | undefined;
}

interface Planned {
  readonly edge: number;
  readonly law: EdgeRadius;
}

type Resolution = { readonly planned: Planned[] } | { readonly problem: string };

/** Edge index of each `edges` entry (index, or the roundable edge nearest `near`) with its law. */
function resolveEntries(topology: ShapeTopology | null, entries: readonly EdgeLawInput[]): Resolution {
  const planned: Planned[] = [];
  for (const [position, entry] of entries.entries()) {
    if ((entry.index === undefined) === (entry.near === undefined))
      return { problem: `edges[${position}] needs exactly one of index or near` };
    const law = lawOf(entry);
    const bad = lawProblem(law);
    if (bad !== null) return { problem: `edges[${position}]: ${bad}` };
    const picked = selectEdges(topology, entry.index === undefined ? [] : [entry.index], entry.near === undefined ? [] : [entry.near]);
    const edge = 'problem' in picked ? undefined : picked.edges[0];
    if (edge === undefined) return { problem: `edges[${position}]: ${'problem' in picked ? picked.problem : 'no edge found'}` };
    if (planned.some((other) => other.edge === edge))
      return { problem: `edges[${position}] selects edge ${edge}, already given by another entry` };
    planned.push({ edge, law });
  }
  return { planned };
}

/** The shorthand selection (indices + near points, all roundable edges when empty) with the one `radius` law. */
function resolveShorthand(topology: ShapeTopology | null, request: FilletRequest): Resolution {
  const { radius, radiusEnd } = request;
  if (radius === undefined) return { problem: 'give radius, or edges with one size per edge' };
  const law: EdgeRadius = { size: radius, ...(radiusEnd === undefined ? {} : { sizeEnd: radiusEnd }) };
  const bad = lawProblem(law);
  if (bad !== null) return { problem: bad };
  const picked = selectEdges(topology, request.edgeIndices, request.edgesNear);
  if ('problem' in picked) return { problem: picked.problem };
  const every =
    picked.edges.length === 0
      ? (topology?.edges ?? []).filter((edge) => !edge.seam && !edge.degenerate).map((edge) => edge.index)
      : picked.edges;
  return { planned: every.map((edge) => ({ edge, law })) };
}

/** Chord laws turned into radius laws from the wedge angle of the two planar faces at each edge. */
function chordsToRadii(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  topology: ShapeTopology | null,
  planned: readonly Planned[],
): { readonly planned: Planned[] } | { readonly problem: string } {
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  if (topology === null || graph === null)
    return { problem: 'mode "chord" needs the exact face adjacency of an exact kernel (the mesh kernel has none)' };
  const converted: Planned[] = [];
  for (const { edge, law } of planned) {
    const faces = graph.edgeFaces[edge] ?? [];
    const normals = faces.map((face) => topology.faces[face]?.normal);
    const [a, b] = normals;
    if (faces.length !== 2 || a === undefined || b === undefined)
      return {
        problem: `mode "chord" needs two planar faces at edge ${edge} (found ${faces.length} face(s), ${normals.filter(Boolean).length} planar)`,
      };
    const factor = chordToRadius(1, wedgeAngle(a, b));
    if (!Number.isFinite(factor))
      return { problem: `edge ${edge} joins faces that are tangent or folded flat (no corner to take a chord from)` };
    converted.push({ edge, law: scaleLaw(law, factor) });
  }
  return { planned: converted };
}

function recipeOfPlan(source: ShapeRecipe, planned: readonly Planned[], topology: ShapeTopology | null): ShapeRecipe {
  const edges = planned.map((entry) => entry.edge);
  const mids = planned.map((entry) => topology?.edges[entry.edge]?.mid);
  const near = mids.every((mid): mid is Vec3 => mid !== undefined) ? { near: mids } : {};
  const [first] = planned;
  const uniform = first !== undefined && planned.every((entry) => sameLaw(entry.law, first.law)) && first.law.sizes === undefined;
  if (uniform)
    return {
      op: 'fillet',
      source,
      edges,
      size: first.law.size,
      ...(first.law.sizeEnd === undefined ? {} : { sizeEnd: first.law.sizeEnd }),
      ...near,
    };
  return { op: 'fillet', source, edges, size: 0, radii: planned.map((entry) => entry.law), ...near };
}

const lawText = (law: EdgeRadius): string =>
  `${round6(law.size)}${law.sizeEnd === undefined ? '' : `>${round6(law.sizeEnd)}`}${law.sizes === undefined ? '' : ` via ${law.sizes.length} control point(s)`}`;

/**
 * `request` with its edges taken from the recorded persistent names (one per planned edge, plan order), or why they no longer resolve;
 * unchanged when there are no names or the kernel keeps none.
 */
function byRecordedNames(
  topology: ShapeTopology | null,
  request: FilletRequest,
): FilletRequest | { readonly problem: string; readonly code: string } {
  const names = request.edgeNames ?? [];
  if (names.length === 0 || !hasNames(topology, 'edge')) return request;
  const resolved = resolveNames(topology, 'edge', names);
  if (!resolved.ok)
    return { problem: `${referenceProblem('edge', resolved)}. ${REPICK_EDGES}`, code: resolved.lost.length > 0 ? 'REF_LOST' : 'REF_SPLIT' };
  if (request.edges === undefined) return { ...request, edgeIndices: resolved.indices, edgesNear: [] };
  if (resolved.indices.length !== request.edges.length) return request;
  return {
    ...request,
    edges: request.edges.map(
      (entry, at): EdgeLawInput => ({
        size: entry.size,
        index: resolved.indices[at] ?? 0,
        ...(entry.sizeEnd === undefined ? {} : { sizeEnd: entry.sizeEnd }),
        ...(entry.sizes === undefined ? {} : { sizes: entry.sizes }),
      }),
    ),
  };
}

/**
 * @failure missing / non-solid target, no kernel, entry without exactly one of index/near, bad radius law, repeated or unroundable edge,
 *   chord mode without exact planar faces at an edge, kernel refusal -> unchanged doc
 */
export function filletEach(doc: CadDocument, ctx: ExecutionContext | undefined, request: FilletRequest): CommandResult {
  const fail = (why: string): CommandResult => noop(doc, `fillet_edge: ${why}; document unchanged.`);
  if (request.edges !== undefined && (request.edgeIndices.length > 0 || request.edgesNear.length > 0 || request.radius !== undefined))
    return fail('give either edges (one size per edge) or the radius / edgeIndices / edgesNear shorthand, not both');
  if (request.edges !== undefined && request.edges.length === 0) return fail('edges must not be empty');
  const validation = validateSolidTarget(doc, 'fillet_edge', request.id);
  if ('summary' in validation) return validation;
  const { entity } = validation;
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable('fillet_edge'));
  const source = operandRecipe(kernel, entity);
  const shape = kernel.evaluate(source);
  if (shape === null) return fail(`kernel could not build entity '${request.id}' (kind '${entity.kind}')`);
  const topology = kernel.topology(shape);
  const named = byRecordedNames(topology, request);
  if ('problem' in named)
    return { ...fail(`${named.problem} on '${request.id}'`), error: commandError(named.code, REPICK_EDGES, [], ['edgeNames']) };
  const resolved = named.edges === undefined ? resolveShorthand(topology, named) : resolveEntries(topology, named.edges);
  if ('problem' in resolved) return fail(`${resolved.problem} on '${request.id}'`);
  const validated = selectEdges(
    topology,
    resolved.planned.map((entry) => entry.edge),
    [],
  );
  if ('problem' in validated) return fail(`${validated.problem} on '${request.id}'`);
  if (resolved.planned.length === 0) return fail(`'${request.id}' has no roundable edge`);
  const sized = request.mode === 'chord' ? chordsToRadii(kernel, shape, topology, resolved.planned) : resolved;
  if ('problem' in sized) return fail(`${sized.problem} on '${request.id}'`);
  const modified = recipeOfPlan(source, sized.planned, topology);
  const result = evaluateRecipe(kernel, modified);
  if (typeof result === 'string') return noop(doc, modifyFailure('fillet_edge', kernel, modified, result));
  const list = sized.planned.map((entry) => `${entry.edge}: r ${lawText(entry.law)}`).join(', ');
  const chord = request.mode === 'chord' ? ' (sizes given as chord lengths, converted to radii)' : '';
  const committed = commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `fillet_edge: filleted '${request.id}' (kind '${entity.kind}', ${sized.planned.length} edge(s) ${list}${chord}) → mesh '${newId}' (${triangles} triangles). Source entity consumed.`,
  );
  const record =
    (request.edgeNames ?? []).length > 0
      ? null
      : namesOf(
          topology,
          'edge',
          sized.planned.map((entry) => entry.edge),
        );
  return record === null || committed.document === doc ? committed : { ...committed, recordExtras: { edgeNames: record } };
}
