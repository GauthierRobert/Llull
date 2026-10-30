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
import { chartPointOf } from '../../geometry/chartInverse';
import { buildChart } from '../../geometry/faceChart';
import { distance3 } from '../../lib/vec3';
import type { CommandResult, ExecutionContext } from '../types';
import { wrapRejection } from './codes';
import type { HalfPlane } from './clipRegions';
import { isRejection, openFace, type FaceRefInput, type FaceSession, type ResolvedChart } from './faceSession';

const SAMPLES = 17;
const MAX_CHAIN_FACES = 16;
const TWO_PI = 2 * Math.PI;

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

/** The inverse of an affine chart: chart coordinates of (u, v). */
function inverseOf(chart: FaceChart): ((uv: Vec2) => Vec2) | null {
  const o = chart.uvAt([0, 0]);
  const a = chart.uvAt([1, 0]);
  const b = chart.uvAt([0, 1]);
  if (o === null || a === null || b === null) return null;
  const [m00, m10, m01, m11] = [a[0] - o[0], a[1] - o[1], b[0] - o[0], b[1] - o[1]];
  const det = m00 * m11 - m01 * m10;
  if (!(Math.abs(det) > 1e-300)) return null;
  return ([u, v]) => [(m11 * (u - o[0]) - m01 * (v - o[1])) / det, (-m10 * (u - o[0]) + m00 * (v - o[1])) / det];
}

/**
 * Chart coordinates of surface points of a face. The azimuth of a cylinder is taken in the turn that holds the face's own u range (a face spans less than one turn, so the
 * representative of each point is unique, also for the points of a half-turn face where a nearest-turn rule is ambiguous).
 */
/**
 * Chart coordinates of surface points on a chart that is not affine (cone, sphere, torus): the natural coordinates of `chartPointOf` turned back by the chart's own placement (the
 * rotation and mirror D with natural = D (q - anchorChart), found from two probes of the chart).
 */
function polarCoordinates(chart: FaceChart, points: readonly Vec3[]): Vec2[] | null {
  const eps = 1e-3;
  const columns: Vec2[] = [];
  for (const step of [
    [eps, 0],
    [0, eps],
  ] as const) {
    const uv = chart.uvAt([chart.anchorChart[0] + step[0], chart.anchorChart[1] + step[1]]);
    if (uv === null) return null;
    const natural = chartPointOf(chart, chart.pointAt(uv));
    if ('error' in natural) return null;
    columns.push([natural[0] / eps, natural[1] / eps]);
  }
  const [c0, c1] = columns as [Vec2, Vec2];
  const det = c0[0] * c1[1] - c1[0] * c0[1];
  if (!(Math.abs(det) > 1e-300)) return null;
  const out: Vec2[] = [];
  for (const point of points) {
    // the anchor itself has no direction: its natural coordinates are the origin
    const home = chart.pointAt(chart.anchorUv);
    const natural =
      distance3(point, home) < 1e-9 * (1 + Math.abs(home[0]) + Math.abs(home[1]) + Math.abs(home[2]))
        ? ([0, 0] as Vec2)
        : chartPointOf(chart, point);
    if ('error' in natural) return null;
    // q - anchor = D^-1 natural, D = [c0 c1] (columns)
    out.push([
      chart.anchorChart[0] + (c1[1] * natural[0] - c1[0] * natural[1]) / det,
      chart.anchorChart[1] + (-c0[1] * natural[0] + c0[0] * natural[1]) / det,
    ]);
  }
  return out;
}

function chartCoordinates(chart: FaceChart, points: readonly Vec3[], bounds: FaceSession['uvBounds']): Vec2[] | null {
  if (chart.kind !== 'plane' && chart.kind !== 'cylinder') return polarCoordinates(chart, points);
  const inverse = inverseOf(chart);
  if (inverse === null) return null;
  const centre = (bounds[0][0] + bounds[1][0]) / 2;
  const turn = chart.kind === 'cylinder' ? TWO_PI * Math.round((centre - chart.anchorUv[0]) / TWO_PI) : 0;
  return points.map((point) => {
    const uv = chart.uvOfPoint(point);
    // the face's own turn, expressed against the branch of the chart anchor (chart coordinates are measured from the anchor)
    const u = chart.kind === 'cylinder' ? uv[0] + TWO_PI * Math.round((centre - uv[0]) / TWO_PI) - turn : uv[0];
    return inverse([u, uv[1]]);
  });
}

const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Largest extent of a set of points (the scale a closed edge's coincident ends are judged against). */
const edgeScale = (points: readonly Vec3[]): number => Math.max(...points.map((p) => distance3(p, points[0] as Vec3)));

/** Largest distance of the points from the line through the first and the last. */
function straightness(points: readonly Vec2[]): number {
  const [first, last] = [points[0] as Vec2, points[points.length - 1] as Vec2];
  const length = dist2(first, last);
  if (!(length > 0)) return Infinity;
  const d: Vec2 = [(last[0] - first[0]) / length, (last[1] - first[1]) / length];
  return Math.max(...points.map((p) => Math.abs(d[0] * (p[1] - first[1]) - d[1] * (p[0] - first[0]))));
}

/** The refusal text when the two faces share more than one edge: only the first is unfolded. */
const sharedNote = (shared: number): string => (shared > 1 ? ` (the faces share ${shared} edges; only the first is unfolded)` : '');

interface Candidate {
  readonly chart: FaceChart;
  readonly mirror: boolean;
  readonly residual: number;
}

/** The charts of a child face carrying the chain's coordinates `chainPoints` of the 3D edge points `points` (anchored on the first), or null when none reproduces them. */
function childChart(
  session: FaceSession,
  points: readonly Vec3[],
  chainPoints: readonly Vec2[],
  handedness: 1 | -1,
  orientation: 1 | -1,
  method: ChartMethod,
  /** Index of the edge sample the child chart is anchored on (the one nearest where the sketch crosses). */
  at: number,
): Candidate[] {
  const preferredMirror = orientation !== handedness;
  const pivot = chainPoints[at] as Vec2;
  const found: Candidate[] = [];
  for (const mirror of [preferredMirror, !preferredMirror]) {
    const own = buildChart(session.surface, { anchorChart: [0, 0], anchorOn: points[at] as Vec3, angleDeg: 0, mirror }, method);
    if ('error' in own) return [];
    const d = chartCoordinates(own, points, session.uvBounds);
    if (d === null) return [];
    const v = chainPoints.map((p): Vec2 => [p[0] - pivot[0], p[1] - pivot[1]]);
    let dot = 0;
    let cross = 0;
    for (const [k, vk] of v.entries()) {
      const dk: Vec2 = [(d[k] as Vec2)[0] - (d[at] as Vec2)[0], (d[k] as Vec2)[1] - (d[at] as Vec2)[1]];
      dot += dk[0] * vk[0] + dk[1] * vk[1];
      cross += dk[0] * vk[1] - dk[1] * vk[0];
    }
    const alpha = Math.atan2(cross, dot);
    for (const angle of [alpha, -alpha]) {
      const chart = buildChart(
        session.surface,
        { anchorChart: pivot, anchorOn: points[at] as Vec3, angleDeg: (angle * 180) / Math.PI, mirror },
        method,
      );
      if ('error' in chart) continue;
      const residual = Math.max(
        ...points.map((point, k) => {
          const uv = chart.uvAt(chainPoints[k] as Vec2);
          return uv === null ? Infinity : distance3(chart.pointAt(uv), point);
        }),
      );
      found.push({ chart, mirror, residual });
    }
  }
  return found.sort((a, b) => a.residual - b.residual);
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
  const fail = (code: string, message: string, path = 'chain'): CommandResult =>
    wrapRejection(doc, command, code, message, [session.entity.id], [path]);
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
  const developable = sessions.every((s) => isDevelopable(s.surface.type));
  if (!developable && root.resolved.chart.method !== 'geodesic')
    return fail(
      'WRP_PARAM_INVALID',
      'a chain with a sphere or torus face needs placement.method geodesic (their charts stretch; the stretch of every join and curve is measured and held to maxLengthStrain)',
      'placement.method',
    );
  if (developable && root.resolved.chart.method !== 'develop')
    return fail('WRP_PARAM_INVALID', 'a chain of plane, cylinder and cone faces unfolds with placement.method develop', 'placement.method');
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
  const edges: ChainEdge[] = [];
  const pending = sessions.slice(1);
  while (pending.length > 0) {
    let progressed = false;
    for (const [index, child] of pending.entries()) {
      const candidates: Array<{ edge: number; parent: ChainFace }> = [];
      for (const [edge, faces] of graph.edgeFaces.entries()) {
        const distinct = [...new Set(faces)];
        if (distinct.length !== 2 || !distinct.includes(child.face)) continue;
        const other = placed.get(distinct.find((f) => f !== child.face) as number);
        if (other !== undefined) candidates.push({ edge, parent: other });
      }
      if (candidates.length === 0) continue;
      // two faces can share several edges (the two rulings of a split cone): the one the sketch crosses, else the nearest to it, is unfolded
      let chosen = candidates[0] as { edge: number; parent: ChainFace };
      if (candidates.length > 1) {
        let best = Infinity;
        for (const candidate of candidates) {
          const edgePoints = session.query.edgeSamples(session.shape, candidate.edge, SAMPLES)?.map((sample) => sample.point) ?? [];
          const flat = edgePoints
            .map((point) => chartCoordinates(candidate.parent.chart, [point], candidate.parent.session.uvBounds)?.[0] ?? null)
            .filter((c): c is Vec2 => c !== null);
          if (flat.length < 2) continue;
          const [first, last] = [flat[0] as Vec2, flat[flat.length - 1] as Vec2];
          const side = (p: Vec2): number => (last[0] - first[0]) * (p[1] - first[1]) - (last[1] - first[1]) * (p[0] - first[0]);
          const probes = sketch.length > 0 ? sketch.flat() : [candidate.parent.chart.anchorChart];
          const mine = probes.filter((p) =>
            candidate.parent.clips.every(
              (clip) => (p[0] - clip.point[0]) * clip.normal[0] + (p[1] - clip.point[1]) * clip.normal[1] >= -1e-9,
            ),
          );
          const crossing = mine.some((p) => side(p) > 0) && mine.some((p) => side(p) < 0);
          const near = Math.min(...probes.flatMap((p) => flat.map((c) => dist2(c, p))));
          const score = (crossing ? 0 : 1e9) + near;
          if (score < best) {
            best = score;
            chosen = candidate;
          }
        }
      }
      const join = { ...chosen, shared: candidates.filter((c) => c.parent === chosen.parent).length };
      const samples = session.query.edgeSamples(session.shape, join.edge, SAMPLES);
      if (samples === null || samples.length < 2) return fail('WRP_KERNEL_BUILD_FAILED', `the kernel gave no samples of edge ${join.edge}`);
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
      const targets = sketch.length > 0 ? sketch.flat() : [origin];
      const nearTarget = (c: Vec2): number => Math.min(...targets.map((p) => dist2(c, p)));
      let seed = -1;
      for (const [k, c] of coords.entries())
        if (reached(k) && (seed < 0 || nearTarget(c as Vec2) < nearTarget(coords[seed] as Vec2))) seed = k;
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
        return fail(
          'WRP_CHAIN_EDGE_CURVED',
          `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} lies out of reach of the chart of face ${join.parent.session.face} (reach ${reach.toPrecision(4)} ${doc.units} round its anchor): anchor the sketch nearer to the edge`,
        );
      const developableJoin = isDevelopable(join.parent.session.surface.type) && isDevelopable(child.surface.type);
      // a geodesic that is not through the chart anchor is a curve in its geodesic chart: keep the stretch of the edge that is straight to half the limit (the sketch is local to the seed)
      const keep = { low, high };
      const window = (): number[] => Array.from({ length: keep.high - keep.low + 1 }, (_, k) => at(keep.low + k));
      while (!developableJoin && keep.high - keep.low > 2) {
        const stretch = window().map((k) => coords[k] as Vec2);
        if (straightness(stretch) <= 0.5 * limit * dist2(stretch[0] as Vec2, stretch[stretch.length - 1] as Vec2)) break;
        if (seed - keep.low > keep.high - seed) keep.low++;
        else keep.high--;
      }
      const points = window().map((k) => all[k] as Vec3);
      const parentPoints = window().map((k) => coords[k] as Vec2);
      const length = dist2(parentPoints[0] as Vec2, parentPoints[parentPoints.length - 1] as Vec2);
      const seedAt = seed - keep.low;
      const edgeLength = all.reduce((sum, p, k) => (k === 0 ? 0 : sum + distance3(p, all[k - 1] as Vec3)), 0);
      const bend = straightness(parentPoints);
      const allowed = developableJoin ? Math.max(tolerance, 1e-9 * length) : limit * length;
      if (!(bend <= allowed))
        return fail(
          developableJoin ? 'WRP_CHAIN_EDGE_CURVED' : 'WRP_DISTORTION_EXCEEDED',
          developableJoin
            ? `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} develops to a curve${sharedNote(join.shared)} (${bend.toPrecision(4)} ${doc.units} off its chord): only edges that develop to straight lines (a generatrix of a cylinder, a ruling of a cone, a straight edge of a plane) join two faces into one chart`
            : `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} bends ${(bend / length).toPrecision(4)} of its length off its chord in the geodesic chart (limit ${limit}): a curved edge cannot be the cut line of two charts; use a smaller sketch or an edge along a geodesic (a meridian of a torus, a great circle)${sharedNote(join.shared)}`,
        );
      const hit = child.query.projectOnFace(child.shape, child.face, [points[seedAt] as Vec3])?.[0] ?? null;
      if (hit === null) return fail('WRP_KERNEL_BUILD_FAILED', `edge ${join.edge} does not project onto face ${child.face}`);
      const natural = buildChart(
        child.surface,
        { anchorChart: [0, 0], anchorOn: points[seedAt] as Vec3, angleDeg: 0, mirror: false },
        methodOf(child.surface.type),
      );
      if ('error' in natural)
        return fail('WRP_CHAIN_FACE_UNSUPPORTED', `face ${child.face} has no ${methodOf(child.surface.type)} chart (${natural.error})`);
      const orientation: 1 | -1 =
        hit.normal[0] * natural.normalAt(natural.anchorUv)[0] +
          hit.normal[1] * natural.normalAt(natural.anchorUv)[1] +
          hit.normal[2] * natural.normalAt(natural.anchorUv)[2] >=
        0
          ? 1
          : -1;
      const matches = childChart(child, points, parentPoints, handedness, orientation, methodOf(child.surface.type), seedAt);
      const candidate = matches[0] ?? null;
      const mismatchLimit = developableJoin ? Math.max(tolerance, 1e-9 * length) : limit * length;
      if (candidate !== null && !developableJoin && candidate.residual > mismatchLimit)
        return fail(
          'WRP_DISTORTION_EXCEEDED',
          `the geodesic charts of faces ${join.parent.session.face} and ${child.face} disagree along edge ${join.edge}${sharedNote(join.shared)}: its points differ by ${candidate.residual.toPrecision(4)} ${doc.units} (${(candidate.residual / length).toPrecision(4)} of the edge length, limit ${limit}); use a smaller sketch or a larger maxLengthStrain`,
        );
      if (candidate === null || !(candidate.residual <= mismatchLimit))
        return fail(
          'WRP_CHAIN_EDGE_CURVED',
          `edge ${join.edge} does not develop to the same line on faces ${join.parent.session.face} and ${child.face}${sharedNote(join.shared)} (best match ${candidate?.residual.toPrecision(4) ?? 'none'} ${doc.units}): the faces cannot be unfolded into one chart`,
        );
      // the side of the edge each face lies on, found with the kernel's own point-in-face test on points of the charts
      const first = parentPoints[0] as Vec2;
      const last = parentPoints[parentPoints.length - 1] as Vec2;
      const direction: Vec2 = [(last[0] - first[0]) / length, (last[1] - first[1]) / length];
      const normal: Vec2 = [-direction[1], direction[0]];
      const middle: Vec2 = parentPoints[Math.floor(parentPoints.length / 2)] as Vec2;
      const inside = (face: { readonly session: FaceSession }, chart: FaceChart, sign: 1 | -1, apart = 0): boolean | null => {
        const offset = Math.max(1e-3 * length, 10 * tolerance, apart);
        const at: Vec2 = [middle[0] + sign * offset * normal[0], middle[1] + sign * offset * normal[1]];
        const uv = chart.uvAt(at);
        if (uv === null) return null;
        return face.session.query.faceContains(face.session.shape, face.session.face, chart.pointAt(uv), 10 * tolerance);
      };
      const parentSide = ([1, -1] as const).find(
        (sign) => inside(join.parent, join.parent.chart, sign) === true && inside(join.parent, join.parent.chart, -sign as 1 | -1) !== true,
      );
      if (parentSide === undefined)
        return fail(
          'WRP_CHAIN_CLIP_FAILED',
          `the kernel could not tell which side of edge ${join.edge} face ${join.parent.session.face} lies on`,
        );
      // the edge fixes the child chart only up to a reflection across it (the straight edge has the same residual both ways): the chart that puts the child on the other side
      // of the edge from the parent, by the kernel's point-in-face test, is the unfolding (not the orientation rule, which a cone's chart does not follow)
      const tied = matches.filter((match) => match.residual <= candidate.residual + Math.max(1e-9 * length, 1e-3 * candidate.residual));
      // the child chart puts the edge points where the parent chart does only to the mismatch of the join: step away from the edge by more than that
      const apartChild = 4 * candidate.residual;
      const unfolded = tied.find(
        (match) =>
          inside({ session: child }, match.chart, -parentSide as 1 | -1, apartChild) === true &&
          inside({ session: child }, match.chart, parentSide, apartChild) !== true,
      );
      if (unfolded === undefined)
        return fail(
          'WRP_CHAIN_CLIP_FAILED',
          `the kernel could not tell which side of edge ${join.edge} face ${child.face} lies on in any of the ${tied.length} charts that match its points: the faces cannot be unfolded into one chart`,
        );
      // where the sketch crosses the edge line: inside the stretch the charts are joined over, and the two charts must put those points together
      let gap = 0;
      if (!developableJoin) {
        const side = (p: Vec2): number => (last[0] - first[0]) * (p[1] - first[1]) - (last[1] - first[1]) * (p[0] - first[0]);
        for (const polyline of sketch)
          for (let k = 0; k + 1 < polyline.length; k++) {
            const [a, b] = [polyline[k] as Vec2, polyline[k + 1] as Vec2];
            const [sa, sb] = [side(a), side(b)];
            if ((sa === 0 && sb === 0) || (sa > 0 && sb > 0) || (sa < 0 && sb < 0)) continue;
            const t = sa / (sa - sb);
            const cut: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
            // a crossing counts where the parent face is: not on the part of the endless line beyond the cut lines to its earlier joins
            if (
              !join.parent.clips.every(
                (clip) => (cut[0] - clip.point[0]) * clip.normal[0] + (cut[1] - clip.point[1]) * clip.normal[1] >= -1e-9,
              )
            )
              continue;
            const along = ((cut[0] - first[0]) * direction[0] + (cut[1] - first[1]) * direction[1]) / length;
            if (along < -1e-6 || along > 1 + 1e-6)
              return fail(
                'WRP_DISTORTION_EXCEEDED',
                `the sketch crosses edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} outside the ${length.toPrecision(4)} ${doc.units} of it the geodesic charts are joined over (within the limit ${limit}): use a smaller sketch or anchor it nearer to where it crosses the edge`,
              );
            const uvParent = join.parent.chart.uvAt(cut);
            const uvChild = unfolded.chart.uvAt(cut);
            if (uvParent === null || uvChild === null)
              return fail(
                'WRP_DISTORTION_EXCEEDED',
                `a point where the sketch crosses edge ${join.edge} has no image in the geodesic chart of face ${uvParent === null ? join.parent.session.face : child.face}`,
              );
            gap = Math.max(gap, distance3(join.parent.chart.pointAt(uvParent), unfolded.chart.pointAt(uvChild)));
          }
        if (gap > mismatchLimit)
          return fail(
            'WRP_DISTORTION_EXCEEDED',
            `the geodesic charts of faces ${join.parent.session.face} and ${child.face} put a point where the sketch crosses edge ${join.edge} ${gap.toPrecision(4)} ${doc.units} apart (${(gap / length).toPrecision(4)} of the joined stretch, limit ${limit}); use a smaller sketch or a larger maxLengthStrain`,
          );
      }
      const parentClip: HalfPlane = { point: first, normal: [parentSide * normal[0], parentSide * normal[1]] };
      const childClip: HalfPlane = { point: first, normal: [-parentSide * normal[0], -parentSide * normal[1]] };
      const parent = join.parent;
      const slack = developableJoin ? 0 : Math.max(candidate.residual, gap, bend);
      const joined = slack > 0 ? [points] : [];
      placed.set(parent.session.face, {
        ...parent,
        clips: [...parent.clips, parentClip],
        slack: Math.max(parent.slack, slack),
        joins: [...parent.joins, ...joined],
      });
      placed.set(child.face, {
        session: child,
        chart: unfolded.chart,
        orientation,
        clips: [childClip],
        probe: probeOf(child),
        slack,
        joins: joined,
      });
      edges.push({
        edge: join.edge,
        faces: [parent.session.face, child.face],
        length: edgeLength,
        windowLength: length,
        cutGap: gap,
        mismatch: developableJoin ? 0 : Math.max(candidate.residual, gap) / length,
        convexity: graph.edgeConvexity[join.edge] ?? 'unknown',
      });
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
