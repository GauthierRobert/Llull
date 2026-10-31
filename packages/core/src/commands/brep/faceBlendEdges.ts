/**
 * fillet_faces over faces that meet (BLD M4 remainder, TECHNICAL_SPEC 13.13): each set may hold several faces, planar or curved. Every sharp
 * edge shared by a face of facesA and a face of facesB is a blend edge; the blend is fillet_edge's (radius laws, chord width, profile), so the
 * contact lines, the laws and the checks are the ones of the edge path. The kernel rounds the whole tangent chain of every picked edge, and
 * its chain is the truth: the built result is read back (the new blend faces, by name, with their support faces) and refused when a blend
 * rests on a face outside facesA and facesB, or when a varying size ran over more than one edge.
 * @invariant the blend never rounds a face outside facesA and facesB; a varying size runs over one edge or one tangent chain of the shared edges (faceBlendChain.ts: one sub-law per edge); the kernel's chain may not be longer than the shared edges
 * @failure no shared edge (and no flat spandrel build), a built chain that leaves the sets, a varying size over several chains, a branch or a bend at a joint, startNear on a closed edge, a kernel without face adjacency -> BLD_FACE_BLEND_UNSUPPORTED
 */

import { round6 } from '../../lib/compactNumber';
import { distance3 } from '../../lib/vec3';
import type { CadDocument, Vec3 } from '../../model/types';
import { blendSource, cornerSources } from '../../geometry/blend/continuity';
import { closedEdge, isLawProblem, resolveLaw, reverseLaw } from '../../geometry/blend/law';
import type { CommandResult, ExecutionContext } from '../types';
import type { EdgeLawInput } from './filletSpec';
import { type BlendBuild, type BlendContext, faceBlendData, pickedFaces } from './faceBlendRun';
import { blendRejection } from './blendCodes';
import { filletEach } from './filletEach';
import { type ChainEdge, chainLaws, planChain } from './faceBlendChain';
import type { ProfileInput } from './filletProfile';

export type SizeLaw = NonNullable<EdgeLawInput['law']>;

export interface EdgeBlendRequest {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext | undefined;
  readonly id: string;
  readonly profile: ProfileInput | undefined;
  readonly size: { readonly start: number; readonly end: number | undefined; readonly law: SizeLaw | undefined; readonly chord: boolean };
  /** A point near the end of the blend edge where the size is `start` (t = 0 of the law); the edge's own direction when absent. */
  readonly startNear: Vec3 | undefined;
  /** The flat spandrel build, used when the sets share no sharp edge (absent when the request needs the edge path). */
  readonly spandrel: (() => BlendBuild) | undefined;
}

/** Most out-of-set chain edges named in a refusal message. */
const MAX_LISTED = 10;

const unsupported = (message: string, path: string): BlendBuild => ({ code: 'BLD_FACE_BLEND_UNSUPPORTED', message, path });

/** Whether one planar face against one planar face of the picked sets (the flat spandrel build's inputs). */
export function onePlanarFaceEach(context: BlendContext): boolean {
  const [a, b] = [pickedFaces(context, 'facesA'), pickedFaces(context, 'facesB')];
  const planar = (face: number | undefined): boolean => face !== undefined && context.topology?.faces[face]?.normal !== undefined;
  return a.length === 1 && b.length === 1 && planar(a[0]) && planar(b[0]);
}

/** The points of `edge` at t = 0 and t = 1, or null when the kernel cannot sample it. */
function edgeEnds(context: BlendContext, edge: number): [Vec3, Vec3] | null {
  const samples = context.kernel.faceQuery?.edgeSamples(context.shape, edge, 2) ?? null;
  const first = samples?.[0];
  const last = samples?.[samples.length - 1];
  return first === undefined || last === undefined ? null : [first.point, last.point];
}

/** The fillet_faces param a fillet_edge param path is about. */
function facesPath(path: string, chord: boolean, lawGiven: boolean): string {
  if (/^edges\[\d+\]\.law\b/.test(path)) return path.replace(/^edges\[\d+\]\./, '');
  if (/^edges\[\d+\]\.sizeEnd$/.test(path)) return lawGiven ? 'law' : chord ? 'widthEnd' : 'radiusEnd';
  if (/^edges\[\d+\]\.size$/.test(path)) return chord ? 'width' : 'radius';
  return path === 'mode' ? 'width' : path;
}

/** What an edge-path result is read back with. */
export interface EdgeResultRead {
  readonly doc: CadDocument;
  readonly context: BlendContext;
  /** The edges handed to fillet_edge. */
  readonly seeds: readonly number[];
  /** Whether the size varies along the edge (it must then run over exactly one edge). */
  readonly varying: boolean;
  /** The param a varying size is refused at. */
  readonly varyingPath: string;
  /** Maps a fillet_edge param path to the path of this command. */
  readonly rename: (path: string) => string;
  /** Whether the single blend edge is listed from its other end (startNear). */
  readonly flipped: boolean;
  /** A size law over a chain of several edges (13.27): the walking order; the kernel's chain may be at most these edges. */
  readonly chain?: readonly ChainEdge[] | undefined;
}

/**
 * The result of fillet_edge, read back as a face-blend result: refusals renamed to this command's params; the new blend faces (the kernel's
 * chain) checked against the sets and the size; `data` with the blend faces and the chain edges with their ends.
 */
export function readEdgeResult(result: CommandResult, read: EdgeResultRead): BlendBuild {
  const { doc, context, seeds } = read;
  const renamed = new Map((result.error?.paths ?? []).map((path) => [path, read.rename(path)] as const));
  let summary = result.summary.replace(/^fillet_edge/, 'fillet_faces');
  for (const [from, to] of renamed) summary = summary.replace(`(${from})`, `(${to})`);
  const mapped =
    result.error === undefined ? {} : { error: { ...result.error, paths: result.error.paths?.map((path) => renamed.get(path) ?? path) } };
  const created = result.document === doc ? undefined : result.affected[0];
  if (created === undefined) return { result: { ...result, ...mapped, summary } };
  const entity = result.document.entities[created];
  const brep = entity?.kind === 'mesh' ? entity.brep : undefined;
  const shape = brep === undefined ? null : context.kernel.evaluate(brep);
  const after = shape === null ? null : context.kernel.topology(shape);
  const before = context.topology;
  const known = new Set((before?.faces ?? []).map((face) => face.name));
  const added = (after?.faces ?? []).filter((face) => face.name !== undefined && !known.has(face.name));
  const chain = added.flatMap((face) => {
    const source = face.name === undefined ? null : blendSource(face.name);
    return source === null ? [] : [source];
  });
  const unnamedCount = (faces: readonly { name?: string | undefined }[] | undefined): number =>
    (faces ?? []).filter((face) => face.name === undefined).length;
  const unnamed = unnamedCount(after?.faces) > unnamedCount(before?.faces);
  const corners = added.some((face) => face.name !== undefined && cornerSources(face.name) !== null);
  if (after === null || unnamed || (added.length > 0 && chain.length === 0 && !corners))
    return unsupported(
      "cannot read the kernel's chain: the result has new faces that are not named blend faces (or none), so it cannot be checked against facesA and facesB",
      'facesA',
    );
  const allowed = new Set([...pickedFaces(context, 'facesA'), ...pickedFaces(context, 'facesB')].map((face) => before?.faces[face]?.name));
  const indexOf = (name: string): number | undefined => before?.edges.find((edge) => edge.name === name)?.index;
  const strays = chain.flatMap((source) => {
    const outside = source.supports.filter((name) => !allowed.has(name));
    return outside.length === 0 ? [] : [`edge ${indexOf(source.edge) ?? source.edge} (bounds ${outside.join(', ')})`];
  });
  if (strays.length > 0)
    return unsupported(
      `rounding the shared edge(s) ${seeds.join(', ')} also rounds their tangent chain, which rests on faces outside facesA and facesB: ${strays.slice(0, MAX_LISTED).join('; ')}${strays.length > MAX_LISTED ? `; and ${strays.length - MAX_LISTED} more` : ''}; add those faces to the sets or blend edges whose chain stays inside them`,
      'facesA',
    );
  const edges = [...new Set(chain.flatMap((source) => indexOf(source.edge) ?? []))].sort((a, b) => a - b);
  const blended = edges.length === 0 ? [...seeds] : edges;
  const chained = new Set(chain.map((source) => source.edge)).size;
  if (read.varying && chained > (read.chain?.length ?? 1))
    return unsupported(
      `a varying size needs the blend to be exactly one edge; the kernel rounded a chain of ${chained} edges (${blended.join(', ')}) from the shared edge(s) ${seeds.join(', ')} (t runs along an edge, not along a chain)`,
      read.varyingPath,
    );
  const listed =
    read.chain === undefined
      ? blended.map((index) => ({ index, flip: read.flipped && blended.length === 1 }))
      : read.chain.map((entry) => ({ index: entry.index, flip: !entry.forward }));
  const blendEdges = listed.map(({ index, flip }) => {
    const own = edgeEnds(context, index);
    return { index, start: flip ? own?.[1] : own?.[0], end: flip ? own?.[0] : own?.[1] };
  });
  const where = (point: Vec3 | undefined): string => (point === undefined ? '?' : `(${point.map(round6).join(', ')})`);
  const list = blendEdges.map((entry) => `${entry.index} ${where(entry.start)} -> ${where(entry.end)}`).join('; ');
  return {
    result: {
      ...result,
      summary: `${summary} Blend edges (shared by facesA and facesB, with the kernel's tangent chain), size at t = 0 first: ${list}.`,
      data: { ...(result.data as object | undefined), ...faceBlendData(before, after, created, doc.units), blendEdges },
    },
  };
}

/** `entry` with its size / law run from the other end of the edge; unchanged when its law does not resolve (fillet_edge then says why). */
function reversedEntry(entry: EdgeLawInput): EdgeLawInput {
  const resolved = resolveLaw(entry);
  if (isLawProblem(resolved)) return entry;
  const { size, sizeEnd, sizes, interpolation } = reverseLaw(resolved);
  return {
    ...(entry.index === undefined ? {} : { index: entry.index }),
    size,
    ...(sizeEnd === undefined ? {} : { sizeEnd }),
    ...(sizes === undefined ? {} : { sizes: sizes.map((point) => ({ t: point.t, size: point.size })) }),
    ...(interpolation === undefined ? {} : { interpolation }),
  };
}

/** The blend of a tangent chain of shared edges with ONE size law over its total arc length (13.27): one sub-law per edge, continuous at the joints. */
function chainBlend(request: EdgeBlendRequest, context: BlendContext, seeds: readonly number[], varyingPath: string): BlendBuild {
  const { size } = request;
  const plan = planChain(context, seeds, request.startNear, varyingPath);
  if ('problem' in plan) return unsupported(plan.problem, plan.path);
  const laws = chainLaws(plan, { start: size.start, end: size.end, law: size.law }, varyingPath);
  if ('code' in laws) return { result: blendRejection(request.doc, 'fillet_faces', laws.code, laws.message, [request.id], [laws.path]) };
  const result: CommandResult = filletEach(request.doc, request.ctx, {
    id: request.id,
    mode: size.chord ? 'chord' : 'radius',
    edges: laws,
    edgeIndices: [],
    edgesNear: [],
    radius: undefined,
    radiusEnd: undefined,
    profile: request.profile,
  });
  return readEdgeResult(result, {
    doc: request.doc,
    context,
    seeds,
    varying: true,
    varyingPath,
    rename: (path) => facesPath(path, size.chord, size.law !== undefined),
    flipped: false,
    chain: plan.edges,
  });
}

/** The blend of the edges the two sets share, as the result of fillet_edge with the same sizes. */
export function edgeBlend(request: EdgeBlendRequest, context: BlendContext): BlendBuild {
  const { size } = request;
  const [a, b] = [pickedFaces(context, 'facesA'), pickedFaces(context, 'facesB')];
  const graph = context.kernel.faceQuery?.faceGraph(context.shape) ?? null;
  const smooth = (edge: number): boolean => graph?.edgeConvexity[edge] === 'smooth';
  const topology = context.topology;
  const seeds = (graph?.edgeFaces ?? []).flatMap((around, edge) => {
    const info = topology?.edges[edge];
    const sharp = info !== undefined && !info.seam && !info.degenerate && !smooth(edge);
    return sharp && around.some((face) => a.includes(face)) && around.some((face) => b.includes(face)) ? [edge] : [];
  });
  if (seeds.length === 0)
    return request.spandrel !== undefined
      ? request.spandrel()
      : unsupported(
          graph === null
            ? 'the kernel reports no face adjacency'
            : 'facesA and facesB share no sharp edge: faces that do not meet are blended with a constant radius or a straight taper (radius, radiusEnd; the faces between them are consumed); a law or a chord width needs a shared edge',
          'facesA',
        );
  const varying = size.end !== undefined || size.law !== undefined;
  const varyingPath = size.law === undefined ? (size.chord ? 'widthEnd' : 'radiusEnd') : 'law';
  const [only] = seeds;
  if (varying && seeds.length > 1) return chainBlend(request, context, seeds, varyingPath);
  const info = only === undefined ? undefined : topology?.edges[only];
  if (varying && request.startNear !== undefined && info !== undefined && closedEdge(info))
    return unsupported(
      `startNear needs an open edge: edge ${only} is closed (a rim), so it has no start end; its seam vertex is at (${info.start.map(round6).join(', ')}). Leave startNear out`,
      'startNear',
    );
  const ends = varying && only !== undefined ? edgeEnds(context, only) : null;
  const flipped =
    request.startNear !== undefined && ends !== null && distance3(request.startNear, ends[1]) < distance3(request.startNear, ends[0]);
  const base: EdgeLawInput[] = seeds.map((index) => ({
    index,
    ...(size.law === undefined ? { size: size.start, ...(size.end === undefined ? {} : { sizeEnd: size.end }) } : { law: size.law }),
  }));
  const result: CommandResult = filletEach(request.doc, request.ctx, {
    id: request.id,
    mode: size.chord ? 'chord' : 'radius',
    edges: flipped ? base.map(reversedEntry) : base,
    edgeIndices: [],
    edgesNear: [],
    radius: undefined,
    radiusEnd: undefined,
    profile: request.profile,
  });
  return readEdgeResult(result, {
    doc: request.doc,
    context,
    seeds,
    varying,
    varyingPath,
    rename: (path) => facesPath(path, size.chord, size.law !== undefined),
    flipped,
  });
}
