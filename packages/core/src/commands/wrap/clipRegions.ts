/**
 * Half-plane clipping of chart regions and chains (03 WRP M5, multi-face wraps): the part of a sketch that lies on one side of the straight line a shared edge develops to.
 * Pieces are exact: a line is cut at the crossing, a NURBS segment by knot insertion at the crossing parameter (roots found by sampling and bisection to 1e-13).
 * @invariant the kept pieces are sub-curves of the input, nothing is re-fitted; a region cut by the line is closed by a chord along the line; the area of the kept part of a region plus
 *   the area of its other part is the area of the region
 * @failure crossings that do not pair into chords along the line (a boundary touching the line tangentially, inconsistent loop orientations) -> null
 */

import type { Vec2, Vec3 } from '../../model/vectors';
import { pointAt2, type NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import { curveDomain } from '../../lib/nurbs/evaluate';
import { splitCurve } from '../../lib/nurbs/curveSplit';
import { pointInPolygon } from '../../lib/polygon';
import { sampleSegment, segmentArea, segmentEnd, segmentStart, type PlaneSegment } from '../../geometry/planeSegments';
import type { ChartRegion } from './sketchProfiles';

/** The kept side is where `normal . (p - point) >= 0`. */
export interface HalfPlane {
  readonly point: Vec2;
  readonly normal: Vec2;
}

interface Piece {
  readonly segment: PlaneSegment;
  /** +1 kept, -1 dropped (a piece lying on the line is kept). */
  readonly side: 1 | -1;
}

const ROOT_SAMPLES = 48;

const signed = (plane: HalfPlane, p: Vec2): number => plane.normal[0] * (p[0] - plane.point[0]) + plane.normal[1] * (p[1] - plane.point[1]);

const lifted = (
  curve: NurbsCurve2Data,
): { degree: number; poles: Vec3[]; weights?: number[]; knots: number[]; multiplicities: number[] } => ({
  degree: curve.degree,
  poles: curve.poles.map(([x, y]): Vec3 => [x, y, 0]),
  ...(curve.weights === undefined ? {} : { weights: [...curve.weights] }),
  knots: [...curve.knots],
  multiplicities: [...curve.multiplicities],
});

/** Parameters where the curve crosses the line (sign changes between samples, refined by bisection). */
function crossings(curve: NurbsCurve2Data, plane: HalfPlane): number[] {
  const [first, last] = curveDomain(lifted(curve));
  const at = (k: number): number => first + ((last - first) * k) / ROOT_SAMPLES;
  const roots: number[] = [];
  let previous = signed(plane, pointAt2(curve, at(0)));
  for (let k = 1; k <= ROOT_SAMPLES; k++) {
    const value = signed(plane, pointAt2(curve, at(k)));
    if (previous * value < 0) {
      let [lo, hi] = [at(k - 1), at(k)];
      const lowSign = Math.sign(previous);
      for (let step = 0; step < 60; step++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(signed(plane, pointAt2(curve, mid))) === lowSign) lo = mid;
        else hi = mid;
      }
      roots.push((lo + hi) / 2);
    }
    previous = value;
  }
  return roots;
}

function sideOf(plane: HalfPlane, segment: PlaneSegment, scale: number): 1 | -1 {
  const mid = sampleSegment(segment, 3)[1] as Vec2;
  return signed(plane, mid) >= -1e-10 * scale ? 1 : -1;
}

/** The segment cut at the line, each piece with its side. */
function cut(segment: PlaneSegment, plane: HalfPlane, scale: number): Piece[] {
  if (segment.kind === 'line') {
    const d0 = signed(plane, segment.from);
    const d1 = signed(plane, segment.to);
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      const x: Vec2 = [segment.from[0] + t * (segment.to[0] - segment.from[0]), segment.from[1] + t * (segment.to[1] - segment.from[1])];
      const a: PlaneSegment = { kind: 'line', from: segment.from, to: x };
      const b: PlaneSegment = { kind: 'line', from: x, to: segment.to };
      return [
        { segment: a, side: d0 > 0 ? 1 : -1 },
        { segment: b, side: d1 > 0 ? 1 : -1 },
      ];
    }
    return [{ segment, side: sideOf(plane, segment, scale) }];
  }
  const roots = crossings(segment.curve, plane);
  if (roots.length === 0) return [{ segment, side: sideOf(plane, segment, scale) }];
  const parts = splitCurve(lifted(segment.curve), roots);
  if (typeof parts === 'string') return [{ segment, side: sideOf(plane, segment, scale) }];
  return parts.map((part) => {
    const flat: PlaneSegment = { kind: 'nurbs', curve: { ...part, poles: part.poles.map(([x, y]): Vec2 => [x, y]) } };
    return { segment: flat, side: sideOf(plane, flat, scale) };
  });
}

const sizeOf = (chains: ReadonlyArray<readonly PlaneSegment[]>): number =>
  Math.max(
    1e-12,
    ...chains.flatMap((chain) => chain.flatMap((segment) => sampleSegment(segment, 5).flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]))),
  );

interface Run {
  readonly pieces: PlaneSegment[];
  readonly start: Vec2;
  readonly end: Vec2;
}

/** The kept runs of a closed loop cut by the line; `whole` when the loop is entirely kept, `gone` when entirely dropped. */
function runsOfLoop(loop: readonly PlaneSegment[], plane: HalfPlane, scale: number): Run[] | 'whole' | 'gone' {
  const pieces = loop.flatMap((segment) => cut(segment, plane, scale));
  if (pieces.every((piece) => piece.side === 1)) return 'whole';
  if (pieces.every((piece) => piece.side === -1)) return 'gone';
  const begin = pieces.findIndex((piece, k) => piece.side === 1 && (pieces[(k + pieces.length - 1) % pieces.length] as Piece).side === -1);
  const runs: Run[] = [];
  let current: PlaneSegment[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const piece = pieces[(begin + k) % pieces.length] as Piece;
    if (piece.side === 1) current.push(piece.segment);
    else if (current.length > 0) {
      runs.push({
        pieces: current,
        start: segmentStart(current[0] as PlaneSegment),
        end: segmentEnd(current[current.length - 1] as PlaneSegment),
      });
      current = [];
    }
  }
  if (current.length > 0)
    runs.push({
      pieces: current,
      start: segmentStart(current[0] as PlaneSegment),
      end: segmentEnd(current[current.length - 1] as PlaneSegment),
    });
  return runs;
}

const loopArea = (loop: readonly PlaneSegment[]): number => loop.reduce((sum, segment) => sum + segmentArea(segment), 0);
const polygonOf = (loop: readonly PlaneSegment[]): Vec2[] => loop.flatMap((segment) => sampleSegment(segment, 9).slice(0, -1));

/**
 * `regions` cut by the line, keeping the plane's side: outer loops and holes cut by the line are rebuilt as closed loops with chords along the line.
 * @failure see the module comment -> null
 */
export function clipRegions(regions: readonly ChartRegion[], plane: HalfPlane): ChartRegion[] | null {
  const out: ChartRegion[] = [];
  const direction: Vec2 = [-plane.normal[1], plane.normal[0]];
  for (const region of regions) {
    const scale = sizeOf([region.outer]);
    const outer = runsOfLoop(region.outer, plane, scale);
    if (outer === 'gone') continue;
    const sign = Math.sign(loopArea(region.outer)) || 1;
    const loops: Array<readonly PlaneSegment[]> = [];
    const runs: Run[] = [];
    const consider = (loop: readonly PlaneSegment[]): void => {
      const result = loop === region.outer ? outer : runsOfLoop(loop, plane, scale);
      if (result === 'whole') loops.push(loop);
      else if (result !== 'gone') runs.push(...result);
    };
    consider(region.outer);
    for (const hole of region.holes) consider(hole);
    if (runs.length > 0) {
      const ends = runs.flatMap((run, index) => [
        {
          t: direction[0] * (run.start[0] - plane.point[0]) + direction[1] * (run.start[1] - plane.point[1]),
          kind: 'start' as const,
          index,
        },
        { t: direction[0] * (run.end[0] - plane.point[0]) + direction[1] * (run.end[1] - plane.point[1]), kind: 'end' as const, index },
      ]);
      ends.sort((a, b) => a.t - b.t);
      if (ends.length % 2 !== 0) return null;
      const partner = new Map<number, number>();
      for (let k = 0; k < ends.length; k += 2) {
        const [a, b] = [ends[k], ends[k + 1]] as [(typeof ends)[number], (typeof ends)[number]];
        if (a.kind === b.kind) return null;
        const [exit, entry] = a.kind === 'end' ? [a, b] : [b, a];
        partner.set(exit.index, entry.index);
      }
      const used = new Set<number>();
      for (let first = 0; first < runs.length; first++) {
        if (used.has(first)) continue;
        const loop: PlaneSegment[] = [];
        let at = first;
        for (let guard = 0; guard <= runs.length; guard++) {
          used.add(at);
          const run = runs[at] as Run;
          loop.push(...run.pieces);
          const next = partner.get(at);
          if (next === undefined) return null;
          const entry = (runs[next] as Run).start;
          if (Math.hypot(run.end[0] - entry[0], run.end[1] - entry[1]) > 1e-12 * scale)
            loop.push({ kind: 'line', from: run.end, to: entry });
          at = next;
          if (at === first) break;
          if (used.has(at)) return null;
        }
        if (at !== first) return null;
        loops.push(loop);
      }
    }
    const outers = loops.filter((loop) => Math.sign(loopArea(loop)) === sign);
    const holes = loops.filter((loop) => Math.sign(loopArea(loop)) !== sign);
    for (const outerLoop of outers) {
      const polygon = polygonOf(outerLoop);
      out.push({
        outer: outerLoop,
        holes: holes.filter((hole) =>
          pointInPolygon(segmentStart(hole[0] as PlaneSegment) as [number, number], polygon as Array<[number, number]>),
        ),
      });
    }
  }
  return out;
}

/** The kept runs of open chains and of closed loops cut by the line (no chords): the curves of a wrap. Loops entirely kept stay closed (`closed`). */
export function clipChains(
  chains: ReadonlyArray<{ readonly segments: readonly PlaneSegment[]; readonly closed: boolean }>,
  plane: HalfPlane,
): Array<{ segments: PlaneSegment[]; closed: boolean }> {
  const out: Array<{ segments: PlaneSegment[]; closed: boolean }> = [];
  const scale = sizeOf(chains.map((chain) => chain.segments));
  for (const chain of chains) {
    const pieces = chain.segments.flatMap((segment) => cut(segment, plane, scale));
    if (pieces.every((piece) => piece.side === 1)) {
      out.push({ segments: [...chain.segments], closed: chain.closed });
      continue;
    }
    let current: PlaneSegment[] = [];
    const flush = (): void => {
      if (current.length > 0) out.push({ segments: current, closed: false });
      current = [];
    };
    // a closed loop that starts on a kept piece continues its last run into the first one
    const rotateTo = chain.closed
      ? pieces.findIndex((piece, k) => piece.side === -1 && (pieces[(k + 1) % pieces.length] as Piece).side === 1)
      : -1;
    const ordered = rotateTo < 0 ? pieces : [...pieces.slice(rotateTo + 1), ...pieces.slice(0, rotateTo + 1)];
    for (const piece of ordered) {
      if (piece.side === 1) current.push(piece.segment);
      else flush();
    }
    flush();
  }
  return out;
}
