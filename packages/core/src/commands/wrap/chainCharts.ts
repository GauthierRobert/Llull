/**
 * Charts of a chain of faces (03 WRP M5, multi-face wraps): the faces are unfolded one after another across the edges they share, so one sketch plane covers the whole chain.
 * Plane and cylinder faces develop without stretch; an edge between two of them joins the charts when it develops to the same straight line in both (a generatrix of a cylinder,
 * a straight edge of a plane), which makes the unfolding an isometry along the edge. Each face gets a chart with the chain's sketch coordinates (anchored on a point of the shared
 * edge), and the half-planes that keep each face to its own side of every chain edge.
 * @invariant develop: lengths and angles are kept inside every face and across every chain edge; the edge samples map to the same chain point from both sides (checked to the fit
 *   tolerance), so the chart is continuous
 * @failure a face that is not a plane or cylinder, a face not adjacent to the chain, an edge that develops to a curve or to different shapes on its two faces, the kernel unable to
 *   say which side of an edge a face lies on -> coded rejection (WRP_CHAIN_FACE_UNSUPPORTED, WRP_CHAIN_NOT_ADJACENT, WRP_CHAIN_EDGE_CURVED, WRP_CHAIN_CLIP_FAILED)
 */

import type { CadDocument, Vec2, Vec3 } from '../../model/types';
import { type FaceChart } from '../../geometry/chartFrame';
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
}

export interface ChainEdge {
  readonly edge: number;
  readonly faces: readonly [number, number];
  readonly length: number;
  readonly convexity: 'convex' | 'concave' | 'smooth' | 'unknown';
}

export interface Chain {
  readonly faces: ChainFace[];
  readonly edges: ChainEdge[];
}

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
function chartCoordinates(chart: FaceChart, points: readonly Vec3[], bounds: FaceSession['uvBounds']): Vec2[] | null {
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

/** The chart of a child face carrying the chain's coordinates `chainPoints` of the 3D edge points `points` (anchored on the first), or null when none reproduces them. */
function childChart(
  session: FaceSession,
  points: readonly Vec3[],
  chainPoints: readonly Vec2[],
  handedness: 1 | -1,
  orientation: 1 | -1,
): Candidate | null {
  const preferredMirror = orientation !== handedness;
  const found: Candidate[] = [];
  for (const mirror of [preferredMirror, !preferredMirror]) {
    const own = buildChart(session.surface, { anchorChart: [0, 0], anchorOn: points[0] as Vec3, angleDeg: 0, mirror }, 'develop');
    if ('error' in own) return null;
    const d = chartCoordinates(own, points, session.uvBounds);
    if (d === null) return null;
    const v = chainPoints.map((p): Vec2 => [p[0] - (chainPoints[0] as Vec2)[0], p[1] - (chainPoints[0] as Vec2)[1]]);
    let dot = 0;
    let cross = 0;
    for (const [k, vk] of v.entries()) {
      const dk: Vec2 = [(d[k] as Vec2)[0] - (d[0] as Vec2)[0], (d[k] as Vec2)[1] - (d[0] as Vec2)[1]];
      dot += dk[0] * vk[0] + dk[1] * vk[1];
      cross += dk[0] * vk[1] - dk[1] * vk[0];
    }
    const alpha = Math.atan2(cross, dot);
    for (const angle of [alpha, -alpha]) {
      const chart = buildChart(
        session.surface,
        { anchorChart: chainPoints[0] as Vec2, anchorOn: points[0] as Vec3, angleDeg: (angle * 180) / Math.PI, mirror },
        'develop',
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
  const best = found.reduce<Candidate | null>((a, b) => (a === null || b.residual < a.residual - 1e-12 ? b : a), null);
  return best;
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
    if (opened.surface.type !== 'plane' && opened.surface.type !== 'cylinder')
      return fail(
        'WRP_CHAIN_FACE_UNSUPPORTED',
        `chain[${index}] (face ${opened.face}) is a ${opened.surface.type}: chains unfold plane and cylinder faces (cones, spheres and tori have no isometric chart across an edge)`,
        `chain.${index}`,
      );
    sessions.push(opened);
  }
  if (session.surface.type !== 'plane' && session.surface.type !== 'cylinder')
    return fail(
      'WRP_CHAIN_FACE_UNSUPPORTED',
      `face ${session.face} is a ${session.surface.type}: chains unfold plane and cylinder faces`,
      'face',
    );
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
  });
  const edges: ChainEdge[] = [];
  const pending = sessions.slice(1);
  while (pending.length > 0) {
    let progressed = false;
    for (const [index, child] of pending.entries()) {
      let firstJoin: { edge: number; parent: ChainFace } | null = null;
      let shared = 0;
      for (const [edge, faces] of graph.edgeFaces.entries()) {
        const distinct = [...new Set(faces)];
        if (distinct.length !== 2 || !distinct.includes(child.face)) continue;
        const other = placed.get(distinct.find((f) => f !== child.face) as number);
        if (other === undefined) continue;
        if (firstJoin === null) firstJoin = { edge, parent: other };
        if (firstJoin.parent === other) shared++;
      }
      if (firstJoin === null) continue;
      const join = { ...(firstJoin as { edge: number; parent: ChainFace }), shared };
      const samples = session.query.edgeSamples(session.shape, join.edge, SAMPLES);
      if (samples === null || samples.length < 2) return fail('WRP_KERNEL_BUILD_FAILED', `the kernel gave no samples of edge ${join.edge}`);
      const points = samples.map((sample) => sample.point);
      const parentPoints = chartCoordinates(join.parent.chart, points, join.parent.session.uvBounds);
      if (parentPoints === null) return fail('WRP_KERNEL_BUILD_FAILED', `face ${join.parent.session.face} has no invertible chart`);
      const length = dist2(parentPoints[0] as Vec2, parentPoints[parentPoints.length - 1] as Vec2);
      const bend = straightness(parentPoints);
      if (!(bend <= Math.max(tolerance, 1e-9 * length)))
        return fail(
          'WRP_CHAIN_EDGE_CURVED',
          `edge ${join.edge} between faces ${join.parent.session.face} and ${child.face} develops to a curve${sharedNote(join.shared)} (${bend.toPrecision(4)} ${doc.units} off its chord): only edges that develop to straight lines (a generatrix of a cylinder, a straight edge of a plane) join two faces into one chart`,
        );
      const hit = child.query.projectOnFace(child.shape, child.face, [points[0] as Vec3])?.[0] ?? null;
      if (hit === null) return fail('WRP_KERNEL_BUILD_FAILED', `edge ${join.edge} does not project onto face ${child.face}`);
      const natural = buildChart(
        child.surface,
        { anchorChart: [0, 0], anchorOn: points[0] as Vec3, angleDeg: 0, mirror: false },
        'develop',
      );
      if ('error' in natural) return fail('WRP_CHAIN_FACE_UNSUPPORTED', `face ${child.face} has no develop chart (${natural.error})`);
      const orientation: 1 | -1 =
        hit.normal[0] * natural.normalAt(natural.anchorUv)[0] +
          hit.normal[1] * natural.normalAt(natural.anchorUv)[1] +
          hit.normal[2] * natural.normalAt(natural.anchorUv)[2] >=
        0
          ? 1
          : -1;
      const candidate = childChart(child, points, parentPoints, handedness, orientation);
      if (candidate === null || !(candidate.residual <= Math.max(tolerance, 1e-9 * length)))
        return fail(
          'WRP_CHAIN_EDGE_CURVED',
          `edge ${join.edge} does not develop to the same line on faces ${join.parent.session.face} and ${child.face}${sharedNote(join.shared)} (best match ${candidate?.residual.toPrecision(4) ?? 'none'} ${doc.units}): the faces cannot be unfolded into one chart`,
        );
      // the side of the edge each face lies on, found with the kernel's own point-in-face test on points of the charts
      const first = parentPoints[0] as Vec2;
      const last = parentPoints[parentPoints.length - 1] as Vec2;
      const direction: Vec2 = [(last[0] - first[0]) / length, (last[1] - first[1]) / length];
      const normal: Vec2 = [-direction[1], direction[0]];
      const middle: Vec2 = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
      const inside = (face: ChainFace, chart: FaceChart, sign: 1 | -1): boolean | null => {
        const offset = Math.max(1e-3 * length, 10 * tolerance);
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
      const parentClip: HalfPlane = { point: first, normal: [parentSide * normal[0], parentSide * normal[1]] };
      const childClip: HalfPlane = { point: first, normal: [-parentSide * normal[0], -parentSide * normal[1]] };
      const parent = join.parent;
      placed.set(parent.session.face, { ...parent, clips: [...parent.clips, parentClip] });
      placed.set(child.face, { session: child, chart: candidate.chart, orientation, clips: [childClip], probe: probeOf(child) });
      edges.push({
        edge: join.edge,
        faces: [parent.session.face, child.face],
        length,
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
  return { faces: sessions.map((s) => placed.get(s.face) as ChainFace), edges };
}
