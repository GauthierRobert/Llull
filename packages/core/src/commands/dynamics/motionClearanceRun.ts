/**
 * The `check_motion_clearance` sweep (TECHNICAL_SPEC 5.6): part meshes carried by the simulated body poses, BVH minimum distance per
 * pair and moment, contact intervals, and the exact overlap volume at the worst pose of each interval.
 * @invariant deterministic: fixed pair order (part order, i < j), fixed sample order, no random
 * @invariant a pair never reports interference from surface contact alone: the overlap volume decides (touch = no volume)
 */

import type { CadDocument, Vec3 } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { type MeshBvh, buildMeshBvh, bvhMinDistance } from '../../geometry/meshBvh';
import type { AssemblyPart } from '../../geometry/assemblyCheck/partTypes';
import { overlapOf } from '../../geometry/assemblyCheck/pairClassify';
import { type CheckItem, findingKey } from '../../model/checkResult';
import { type BodyPoseAt, documentAtPose, pointAtPose } from '../../dynamics/bodyPose';
import {
  STATIC_POSE,
  type PoseTrack,
  isMoving,
  poseAt,
  relativeTransform,
  relativeTravelBound,
  travelBound,
} from '../../dynamics/motionPoses';
import { collectParts } from '../inspect/assemblyParts';
import { intentOf } from '../inspect/assemblyGraph';
import { bisectEdge, goldenMinimum } from './motionRefine';

/** Most substeps between two recorded samples (pose interpolation against tunnelling). */
const MAX_SUBSTEPS = 16;
/** Most contact intervals per pair whose overlap volume is computed with the kernel. */
const MAX_CLASSIFIED = 12;
/** Most intervals classified with the kernel across all pairs. */
export const MAX_CLASSIFIED_TOTAL = 200;
/** Most pair-moment evaluations (distance queries) of one run. */
export const MAX_EVALUATIONS = 300_000;
const VOLUME_RELATIVE = 1e-6;
const MAX_REPORTED_INTERVALS = 50;

export interface MotionPart {
  readonly part: AssemblyPart;
  readonly bvh: MeshBvh;
  /** Rigid body that carries the part while it moves; null = it never moves. */
  readonly body: string | null;
  /** Largest distance from the body's start centre of mass to a corner of the part's bounds (document units). */
  readonly radius: number;
  /** Smallest side of the part's bounds (document units): the tunnelling guard. */
  readonly thin: number;
}

export interface MotionPlan {
  readonly doc: CadDocument;
  readonly kernel: GeometryKernel;
  readonly parts: readonly MotionPart[];
  readonly pairs: ReadonlyArray<readonly [MotionPart, MotionPart]>;
  /** Every recorded sample: times (s), unwrapped crank angle (deg, or null) and the pose tracks per body. The stride only picks coarse anchors. */
  readonly times: readonly number[];
  readonly crankDeg: readonly number[] | null;
  readonly tracks: Readonly<Record<string, PoseTrack>>;
  /** Recorded samples between two coarse anchors of the sweep. */
  readonly stride: number;
  /** Document units: touch tolerance, required clearance. */
  readonly eps: number;
  readonly clearance: number;
  readonly mmPerUnit: number;
}

export interface MotionPlanInput {
  readonly doc: CadDocument;
  readonly kernel: GeometryKernel;
  readonly parts: readonly AssemblyPart[];
  readonly bodyOf: ReadonlyMap<string, string>;
  readonly poses: { readonly times: readonly number[]; readonly bodies: Readonly<Record<string, PoseTrack>> };
  readonly crankDeg: readonly number[] | null;
  readonly focus: ReadonlySet<string> | null;
  readonly includeStatic: boolean;
  readonly stride: number;
  readonly eps: number;
  readonly clearance: number;
  readonly mmPerUnit: number;
}

export function planMotion(input: MotionPlanInput): MotionPlan {
  const { poses } = input;
  const tracks = poses.bodies;
  const movingBodies = new Set(
    Object.entries(tracks)
      .filter(([, track]) => isMoving(track))
      .map(([id]) => id),
  );
  const parts: MotionPart[] = input.parts.map((part) => {
    const owner = input.bodyOf.get(part.id);
    const body = owner !== undefined && tracks[owner] !== undefined ? owner : null;
    const centre = body === null ? STATIC_POSE.start : (tracks[body]?.position[0] ?? STATIC_POSE.start);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) =>
      Math.hypot(
        (c & 1 ? part.max[0] : part.min[0]) - centre[0],
        (c & 2 ? part.max[1] : part.min[1]) - centre[1],
        (c & 4 ? part.max[2] : part.min[2]) - centre[2],
      ),
    );
    const thin = Math.min(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]);
    return { part, bvh: buildMeshBvh(part.mesh ?? { positions: [], indices: [] }), body, radius: Math.max(...corners), thin };
  });
  const moves = (p: MotionPart): boolean => p.body !== null && movingBodies.has(p.body);
  const pairs: Array<readonly [MotionPart, MotionPart]> = [];
  parts.forEach((a, i) => {
    for (const b of parts.slice(i + 1)) {
      if (a.body !== null && a.body === b.body) continue;
      if (!input.includeStatic && !moves(a) && !moves(b)) continue;
      if (input.focus !== null && !input.focus.has(a.part.id) && !input.focus.has(b.part.id)) continue;
      pairs.push([a, b]);
    }
  });
  return { ...input, parts, pairs, times: poses.times, tracks };
}

/** A place on the strided run: `u` = sample index plus fraction. */
interface Moment {
  readonly u: number;
  readonly timeS: number;
  readonly crankDeg: number | null;
}

function momentAt(plan: MotionPlan, u: number): Moment {
  const last = plan.times.length - 1;
  const i = Math.min(Math.floor(u), last);
  const f = i >= last ? 0 : u - i;
  const lerp = (series: readonly number[]): number => (series[i] ?? 0) + ((series[Math.min(i + 1, last)] ?? 0) - (series[i] ?? 0)) * f;
  const raw = plan.crankDeg === null ? null : lerp(plan.crankDeg);
  return { u, timeS: lerp(plan.times), crankDeg: raw === null ? null : ((raw % 360) + 360) % 360 };
}

function poseOf(plan: MotionPlan, part: MotionPart, u: number): BodyPoseAt {
  const track = part.body === null ? undefined : plan.tracks[part.body];
  if (track === undefined) return STATIC_POSE;
  const i = Math.min(Math.floor(u), plan.times.length - 1);
  return poseAt(track, i, u - i);
}

type Kind = 'interference' | 'touch' | 'unknown';

interface Interval {
  readonly from: Moment;
  to: Moment;
  evaluations: number;
  kind: Kind;
  volume: number | null;
  depth: number | null;
  /** Moment of the largest overlap and the contact points there (document units); null while unclassified. */
  worst: { moment: Moment; witness: readonly [Vec3, Vec3] } | null;
}

interface Closest {
  readonly distance: number;
  readonly moment: Moment;
  readonly witness: readonly [Vec3, Vec3];
}

export interface PairReport {
  readonly a: string;
  readonly b: string;
  readonly minClearanceMm: number | null;
  readonly timeS: number | null;
  readonly crankDeg: number | null;
  readonly witnessMm: readonly [Vec3, Vec3] | null;
  readonly status: 'interference' | 'allowed' | 'touch' | 'clearance_low' | 'clear';
  readonly collisions: ReadonlyArray<{
    readonly kind: Kind;
    readonly startTimeS: number;
    readonly endTimeS: number;
    readonly startCrankDeg: number | null;
    readonly endCrankDeg: number | null;
    readonly evaluations: number;
    readonly overlapVolumeMm3: number | null;
    readonly penetrationEstimateMm: number | null;
  }>;
}

const mmPoint = (p: Vec3, k: number): Vec3 => [p[0] * k, p[1] * k, p[2] * k];

function volumeAt(plan: MotionPlan, a: MotionPart, b: MotionPart, u: number): { volume: number; depth: number } | null {
  const poses: Record<string, BodyPoseAt> = {};
  for (const part of [a, b]) if (part.body !== null) poses[part.body] = poseOf(plan, part, u);
  const placed = collectParts(documentAtPose(plan.doc, poses), plan.kernel, new Set([a.part.id, b.part.id])).parts;
  const [first, second] = [placed.find((p) => p.id === a.part.id), placed.find((p) => p.id === b.part.id)];
  return first === undefined || second === undefined ? null : overlapOf(plan.kernel, first, second);
}

function contactAt(plan: MotionPlan, a: MotionPart, b: MotionPart, u: number): readonly [Vec3, Vec3] {
  const poseA = poseOf(plan, a, u);
  const hit = bvhMinDistance(a.bvh, b.bvh, plan.eps, relativeTransform(poseA, poseOf(plan, b, u)));
  return hit === null ? [poseA.position, poseA.position] : [pointAtPose(hit.pointA, poseA), pointAtPose(hit.pointB, poseA)];
}

/** Classifies up to `allowance` intervals (evenly spread) by overlap volume at their first, middle and last moment; returns how many it used. */
function classify(plan: MotionPlan, a: MotionPart, b: MotionPart, intervals: Interval[], allowance: number): number {
  const volumeOf = (part: MotionPart): number => plan.kernel.analyze?.(part.part.shape)?.volume ?? 0;
  const tolerance = VOLUME_RELATIVE * Math.min(volumeOf(a), volumeOf(b));
  const step = Math.max(1, Math.ceil(intervals.length / Math.max(1, Math.min(MAX_CLASSIFIED, allowance))));
  let used = 0;
  intervals.forEach((interval, index) => {
    if (index % step !== 0 || used >= allowance) return;
    used++;
    const [u0, u1] = [interval.from.u, interval.to.u];
    const found = [u0, (u0 + u1) / 2, u1].map((u) => ({ u, overlap: volumeAt(plan, a, b, u) }));
    if (found.some((entry) => entry.overlap === null)) return;
    const worst = found.reduce(
      (top, entry) => ((entry.overlap?.volume ?? 0) > (top.overlap?.volume ?? 0) ? entry : top),
      found[0] ?? { u: u0, overlap: null },
    );
    interval.volume = worst.overlap?.volume ?? 0;
    interval.depth = worst.overlap?.depth ?? 0;
    interval.kind = interval.volume > tolerance ? 'interference' : 'touch';
    interval.worst = { moment: momentAt(plan, worst.u), witness: contactAt(plan, a, b, worst.u) };
  });
  return used;
}

/** Work left for the whole run: pair-moment evaluations and kernel-classified intervals. */
export interface Budget {
  evaluations: number;
  classified: number;
}

interface Sweep {
  readonly best: Closest | null;
  readonly intervals: Interval[];
  readonly undersampled: boolean;
  readonly evaluations: number;
  readonly maxStepMm: number;
  readonly exhausted: boolean;
}

/**
 * One pair over the whole run. The sweep probes coarse anchors (every `plan.stride` recorded samples) and certifies the gap between two
 * anchors clear only when the distance cannot dip to the best-so-far / contact bound inside it: the distance changes by at most the
 * travel of both parts, summed from the per-sample travel bounds of the UNTHINNED track, so d(u) >= (d_from + d_to - travel) / 2.
 * An interval that is not certified is split down to single recorded samples, which get the substep treatment of the finest step.
 * @invariant no moment is skipped on a guess: a skipped stretch is certified, so thinning never hides a short contact
 */
function sweep(plan: MotionPlan, a: MotionPart, b: MotionPart, budget: Budget): Sweep {
  const lowBound = plan.clearance + plan.eps;
  const limit = Math.max(Math.min(a.thin, b.thin) / 2, 1e-9);
  const state: { best: Closest | null; bound: number } = { best: null, bound: Infinity };
  let evaluations = 0;
  const closestAt = (u: number, bound: number): Closest | null => {
    evaluations++;
    budget.evaluations--;
    const poseA = poseOf(plan, a, u);
    const hit = bvhMinDistance(a.bvh, b.bvh, bound, relativeTransform(poseA, poseOf(plan, b, u)));
    return hit === null
      ? null
      : { distance: hit.distance, moment: momentAt(plan, u), witness: [pointAtPose(hit.pointA, poseA), pointAtPose(hit.pointB, poseA)] };
  };
  const inContact = (u: number): boolean => (closestAt(u, plan.eps)?.distance ?? Infinity) <= plan.eps;
  const last = plan.times.length - 1;
  // cumulative travel over the recorded steps: prefix[k] = from sample 0 to sample k. `prefix` is the sum of both parts' absolute travel (sizes
  // the substeps of one step); `certified` is the smaller of that and the RELATIVE motion of b in a's frame (the frame the distance is
  // measured in), which proves a stretch clear for pairs that move together or turn about a common axis
  const prefix = [0];
  const certified = [0];
  const half = (min: Vec3, max: Vec3): { centre: Vec3; radius: number } => ({
    centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
  });
  const { centre: centreB, radius: radiusB } = half(b.part.min, b.part.max);
  for (let i = 0; i < last; i++) {
    const travel = [a, b].reduce((sum, part) => {
      const track = part.body === null ? undefined : plan.tracks[part.body];
      return track === undefined ? sum : sum + travelBound(track, i, part.radius);
    }, 0);
    prefix.push((prefix[i] ?? 0) + travel);
    const relative = relativeTravelBound(
      poseOf(plan, a, i),
      poseOf(plan, a, i + 1),
      poseOf(plan, b, i),
      poseOf(plan, b, i + 1),
      centreB,
      radiusB,
    );
    certified.push((certified[i] ?? 0) + Math.min(travel, relative));
  }
  const travelBetween = (from: number, to: number): number => (prefix[to] ?? 0) - (prefix[from] ?? 0);
  const certifiedBetween = (from: number, to: number): number => (certified[to] ?? 0) - (certified[from] ?? 0);
  const probes: { u: number; contact: boolean }[] = [];
  /** Probes moment `u`, looking `reach` beyond the bound; returns the distance there, or a lower bound of it when it is farther. */
  const probe = (u: number, reach: number): number => {
    const horizon = state.bound + reach;
    const seen = closestAt(u, horizon);
    const hit = seen !== null && seen.distance <= state.bound ? seen : null;
    if (hit !== null && (state.best === null || hit.distance < state.best.distance)) {
      state.best = hit;
      state.bound = Math.max(hit.distance, lowBound);
    }
    probes.push({ u, contact: hit !== null && hit.distance <= plan.eps });
    return seen?.distance ?? horizon;
  };
  let undersampled = false;
  let maxStep = 0;
  /** One recorded step: substeps sized by the travel against half the thinnest side of the pair. */
  const fine = (from: number, nearestEnd: number): void => {
    const travel = travelBetween(from, from + 1);
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / limit)));
    const stepSize = travel / substeps;
    maxStep = Math.max(maxStep, stepSize);
    let nearest = nearestEnd;
    for (let k = 1; k < substeps; k++) nearest = Math.min(nearest, probe(from + k / substeps, 0));
    if (stepSize > Math.min(a.thin, b.thin) && nearest < stepSize) undersampled = true;
  };
  const refine = (from: number, distanceFrom: number, to: number, distanceTo: number): void => {
    if (budget.evaluations < 0) return;
    const travel = certifiedBetween(from, to);
    if ((distanceFrom + distanceTo - travel) / 2 > state.bound) return;
    if (to - from <= 1) {
      fine(from, Math.min(distanceFrom, distanceTo));
      return;
    }
    const middle = Math.floor((from + to) / 2);
    const distanceMiddle = probe(middle, travel);
    refine(from, distanceFrom, middle, distanceMiddle);
    refine(middle, distanceMiddle, to, distanceTo);
  };
  let from = 0;
  let distanceFrom = probe(0, certifiedBetween(0, Math.min(plan.stride, last)));
  while (from < last && budget.evaluations >= 0) {
    const to = Math.min(from + plan.stride, last);
    const distanceTo = probe(to, certifiedBetween(from, to));
    refine(from, distanceFrom, to, distanceTo);
    [from, distanceFrom] = [to, distanceTo];
  }
  if (budget.evaluations < 0) return { best: state.best, intervals: [], undersampled, evaluations, maxStepMm: 0, exhausted: true };
  // contact intervals from the probed moments in time order; the edges are bisected inside the certified-clear stretches
  const intervals: Interval[] = [];
  let open: Interval | null = null;
  let previous: { u: number; contact: boolean } | null = null;
  for (const { u, contact } of [...probes].sort((p, q) => p.u - q.u)) {
    const moment = momentAt(plan, u);
    if (contact) {
      if (open === null) {
        const start = previous === null || previous.contact ? moment : momentAt(plan, bisectEdge(inContact, previous.u, u));
        open = { from: start, to: moment, evaluations: 0, kind: 'unknown', volume: null, depth: null, worst: null };
        intervals.push(open);
      }
      open.to = moment;
      open.evaluations++;
    } else {
      if (open !== null && previous !== null) open.to = momentAt(plan, bisectEdge(inContact, u, previous.u));
      open = null;
    }
    previous = { u, contact };
  }
  /** The closest approach between samples: golden-section search within one sample of the best sampled moment. */
  const best = state.best;
  if (best !== null && best.distance > plan.eps) {
    const bound = 2 * best.distance + plan.eps;
    const found = goldenMinimum(
      (u) => closestAt(u, bound)?.distance ?? Infinity,
      Math.max(0, best.moment.u - 1),
      Math.min(last, best.moment.u + 1),
      { u: best.moment.u, value: best.distance },
    );
    if (found.u !== best.moment.u) state.best = closestAt(found.u, bound) ?? best;
  }
  const used = classify(plan, a, b, intervals, budget.classified);
  budget.classified -= used;
  return { best: state.best, intervals, undersampled, evaluations, maxStepMm: maxStep * plan.mmPerUnit, exhausted: false };
}

const item = (
  code: string,
  status: CheckItem['status'],
  ids: readonly string[],
  remediation: string,
  extra: Partial<CheckItem>,
): CheckItem => ({
  code,
  status,
  ids: [...ids].sort(),
  findingKey: findingKey('motion_clearance', code, ids),
  values: {},
  remediation,
  ...extra,
});

export interface MotionOutcome {
  readonly pairs: PairReport[];
  readonly items: CheckItem[];
  readonly evaluations: number;
  /** The run hit its evaluation budget and stopped: the other fields are partial. */
  readonly exhausted: boolean;
}

const momentWitness = (moment: Moment, points: readonly Vec3[], mmPerUnit: number): NonNullable<CheckItem['witness']> => ({
  pointsMm: points.map((p) => mmPoint(p, mmPerUnit)),
  timeS: moment.timeS,
  ...(moment.crankDeg === null ? {} : { crankDeg: moment.crankDeg }),
});

type Verdict = Exclude<PairReport['status'], 'clearance_low' | 'clear'> | 'unclassified' | 'none';

/** Pair verdict from its intervals: a declared intent allows whatever the kind; unclassified intervals only warn next to classified touches. */
function verdictOf(intervals: readonly Interval[], intent: boolean): Verdict {
  const hard = intervals.some((interval) => interval.kind === 'interference');
  const unknown = intervals.some((interval) => interval.kind === 'unknown');
  if (intent && (hard || unknown)) return 'allowed';
  if (hard) return 'interference';
  if (unknown) return intervals.some((interval) => interval.kind === 'touch') ? 'unclassified' : 'interference';
  return intervals.length > 0 ? 'touch' : 'none';
}

export function runMotion(plan: MotionPlan, budget: Budget): MotionOutcome {
  const { mmPerUnit } = plan;
  const pairs: PairReport[] = [];
  const items: CheckItem[] = [];
  const undersampled = new Set<string>();
  let evaluations = 0;
  let maxStepMm = 0;
  for (const [a, b] of plan.pairs) {
    const ids = [a.part.id, b.part.id];
    const result = sweep(plan, a, b, budget);
    evaluations += result.evaluations;
    if (result.exhausted) return { pairs, items, evaluations, exhausted: true };
    maxStepMm = Math.max(maxStepMm, result.maxStepMm);
    if (result.undersampled) ids.forEach((id) => undersampled.add(id));
    const { best, intervals } = result;
    const intent = intentOf(plan.doc, a.part.id, b.part.id);
    const verdict = verdictOf(intervals, intent !== undefined);
    const contact = intervals.filter((interval) => interval.kind !== 'touch');
    const worst = contact.reduce<Interval | null>(
      (top, interval) => ((interval.volume ?? -1) > (top?.volume ?? -2) ? interval : top),
      null,
    );
    const lowClearance = intervals.length === 0 && best !== null && best.distance < plan.clearance;
    const status: PairReport['status'] =
      verdict === 'unclassified' ? 'interference' : verdict === 'none' ? (lowClearance ? 'clearance_low' : 'clear') : verdict;
    if (worst !== null) {
      const values: Record<string, number> = {
        intervals: contact.length,
        firstContactTimeS: contact[0]?.from.timeS ?? 0,
        minDistanceMm: 0,
        ...(worst.volume === null ? {} : { maxOverlapVolumeMm3: worst.volume * mmPerUnit ** 3 }),
        ...(worst.depth === null ? {} : { maxPenetrationEstimateMm: worst.depth * mmPerUnit }),
      };
      const witness = momentWitness(worst.worst?.moment ?? worst.from, worst.worst?.witness ?? best?.witness ?? [], mmPerUnit);
      const partial = contact.some((interval) => interval.kind === 'unknown');
      if (verdict === 'allowed' && intent !== undefined)
        items.push(
          item(
            'FPR_MOTION_ALLOWED',
            'pass',
            ids,
            `Declared ${intent.kind}: ${intent.reason}. Remove with delete_interference_intent when it no longer applies.`,
            { values, witness, intent: { id: intent.id, kind: intent.kind, reason: intent.reason, declaredBy: intent.declaredBy } },
          ),
        );
      else
        items.push(
          item(
            'FPR_MOTION_INTERFERENCE',
            verdict === 'unclassified' ? 'warn' : 'fail',
            ids,
            'Move or resize a part, change the mechanism geometry, or declare an intended overlap (press fit, weld) with allow_interference and a reason.',
            {
              values,
              witness,
              ...(partial
                ? {
                    unverified: true,
                    note: 'contact found but the overlap volume could not be computed for some intervals (kernel without analyze, or too many intervals)',
                  }
                : {}),
            },
          ),
        );
    } else if (verdict === 'touch')
      items.push(
        item('FPR_MOTION_TOUCH', 'info', ids, 'Parts touch during the motion with zero overlap volume (e.g. a pin in its bore).', {
          values: { intervals: intervals.length, firstContactTimeS: intervals[0]?.from.timeS ?? 0 },
        }),
      );
    else if (status === 'clearance_low' && best !== null)
      items.push(
        item('FPR_MOTION_CLEARANCE_LOW', 'warn', ids, 'Increase the gap at the reported time / crank angle, or lower clearanceMm.', {
          values: { minDistanceMm: best.distance * mmPerUnit, timeS: best.moment.timeS },
          witness: momentWitness(best.moment, best.witness, mmPerUnit),
          threshold: { value: plan.clearance * mmPerUnit, unit: 'mm', source: 'clearanceMm parameter', grade: 'A', defaulted: false },
        }),
      );
    pairs.push({
      a: a.part.id,
      b: b.part.id,
      minClearanceMm: best === null ? null : best.distance * mmPerUnit,
      timeS: best?.moment.timeS ?? null,
      crankDeg: best?.moment.crankDeg ?? null,
      witnessMm: best === null ? null : [mmPoint(best.witness[0], mmPerUnit), mmPoint(best.witness[1], mmPerUnit)],
      status,
      collisions: intervals
        .slice(0, MAX_REPORTED_INTERVALS)
        .map((interval) => ({
          kind: interval.kind,
          startTimeS: interval.from.timeS,
          endTimeS: interval.to.timeS,
          startCrankDeg: interval.from.crankDeg,
          endCrankDeg: interval.to.crankDeg,
          evaluations: interval.evaluations,
          overlapVolumeMm3: interval.volume === null ? null : interval.volume * mmPerUnit ** 3,
          penetrationEstimateMm: interval.depth === null ? null : interval.depth * mmPerUnit,
        })),
    });
  }
  if (undersampled.size > 0)
    items.push(
      item(
        'FPR_MOTION_UNDERSAMPLED',
        'warn',
        [...undersampled],
        'A part moves further between samples than the thinnest part side while another part is that close, even after interpolation: raise sampleRate or shorten duration so a thin obstacle cannot be skipped.',
        { values: { maxStepMm }, unverified: true, note: 'a pass for these parts may miss a short contact' },
      ),
    );
  return { pairs, items, evaluations, exhausted: false };
}
