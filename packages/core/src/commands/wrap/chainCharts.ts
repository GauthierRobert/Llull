/**
 * Charts of a chain of faces (03 WRP M5, multi-face wraps): the faces are unfolded one after another across the edges they share, so one sketch plane covers the whole chain.
 * Plane, cylinder and cone faces develop without stretch; an edge between two of them joins the charts when it develops to the same straight line in both (a generatrix of a cylinder
 * or a ruling of a cone, a straight edge of a plane), which makes the unfolding an isometry along the edge. Sphere and torus faces do not develop: their geodesic charts are anchored on the
 * shared edge with the frame matched there (to first order, parallel transport of the frame along the edge) and the mismatch of the edge points between the two charts is the
 * distortion of the join, held to the named limit (`maxLengthStrain`, share of the edge length). Each face gets a chart with the chain's sketch coordinates (anchored on a point of the shared
 * edge), and the half-planes that keep each face to its own side of every chain edge.
 * @invariant develop (plane, cylinder, cone): lengths and angles are kept inside every face and across every chain edge; with a sphere or torus face the join mismatch is measured (`ChainEdge.mismatch`) and refused above the limit; the edge samples map to the same chain point from both sides (checked to the fit
 *   tolerance), so the chart is continuous
 * @failure a face that is not a plane, cylinder, cone, sphere or torus, a non-developable chain without method geodesic, a join whose edge points disagree between the two charts by more than the limit (WRP_DISTORTION_EXCEEDED), a face not adjacent to the chain, an edge that develops to a curve or to different shapes on its two faces, the kernel unable to
 *   say which side of an edge a face lies on -> coded rejection (WRP_CHAIN_FACE_UNSUPPORTED, WRP_CHAIN_NOT_ADJACENT, WRP_CHAIN_EDGE_CURVED, WRP_CHAIN_CLIP_FAILED)
 */

import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import type { ChartMethod, FaceChart } from '../../geometry/chartFrame';
import { buildChart } from '../../geometry/faceChart';
import { distance3 } from '../../lib/vec3';
import type { CommandResult, ExecutionContext } from '../types';
import { wrapRejection } from './codes';
import type { HalfPlane } from './clipRegions';
import { isRejection, openFace, type FaceRefInput, type FaceSession, type ResolvedChart } from './faceSession';
import { childChart, chartCoordinates, dist2, edgeScale, straightness, type Candidate } from './chainGeometry';

const SAMPLES = 17;
const MAX_CHAIN_FACES = 16;

export interface ChainFace {
  readonly session: FaceSession;
  readonly chart: FaceChart;
  /** +1 when the outward normal of the solid agrees with the surface's Su x Sv, -1 when it opposes it. */
  readonly orientation: 1 | -1;
  /** The half-planes (chain sketch coordinates) that keep the sketch to this face's side of each chain edge. */
  readonly clips: HalfPlane[];
  /** A point inside the face, to find it again in a solid changed by an earlier face of the chain. */
  readonly probe: Vec3;
  /** How far (document units) the chain's chart of this face can put a point of a shared edge off the face: the mismatch of its geodesic joins, 0 for developable faces. */
  readonly slack: number;
  /** The joined stretches (3D points) of the shared edges of the geodesic joins: only probes near them get `slack` as extra tolerance. */
  readonly joins: Vec3[][];
}

export interface ChainEdge {
  /** Disagreement of the two charts of the join over the window and at every point where the sketch crosses the edge, as a share of `windowLength` (0 for developable faces). */
  readonly mismatch: number;
  readonly edge: number;
  readonly faces: readonly [number, number];
  /** The largest distance, document units, between the two charts' images of a point where the sketch crosses the edge (0 for developable faces or no crossing). */
  readonly cutGap: number;
  /** Length of the whole edge (sum of the chords of its samples), document units. */
  readonly length: number;
  /** Length of the stretch of the edge the charts are joined over (its chord in the chain's coordinates). */
  readonly windowLength: number;
  /** The joined stretch of the edge in the chain's coordinates (first and last point) and in the world. */
  readonly line: readonly [Vec2, Vec2];
  readonly world: readonly [Vec3, Vec3];
  readonly convexity: 'convex' | 'concave' | 'smooth' | 'unknown';
}

export interface Chain {
  readonly faces: ChainFace[];
  readonly edges: ChainEdge[];
  /** False when a sphere or torus face is in the chain (geodesic charts, stretch measured). */
  readonly developable: boolean;
  readonly method: ChartMethod;
}

/** How far from its anchor a chart can be trusted: sphere a quarter great circle, torus half a tube turn (both with the 0.8 share the chain keeps clear of the fold); developable charts have no limit. */
const reachOf = (chart: FaceChart): number =>
  chart.kind === 'sphere'
    ? 0.8 * 0.98 * (Math.PI / 2) * (chart.wire.data[9] as number)
    : chart.kind === 'torus'
      ? 0.8 * 0.98 * Math.PI * (chart.wire.data[10] as number)
      : Infinity;

const isDevelopable = (type: string): boolean => type === 'plane' || type === 'cylinder' || type === 'cone';
const isChainSurface = (type: string): boolean => isDevelopable(type) || type === 'sphere' || type === 'torus';
const methodOf = (type: string): ChartMethod => (isDevelopable(type) ? 'develop' : 'geodesic');

/** The refusal text when the two faces share more than one edge: only the first is unfolded. */
const sharedNote = (shared: number): string => (shared > 1 ? ` (the faces share ${shared} edges; only the first is unfolded)` : '');

type Fail = (code: string, message: string, path?: string) => CommandResult;

interface Placement {
  readonly edge: number;
  readonly parent: ChainFace;
}

interface Join extends Placement {
  readonly shared: number;
}

interface JoinEnv {
  readonly doc: CadDocument;
  readonly root: FaceSession;
  readonly tolerance: number;
  readonly limit: number;
  readonly sketch: ReadonlyArray<readonly Vec2[]>;
  readonly graph: NonNullable<ReturnType<FaceSession['query']['faceGraph']>>;
  readonly handedness: 1 | -1;
  readonly placed: ReadonlyMap<number, ChainFace>;
  readonly fail: Fail;
}

interface EdgeWindow {
  readonly all: Vec3[];
  readonly coords: (Vec2 | null)[];
  readonly seed: number;
  readonly low: number;
  readonly high: number;
  readonly at: (k: number) => number;
}

interface Stretch {
  readonly points: Vec3[];
  readonly parentPoints: Vec2[];
  readonly length: number;
  readonly seedAt: number;
  readonly edgeLength: number;
  readonly bend: number;
  readonly allowed: number;
}

interface ChildMatch {
  readonly orientation: 1 | -1;
  readonly matches: Candidate[];
  readonly candidate: Candidate;
}

interface Frame {
  readonly first: Vec2;
  readonly last: Vec2;
  readonly direction: Vec2;
  readonly normal: Vec2;
}

interface ChainJoin {
  readonly parent: ChainFace;
  readonly child: Omit<ChainFace, 'probe'>;
  readonly edge: ChainEdge;
}

const keptByClips = (clips: readonly HalfPlane[], p: Vec2): boolean =>
  clips.every((clip) => (p[0] - clip.point[0]) * clip.normal[0] + (p[1] - clip.point[1]) * clip.normal[1] >= -1e-9);

const sideOfLine = (first: Vec2, last: Vec2, p: Vec2): number =>
  (last[0] - first[0]) * (p[1] - first[1]) - (last[1] - first[1]) * (p[0] - first[0]);

function openChainSessions(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  session: FaceSession,
  refs: readonly FaceRefInput[],
  fail: Fail,
): FaceSession[] | CommandResult {
  if (refs.length + 1 > MAX_CHAIN_FACES)
    return fail('WRP_PARAM_INVALID', `a chain holds at most ${MAX_CHAIN_FACES} faces (got ${refs.length + 1})`);
  const sessions: FaceSession[] = [session];
  for (const [index, ref] of refs.entries()) {
    const opened = openFace(doc, ctx, command, session.entity.id, ref);
    if (isRejection(opened)) return opened;
    if (sessions.some((other) => other.face === opened.face))
      return fail('WRP_PARAM_INVALID', `chain[${index}] is face ${opened.face}, already in the chain`, `chain.${index}`);
    if (!isChainSurface(opened.surface.type))
      return fail(
        'WRP_CHAIN_FACE_UNSUPPORTED',
        `chain[${index}] (face ${opened.face}) is a ${opened.surface.type}: chains unfold plane, cylinder, cone, sphere and torus faces (a freeform face has no edge-continued chart)`,
        `chain.${index}`,
      );
    sessions.push(opened);
  }
  if (!isChainSurface(session.surface.type))
    return fail(
      'WRP_CHAIN_FACE_UNSUPPORTED',
      `face ${session.face} is a ${session.surface.type}: chains unfold plane, cylinder, cone, sphere and torus faces`,
      'face',
    );
  return sessions;
}

function checkChainMethod(developable: boolean, method: ChartMethod, fail: Fail): CommandResult | null {
  if (!developable && method !== 'geodesic')
    return fail(
      'WRP_PARAM_INVALID',
      'a chain with a sphere or torus face needs placement.method geodesic (their charts stretch; the stretch of every join and curve is measured and held to maxLengthStrain)',
      'placement.method',
    );
  if (developable && method !== 'develop')
    return fail('WRP_PARAM_INVALID', 'a chain of plane, cylinder and cone faces unfolds with placement.method develop', 'placement.method');
  return null;
}

function placementsOf(env: JoinEnv, child: FaceSession): Placement[] {
  const candidates: Placement[] = [];
  for (const [edge, faces] of env.graph.edgeFaces.entries()) {
    const distinct = [...new Set(faces)];
    if (distinct.length !== 2 || !distinct.includes(child.face)) continue;
    const other = env.placed.get(distinct.find((f) => f !== child.face) as number);
    if (other !== undefined) candidates.push({ edge, parent: other });
  }
  return candidates;
}

function crossingScore(env: JoinEnv, candidate: Placement): number | null {
  const edgePoints = env.root.query.edgeSamples(env.root.shape, candidate.edge, SAMPLES)?.map((sample) => sample.point) ?? [];
  const flat = edgePoints
    .map((point) => chartCoordinates(candidate.parent.chart, [point], candidate.parent.session.uvBounds)?.[0] ?? null)
    .filter((c): c is Vec2 => c !== null);
  if (flat.length < 2) return null;
  const [first, last] = [flat[0] as Vec2, flat[flat.length - 1] as Vec2];
  const probes = env.sketch.length > 0 ? env.sketch.flat() : [candidate.parent.chart.anchorChart];
  const mine = probes.filter((p) => keptByClips(candidate.parent.clips, p));
  const crossing = mine.some((p) => sideOfLine(first, last, p) > 0) && mine.some((p) => sideOfLine(first, last, p) < 0);
  const near = Math.min(...probes.flatMap((p) => flat.map((c) => dist2(c, p))));
  return (crossing ? 0 : 1e9) + near;
}

function chooseEdge(env: JoinEnv, candidates: Placement[]): Placement {
  let chosen = candidates[0] as Placement;
  if (candidates.length > 1) {
    let best = Infinity;
    for (const candidate of candidates) {
      const score = crossingScore(env, candidate);
      if (score !== null && score < best) {
        best = score;
        chosen = candidate;
      }
    }
  }
  return chosen;
}

function edgeWindow(env: JoinEnv, join: Join, child: FaceSession): EdgeWindow | CommandResult {
  const samples = env.root.query.edgeSamples(env.root.shape, join.edge, SAMPLES);
  if (samples === null || samples.length < 2) return env.fail('WRP_KERNEL_BUILD_FAILED', `the kernel gave no samples of edge ${join.edge}`);
  // the part of the edge the parent chart reaches (a geodesic chart of a sphere or torus covers a quarter great circle / half a tube round its anchor): the run of samples
  // around the one nearest the chart anchor, so a closed edge (a meridian) is joined over the stretch the sketch can touch
  const all = samples.map((sample) => sample.point);
  const coords = all.map((point) => chartCoordinates(join.parent.chart, [point], join.parent.session.uvBounds)?.[0] ?? null);
  const reach = reachOf(join.parent.chart);
  const origin = join.parent.chart.anchorChart;
  const reached = (k: number): boolean => {
    const c = coords[k];
    return c !== null && c !== undefined && dist2(c, origin) <= reach;
  };
  // the window is seeded where the sketch comes nearest the edge (its crossing), else nearest the chart anchor
  const targets = env.sketch.length > 0 ? env.sketch.flat() : [origin];
  const nearTarget = (c: Vec2): number => Math.min(...targets.map((p) => dist2(c, p)));
  let seed = -1;
  for (const [k, c] of coords.entries()) if (reached(k) && (seed < 0 || nearTarget(c as Vec2) < nearTarget(coords[seed] as Vec2))) seed = k;
  // a closed edge (a meridian) has its first sample on its last: the window runs round the ring, so a seed next to the wrap gets both sides
  const closed = all.length > 2 && distance3(all[0] as Vec3, all[all.length - 1] as Vec3) < 1e-9 * (1 + edgeScale(all));
  const ring = closed ? all.length - 1 : all.length;
  const at = (k: number): number => (closed ? ((k % ring) + ring) % ring : k);
  const available = (k: number): boolean => (closed ? Math.abs(k - seed) < ring : k >= 0 && k < all.length) && reached(at(k));
  let low = seed;
  let high = seed;
  while (seed >= 0 && available(low - 1) && high - low < ring - 1) low--;
  while (seed >= 0 && available(high + 1) && high - low < ring - 1) high++;
  if (seed < 0 || high - low < 2)
    return env.fail(
      'WRP_CHAIN_EDGE_CURVED',
      `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} lies out of reach of the chart of face ${join.parent.session.face} (reach ${reach.toPrecision(4)} ${env.doc.units} round its anchor): anchor the sketch nearer to the edge`,
    );
  return { all, coords, seed, low, high, at };
}

function stretchOf(env: JoinEnv, join: Join, child: FaceSession, w: EdgeWindow, developableJoin: boolean): Stretch | CommandResult {
  const { all, coords, seed, at } = w;
  // a geodesic that is not through the chart anchor is a curve in its geodesic chart: keep the stretch of the edge that is straight to half the limit (the sketch is local to the seed)
  const keep = { low: w.low, high: w.high };
  const window = (): number[] => Array.from({ length: keep.high - keep.low + 1 }, (_, k) => at(keep.low + k));
  while (!developableJoin && keep.high - keep.low > 2) {
    const stretch = window().map((k) => coords[k] as Vec2);
    if (straightness(stretch) <= 0.5 * env.limit * dist2(stretch[0] as Vec2, stretch[stretch.length - 1] as Vec2)) break;
    if (seed - keep.low > keep.high - seed) keep.low++;
    else keep.high--;
  }
  const points = window().map((k) => all[k] as Vec3);
  const parentPoints = window().map((k) => coords[k] as Vec2);
  const length = dist2(parentPoints[0] as Vec2, parentPoints[parentPoints.length - 1] as Vec2);
  const seedAt = seed - keep.low;
  const edgeLength = all.reduce((sum, p, k) => (k === 0 ? 0 : sum + distance3(p, all[k - 1] as Vec3)), 0);
  const bend = straightness(parentPoints);
  const allowed = developableJoin ? Math.max(env.tolerance, 1e-9 * length) : env.limit * length;
  if (!(bend <= allowed))
    return env.fail(
      developableJoin ? 'WRP_CHAIN_EDGE_CURVED' : 'WRP_DISTORTION_EXCEEDED',
      developableJoin
        ? `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} develops to a curve${sharedNote(join.shared)} (${bend.toPrecision(4)} ${env.doc.units} off its chord): only edges that develop to straight lines (a generatrix of a cylinder, a ruling of a cone, a straight edge of a plane) join two faces into one chart`
        : `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} bends ${(bend / length).toPrecision(4)} of its length off its chord in the geodesic chart (limit ${env.limit}): a curved edge cannot be the cut line of two charts; use a smaller sketch or an edge along a geodesic (a meridian of a torus, a great circle)${sharedNote(join.shared)}`,
    );
  return { points, parentPoints, length, seedAt, edgeLength, bend, allowed };
}

function matchChild(env: JoinEnv, join: Join, child: FaceSession, s: Stretch, developableJoin: boolean): ChildMatch | CommandResult {
  const hit = child.query.projectOnFace(child.shape, child.face, [s.points[s.seedAt] as Vec3])?.[0] ?? null;
  if (hit === null) return env.fail('WRP_KERNEL_BUILD_FAILED', `edge ${join.edge} does not project onto face ${child.face}`);
  const natural = buildChart(
    child.surface,
    { anchorChart: [0, 0], anchorOn: s.points[s.seedAt] as Vec3, angleDeg: 0, mirror: false },
    methodOf(child.surface.type),
  );
  if ('error' in natural)
    return env.fail('WRP_CHAIN_FACE_UNSUPPORTED', `face ${child.face} has no ${methodOf(child.surface.type)} chart (${natural.error})`);
  const orientation: 1 | -1 =
    hit.normal[0] * natural.normalAt(natural.anchorUv)[0] +
      hit.normal[1] * natural.normalAt(natural.anchorUv)[1] +
      hit.normal[2] * natural.normalAt(natural.anchorUv)[2] >=
    0
      ? 1
      : -1;
  const matches = childChart(child, s.points, s.parentPoints, env.handedness, orientation, methodOf(child.surface.type), s.seedAt);
  const candidate = matches[0] ?? null;
  const mismatchLimit = developableJoin ? Math.max(env.tolerance, 1e-9 * s.length) : env.limit * s.length;
  if (candidate !== null && !developableJoin && candidate.residual > mismatchLimit)
    return env.fail(
      'WRP_DISTORTION_EXCEEDED',
      `the geodesic charts of faces ${join.parent.session.face} and ${child.face} disagree along edge ${join.edge}${sharedNote(join.shared)}: its points differ by ${candidate.residual.toPrecision(4)} ${env.doc.units} (${(candidate.residual / s.length).toPrecision(4)} of the edge length, limit ${env.limit}); use a smaller sketch or a larger maxLengthStrain`,
    );
  if (candidate === null || !(candidate.residual <= mismatchLimit))
    return env.fail(
      'WRP_CHAIN_EDGE_CURVED',
      `edge ${join.edge} does not develop to the same line on faces ${join.parent.session.face} and ${child.face}${sharedNote(join.shared)} (best match ${candidate?.residual.toPrecision(4) ?? 'none'} ${env.doc.units}): the faces cannot be unfolded into one chart`,
    );
  return { orientation, matches, candidate };
}

function frameOf(parentPoints: readonly Vec2[], length: number): Frame {
  const first = parentPoints[0] as Vec2;
  const last = parentPoints[parentPoints.length - 1] as Vec2;
  const direction: Vec2 = [(last[0] - first[0]) / length, (last[1] - first[1]) / length];
  return { first, last, direction, normal: [-direction[1], direction[0]] };
}

function unfoldChild(
  env: JoinEnv,
  join: Join,
  child: FaceSession,
  s: Stretch,
  frame: Frame,
  match: ChildMatch,
): { readonly parentSide: 1 | -1; readonly chart: FaceChart } | CommandResult {
  const { normal } = frame;
  const { length } = s;
  const { candidate, matches } = match;
  // the side of the edge each face lies on, found with the kernel's own point-in-face test on points of the charts
  const middle: Vec2 = s.parentPoints[Math.floor(s.parentPoints.length / 2)] as Vec2;
  const inside = (face: FaceSession, chart: FaceChart, sign: 1 | -1, apart = 0): boolean | null => {
    const offset = Math.max(1e-3 * length, 10 * env.tolerance, apart);
    const at: Vec2 = [middle[0] + sign * offset * normal[0], middle[1] + sign * offset * normal[1]];
    const uv = chart.uvAt(at);
    if (uv === null) return null;
    return face.query.faceContains(face.shape, face.face, chart.pointAt(uv), 10 * env.tolerance);
  };
  const parentSide = ([1, -1] as const).find(
    (sign) =>
      inside(join.parent.session, join.parent.chart, sign) === true &&
      inside(join.parent.session, join.parent.chart, -sign as 1 | -1) !== true,
  );
  if (parentSide === undefined)
    return env.fail(
      'WRP_CHAIN_CLIP_FAILED',
      `the kernel could not tell which side of edge ${join.edge} face ${join.parent.session.face} lies on`,
    );
  // the edge fixes the child chart only up to a reflection across it (the straight edge has the same residual both ways): the chart that puts the child on the other side
  // of the edge from the parent, by the kernel's point-in-face test, is the unfolding (not the orientation rule, which a cone's chart does not follow)
  const tied = matches.filter((m) => m.residual <= candidate.residual + Math.max(1e-9 * length, 1e-3 * candidate.residual));
  // the child chart puts the edge points where the parent chart does only to the mismatch of the join: step away from the edge by more than that
  const apartChild = 4 * candidate.residual;
  const unfolded = tied.find(
    (m) => inside(child, m.chart, -parentSide as 1 | -1, apartChild) === true && inside(child, m.chart, parentSide, apartChild) !== true,
  );
  if (unfolded === undefined)
    return env.fail(
      'WRP_CHAIN_CLIP_FAILED',
      `the kernel could not tell which side of edge ${join.edge} face ${child.face} lies on in any of the ${tied.length} charts that match its points: the faces cannot be unfolded into one chart`,
    );
  return { parentSide, chart: unfolded.chart };
}

// where the sketch crosses the edge line: inside the stretch the charts are joined over, and the two charts must put those points together
function sketchGap(
  env: JoinEnv,
  join: Join,
  child: FaceSession,
  s: Stretch,
  frame: Frame,
  unfolded: FaceChart,
  mismatchLimit: number,
): number | CommandResult {
  const { first, last, direction } = frame;
  const { length } = s;
  let gap = 0;
  for (const polyline of env.sketch)
    for (let k = 0; k + 1 < polyline.length; k++) {
      const [a, b] = [polyline[k] as Vec2, polyline[k + 1] as Vec2];
      const [sa, sb] = [sideOfLine(first, last, a), sideOfLine(first, last, b)];
      if ((sa === 0 && sb === 0) || (sa > 0 && sb > 0) || (sa < 0 && sb < 0)) continue;
      const t = sa / (sa - sb);
      const cut: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      // a crossing counts where the parent face is: not on the part of the endless line beyond the cut lines to its earlier joins
      if (!keptByClips(join.parent.clips, cut)) continue;
      const along = ((cut[0] - first[0]) * direction[0] + (cut[1] - first[1]) * direction[1]) / length;
      if (along < -1e-6 || along > 1 + 1e-6)
        return env.fail(
          'WRP_DISTORTION_EXCEEDED',
          `the sketch crosses edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} outside the ${length.toPrecision(4)} ${env.doc.units} of it the geodesic charts are joined over (within the limit ${env.limit}): use a smaller sketch or anchor it nearer to where it crosses the edge`,
        );
      const uvParent = join.parent.chart.uvAt(cut);
      const uvChild = unfolded.uvAt(cut);
      if (uvParent === null || uvChild === null)
        return env.fail(
          'WRP_DISTORTION_EXCEEDED',
          `a point where the sketch crosses edge ${join.edge} has no image in the geodesic chart of face ${uvParent === null ? join.parent.session.face : child.face}`,
        );
      gap = Math.max(gap, distance3(join.parent.chart.pointAt(uvParent), unfolded.pointAt(uvChild)));
    }
  if (gap > mismatchLimit)
    return env.fail(
      'WRP_DISTORTION_EXCEEDED',
      `the geodesic charts of faces ${join.parent.session.face} and ${child.face} put a point where the sketch crosses edge ${join.edge} ${gap.toPrecision(4)} ${env.doc.units} apart (${(gap / length).toPrecision(4)} of the joined stretch, limit ${env.limit}); use a smaller sketch or a larger maxLengthStrain`,
    );
  return gap;
}

function joinChild(env: JoinEnv, child: FaceSession): ChainJoin | CommandResult | null {
  const candidates = placementsOf(env, child);
  if (candidates.length === 0) return null;
  const chosen = chooseEdge(env, candidates);
  const join: Join = { ...chosen, shared: candidates.filter((c) => c.parent === chosen.parent).length };
  const window = edgeWindow(env, join, child);
  if ('summary' in window) return window;
  const developableJoin = isDevelopable(join.parent.session.surface.type) && isDevelopable(child.surface.type);
  const stretch = stretchOf(env, join, child, window, developableJoin);
  if ('summary' in stretch) return stretch;
  const match = matchChild(env, join, child, stretch, developableJoin);
  if ('summary' in match) return match;
  const frame = frameOf(stretch.parentPoints, stretch.length);
  const unfolded = unfoldChild(env, join, child, stretch, frame, match);
  if ('summary' in unfolded) return unfolded;
  const gap = developableJoin ? 0 : sketchGap(env, join, child, stretch, frame, unfolded.chart, stretch.allowed);
  if (typeof gap !== 'number') return gap;
  const { first, last, normal } = frame;
  const { parentSide } = unfolded;
  const { parent } = join;
  const slack = developableJoin ? 0 : Math.max(match.candidate.residual, gap, stretch.bend);
  const joined = slack > 0 ? [stretch.points] : [];
  return {
    parent: {
      ...parent,
      clips: [...parent.clips, { point: first, normal: [parentSide * normal[0], parentSide * normal[1]] }],
      slack: Math.max(parent.slack, slack),
      joins: [...parent.joins, ...joined],
    },
    child: {
      session: child,
      chart: unfolded.chart,
      orientation: match.orientation,
      clips: [{ point: first, normal: [-parentSide * normal[0], -parentSide * normal[1]] }],
      slack,
      joins: joined,
    },
    edge: {
      edge: join.edge,
      faces: [parent.session.face, child.face],
      length: stretch.edgeLength,
      windowLength: stretch.length,
      line: [first, last],
      world: [stretch.points[0] as Vec3, stretch.points[stretch.points.length - 1] as Vec3],
      cutGap: gap,
      mismatch: developableJoin ? 0 : Math.max(match.candidate.residual, gap) / stretch.length,
      convexity: env.graph.edgeConvexity[join.edge] ?? 'unknown',
    },
  };
}

/**
 * The chain of `root` and the faces of `refs`, unfolded into the sketch plane of `root`'s chart.
 * @failure see the module comment
 */
export function buildChain(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  command: string,
  root: { readonly session: FaceSession; readonly resolved: ResolvedChart; readonly mirror: boolean },
  refs: readonly FaceRefInput[],
  tolerance: number,
  limit: number,
  /** Points of the sketch in chain coordinates: when two faces share several edges the one the sketch crosses is unfolded. */
  sketch: ReadonlyArray<readonly Vec2[]> = [],
): Chain | CommandResult {
  const { session } = root;
  const fail: Fail = (code, message, path = 'chain') => wrapRejection(doc, command, code, message, [session.entity.id], [path]);
  const sessions = openChainSessions(doc, ctx, command, session, refs, fail);
  if (!Array.isArray(sessions)) return sessions;
  const developable = sessions.every((s) => isDevelopable(s.surface.type));
  const refused = checkChainMethod(developable, root.resolved.chart.method, fail);
  if (refused !== null) return refused;
  const graph = session.query.faceGraph(session.shape);
  if (graph === null) return fail('WRP_KERNEL_BUILD_FAILED', 'the kernel gave no face adjacency');
  const handedness: 1 | -1 = (root.resolved.orientation * (root.mirror ? -1 : 1)) as 1 | -1;
  const placed = new Map<number, ChainFace>();
  const probeOf = (s: FaceSession): Vec3 => {
    const centroid = s.query.faceDetails(s.shape, { samples: 0 })?.[s.face]?.centroid ?? root.resolved.anchorOn;
    return s.query.projectOnFace(s.shape, s.face, [centroid])?.[0]?.point ?? centroid;
  };
  placed.set(session.face, {
    session,
    chart: root.resolved.chart,
    orientation: root.resolved.orientation,
    clips: [],
    probe: probeOf(session),
    slack: 0,
    joins: [],
  });
  const env: JoinEnv = { doc, root: session, tolerance, limit, sketch, graph, handedness, placed, fail };
  const edges: ChainEdge[] = [];
  const pending = sessions.slice(1);
  while (pending.length > 0) {
    let progressed = false;
    for (const [index, child] of pending.entries()) {
      const joined = joinChild(env, child);
      if (joined === null) continue;
      if ('summary' in joined) return joined;
      placed.set(joined.parent.session.face, joined.parent);
      placed.set(child.face, { ...joined.child, probe: probeOf(child) });
      edges.push(joined.edge);
      pending.splice(index, 1);
      progressed = true;
      break;
    }
    if (!progressed)
      return fail(
        'WRP_CHAIN_NOT_ADJACENT',
        `face${pending.length > 1 ? 's' : ''} ${pending.map((s) => s.face).join(', ')} share no edge with the rest of the chain (${[...placed.keys()].join(', ')}): list the faces in a connected chain`,
      );
  }
  return { faces: sessions.map((s) => placed.get(s.face) as ChainFace), edges, developable, method: root.resolved.chart.method };
}
