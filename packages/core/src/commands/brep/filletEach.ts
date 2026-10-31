/**
 * fillet_edge with per-edge radius laws and chord-length sizing (SC-F3, BLD M1): resolves each entry to a unique-edge index and a radius law
 * (explicit, linear, or an expression sampled deterministically), checks closed edges for a periodic law, converts chords to radii from the
 * faces at the edge (planar closed form, or sampled wedge angles on curved faces), and builds one fillet node. Uniform laws keep the
 * single-`size` recipe form every kernel reads; differing laws use `radii` (a kernel that does not read it refuses).
 */

import { round6 } from '../../lib/compactNumber';
import type { CadDocument, EdgeRadius, ShapeRecipe, Vec3 } from '../../model/types';
import type { ShapeTopology } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop } from '../noop';
import { selectEdges } from './edgeSelection';
import { type EdgeLawInput, type FilletMode, sameLaw } from './filletSpec';
import { chordsToRadii } from './filletChord';
import { type LawProblem, closedEdge, isLawProblem, periodicProblem, resolveLaw } from '../../geometry/blend/law';
import { blendRejection } from './blendCodes';
import { findKink, kinkRefusal, kinkReported } from './filletTangency';
import {
  type PlannedProfile,
  type ProfileInput,
  type ProfileRefusal,
  isProfileRefusal,
  prepareProfile,
  profileText,
  resolveProfile,
} from './filletProfile';
import type { BlendProfile } from '../../model/blendTypes';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { validateSolidTarget } from './modifyTarget';
import { blendRefusal } from './blendRefusal';
import { hasNames, namesOf, referenceProblem, resolveNames } from '../../geometry/naming/references';
import { commandError } from '../noop';
import { REPICK_EDGES } from './edgeReferences';
import { describeProfileNotes, readProfileNotes } from './profileNotes';
import { type CornerInput, type CornerRefusal, REPICK_VERTICES, resolveCorners } from './filletCorners';
import type { SetbackCorner } from '../../model/blendTypes';

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
  readonly profile?: ProfileInput | undefined;
  /** Corner treatments (BLD M3): setback corners; vertices without an entry keep the kernel's rolling-ball corner. */
  readonly corners?: readonly CornerInput[] | undefined;
  /** Build a fillet whose new blend meets an earlier blend without tangency (the finding is reported, not refused). */
  readonly allowNonTangent?: boolean | undefined;
}

interface Planned {
  readonly edge: number;
  readonly law: EdgeRadius;
  /** Where the face carrying the first leg is named (an entry with size2). */
  readonly side?: { readonly near?: Vec3 | undefined; readonly name?: string | undefined } | undefined;
  /** Position of the `edges` entry the plan came from (param paths); absent for the radius shorthand. */
  readonly entry?: number;
}

/** A refusal with a stable code: its message, the code, and the param path below the request (`edges[1].law.expression`, `radius`). */
interface Refusal {
  readonly code: LawProblem['code'] | 'BLD_CHORD_UNDEFINED';
  readonly message: string;
  readonly path: string;
}

type Resolution = { readonly planned: Planned[] } | { readonly problem: string } | { readonly refusal: Refusal };

const SHORTHAND_PATHS: Readonly<Record<string, string>> = { size: 'radius', sizeEnd: 'radiusEnd' };

/** Edge index of each `edges` entry (index, or the roundable edge nearest `near`) with its law. */
function resolveEntries(topology: ShapeTopology | null, entries: readonly EdgeLawInput[]): Resolution {
  const planned: Planned[] = [];
  for (const [position, entry] of entries.entries()) {
    if ((entry.index === undefined) === (entry.near === undefined))
      return { problem: `edges[${position}] needs exactly one of index or near` };
    const law = resolveLaw(entry);
    if (isLawProblem(law)) return { refusal: { ...law, path: `edges[${position}].${law.path}` } };
    const picked = selectEdges(topology, entry.index === undefined ? [] : [entry.index], entry.near === undefined ? [] : [entry.near]);
    const edge = 'problem' in picked ? undefined : picked.edges[0];
    if (edge === undefined) return { problem: `edges[${position}]: ${'problem' in picked ? picked.problem : 'no edge found'}` };
    if (planned.some((other) => other.edge === edge))
      return { problem: `edges[${position}] selects edge ${edge}, already given by another entry` };
    planned.push({ edge, law, entry: position, side: { near: entry.side1Near, name: entry.side1Name } });
  }
  return { planned };
}

/** The shorthand selection (indices + near points, all roundable edges when empty) with the one `radius` law. */
function resolveShorthand(topology: ShapeTopology | null, request: FilletRequest): Resolution {
  const { radius, radiusEnd } = request;
  if (radius === undefined) return { problem: 'give radius, or edges with one size per edge' };
  const law = resolveLaw({ size: radius, sizeEnd: radiusEnd });
  if (isLawProblem(law))
    return {
      refusal: {
        ...law,
        message: law.message.replace(/^sizeEnd/, 'radiusEnd').replace(/^size /, 'radius '),
        path: SHORTHAND_PATHS[law.path] ?? law.path,
      },
    };
  const picked = selectEdges(topology, request.edgeIndices, request.edgesNear);
  if ('problem' in picked) return { problem: picked.problem };
  const every =
    picked.edges.length === 0
      ? (topology?.edges ?? []).filter((edge) => !edge.seam && !edge.degenerate).map((edge) => edge.index)
      : picked.edges;
  return { planned: every.map((edge) => ({ edge, law })) };
}

/** The first closed edge (a rim) whose law does not close on itself (r(0) = r(1)), as a refusal. */
function openLawOnClosedEdge(topology: ShapeTopology | null, planned: readonly Planned[]): Refusal | null {
  for (const { edge, law, entry } of planned) {
    const shape = topology?.edges[edge];
    const problem = shape !== undefined && closedEdge(shape) ? periodicProblem(law) : null;
    if (problem !== null)
      return {
        ...problem,
        message: `edge ${edge}: ${problem.message}`,
        path: entry === undefined ? (SHORTHAND_PATHS[problem.path] ?? problem.path) : `edges[${entry}].${problem.path}`,
      };
  }
  return null;
}

function recipeOfPlan(
  source: ShapeRecipe,
  planned: readonly Planned[],
  topology: ShapeTopology | null,
  profile: BlendProfile | undefined,
  corners: readonly SetbackCorner[],
): ShapeRecipe {
  const edges = planned.map((entry) => entry.edge);
  const mids = planned.map((entry) => topology?.edges[entry.edge]?.mid);
  const near = mids.every((mid): mid is Vec3 => mid !== undefined) ? { near: mids } : {};
  const [first] = planned;
  const uniform =
    first !== undefined &&
    planned.every((entry) => sameLaw(entry.law, first.law)) &&
    first.law.sizes === undefined &&
    first.law.interpolation === undefined &&
    first.law.size2 === undefined;
  const profiled = { ...(profile === undefined ? {} : { profile }), ...(corners.length === 0 ? {} : { corners: [...corners] }) };
  if (uniform)
    return {
      op: 'fillet',
      source,
      edges,
      size: first.law.size,
      ...(first.law.sizeEnd === undefined ? {} : { sizeEnd: first.law.sizeEnd }),
      ...near,
      ...profiled,
    };
  return { op: 'fillet', source, edges, size: 0, radii: planned.map((entry) => entry.law), ...near, ...profiled };
}

const lawText = (law: EdgeRadius): string =>
  `${round6(law.size)}${law.size2 === undefined ? '' : ` x ${round6(law.size2)}`}${law.sizeEnd === undefined ? '' : `>${round6(law.sizeEnd)}`}${law.sizes === undefined ? '' : ` via ${law.sizes.length} ${law.interpolation === 'linear' ? 'straight' : law.interpolation === 'monotone' ? 'monotone' : 'smooth'} control point(s)`}`;

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
    edges: request.edges.map((entry, at): EdgeLawInput => ({ ...entry, index: resolved.indices[at] ?? 0, near: undefined })),
  };
}

/** The refusal of a corner that cannot be resolved: a lost / split vertex (with the way to re-pick it) or a corner this build cannot make. */
function cornerRefusal(doc: CadDocument, id: string, refusal: CornerRefusal): CommandResult {
  if (refusal.code === 'BLD_CORNER_UNSUPPORTED')
    return blendRejection(doc, 'fillet_edge', refusal.code, refusal.message, [id], [refusal.path]);
  return {
    ...noop(doc, `fillet_edge: ${refusal.message} on '${id}'; document unchanged.`),
    error: commandError(refusal.code, REPICK_VERTICES, [id], [refusal.path]),
  };
}

/**
 * @failure missing / non-solid target, no kernel, entry without exactly one of index/near, repeated or unroundable edge, chord mode without
 *   face adjacency, kernel refusal -> unchanged doc; bad law -> BLD_LAW_INVALID; open law on a closed edge -> BLD_LAW_NOT_PERIODIC; tangent faces
 *   in chord mode -> BLD_CHORD_UNDEFINED
 */
export function filletEach(doc: CadDocument, ctx: ExecutionContext | undefined, request: FilletRequest): CommandResult {
  const fail = (why: string): CommandResult => noop(doc, `fillet_edge: ${why}; document unchanged.`);
  const refuse = (refusal: Refusal | ProfileRefusal): CommandResult =>
    blendRejection(doc, 'fillet_edge', refusal.code, `${refusal.message} (${refusal.path})`, [request.id], [refusal.path]);
  const profile = resolveProfile(request.profile);
  if (isProfileRefusal(profile)) return refuse(profile);
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
  if ('refusal' in resolved) return refuse(resolved.refusal);
  if ('problem' in resolved) return fail(`${resolved.problem} on '${request.id}'`);
  const validated = selectEdges(
    topology,
    resolved.planned.map((entry) => entry.edge),
    [],
  );
  if ('problem' in validated) return fail(`${validated.problem} on '${request.id}'`);
  if (resolved.planned.length === 0) return fail(`'${request.id}' has no roundable edge`);
  const open = openLawOnClosedEdge(topology, resolved.planned);
  if (open !== null) return refuse(open);
  const sized = request.mode === 'chord' ? chordsToRadii(kernel, shape, topology, resolved.planned) : resolved;
  if ('problem' in sized) {
    const message = `${sized.problem} on '${request.id}'`;
    return 'code' in sized && sized.code !== undefined ? refuse({ code: sized.code, message, path: 'mode' }) : fail(message);
  }
  const profiled = profile.profile !== undefined || sized.planned.some((entry) => entry.law.size2 !== undefined);
  const cornered =
    request.corners === undefined
      ? null
      : resolveCorners(topology, sized.planned, request.corners, profile.profile !== undefined && profile.profile.type !== 'circular');
  if (cornered !== null && 'problem' in cornered) return fail(`${cornered.problem} on '${request.id}'`);
  if (cornered !== null && 'refusal' in cornered) return cornerRefusal(doc, request.id, cornered.refusal);
  const prepared = profiled ? prepareProfile(kernel, shape, topology, sized.planned as PlannedProfile[]) : null;
  if (prepared !== null && isProfileRefusal(prepared)) return refuse(prepared);
  const plan = prepared === null ? sized.planned : (prepared.planned as Planned[]);
  const corners = cornered === null ? [] : cornered.corners;
  const modified = recipeOfPlan(source, plan, topology, profile.profile, corners);
  const result = evaluateRecipe(kernel, modified);
  if (typeof result === 'string') return blendRefusal(doc, 'fillet_edge', request.id, kernel, modified, result, topology);
  const list = plan.map((entry) => `${entry.edge}: r ${lawText(entry.law)}`).join(', ');
  const section = profileText(profile.profile);
  const rounded = corners.length === 0 ? '' : `, ${corners.length} setback corner(s)`;
  const chord = request.mode === 'chord' ? ' (sizes given as chord lengths, converted to radii)' : '';
  const committed = commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `fillet_edge: filleted '${request.id}' (kind '${entity.kind}', ${plan.length} edge(s) ${list}${section}${rounded}${chord}) → mesh '${newId}' (${triangles} triangles). Source entity consumed.`,
  );
  const kink = findKink(doc, committed, source, ctx);
  if (kink !== null && request.allowNonTangent !== true)
    return kinkRefusal(doc, 'fillet_edge', request.id, kink, request.edges === undefined ? 'radius' : 'edges');
  // how a profile blend was made (builder, measured gap, a reported fallback, corner setbacks): in the summary and in `data`
  const notes = profiled && committed.document !== doc ? readProfileNotes(kernel, modified) : null;
  const described = notes === null ? null : describeProfileNotes(notes, topology, doc.units);
  const profiledResult: CommandResult =
    described === null ? committed : { ...committed, summary: `${committed.summary}${described.text}`, data: { profile: described.data } };
  const reported = kink === null ? profiledResult : kinkReported(profiledResult, kink);
  const record =
    (request.edgeNames ?? []).length > 0
      ? null
      : namesOf(
          topology,
          'edge',
          sized.planned.map((entry) => entry.edge),
        );
  const cornerRecord = cornered === null ? null : cornered.record;
  if (committed.document === doc || (record === null && cornerRecord === null)) return reported;
  return {
    ...reported,
    recordExtras: { ...(record === null ? {} : { edgeNames: record }), ...(cornerRecord === null ? {} : { corners: cornerRecord }) },
  };
}
