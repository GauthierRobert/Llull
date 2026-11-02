/**
 * Centreline to finite elements (07 PST §5.1): corners become bends (arc chords carrying the flexibility factor k, `bendChords`), straight legs are
 * split at attachment points (supports, restraints, forces) and so that no element exceeds the maximum length. Pure geometry; no document access.
 */

import { bendChords } from '@lib/frame3d/bend';
import type { Vec3 } from '@core/model/vectors';
import { computeSif, isSifRefusal } from '../code/sif';
import type { RuleSet } from '../code/ruleSets';
import type { SourcePipe } from './sources';

export interface FeElement {
  readonly id: string;
  readonly a: number;
  readonly b: number;
  readonly pipeId: string;
  readonly kind: 'straight' | 'bend';
  readonly odMm: number;
  readonly wallMm: number;
  /** Bend elements: flexibility and stress intensification of the bend, and the unit normal of the bend plane. */
  readonly bend?: { readonly radiusMm: number; readonly k: number; readonly ii: number; readonly io: number; readonly normal: Vec3 };
}

export interface Attachment {
  readonly key: string;
  readonly pipeId: string;
  readonly point: Vec3;
}

export interface Layout {
  readonly nodes: readonly Vec3[];
  readonly elements: readonly FeElement[];
  /** Node index per attachment key, and the unit axis of the piece it sits on. */
  readonly attached: ReadonlyMap<string, { readonly node: number; readonly axis: Vec3 }>;
  /** Node indices of the pipe ends (merged across pipes within 1 mm). */
  readonly endNodes: ReadonlyMap<string, readonly [number, number]>;
  readonly sharpCorners: readonly string[];
}

export interface LayoutFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

interface Piece {
  readonly kind: 'straight' | 'chord';
  readonly p: Vec3;
  readonly q: Vec3;
  readonly bend?: FeElement['bend'];
  /** Cut parameters in (0, 1) with the attachment keys snapped there. */
  readonly cuts: { t: number; keys: string[] }[];
  /** Attachment keys snapped to the start / end node. */
  readonly startKeys: string[];
  readonly endKeys: string[];
}

const MERGE_MM = 1;
const END_CLEARANCE_MM = 1;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = length(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[] = []): LayoutFailure => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

/** Point at arc length `atMm` along the polyline (clamped to its ends), or null when the polyline is empty. */
export function pointAtArc(points: readonly Vec3[], atMm: number): Vec3 | null {
  let remaining = atMm;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const b = points[i] as Vec3;
    const leg = length(sub(b, a));
    if (remaining <= leg || i === points.length - 1) return lerp(a, b, leg === 0 ? 0 : Math.min(1, remaining / leg));
    remaining -= leg;
  }
  return points[0] ?? null;
}

function piecesOf(pipe: SourcePipe, set: RuleSet, wallMm: number, radiusFactor: number): Piece[] | LayoutFailure {
  const pts = pipe.points;
  const vertexRadius = (i: number): number => pipe.bendRadii[i] ?? (radiusFactor > 0 ? radiusFactor * (pipe.dn ?? pipe.odMm) : 0);
  interface Corner {
    readonly near: Vec3;
    readonly far: Vec3;
    readonly chords: Vec3[];
    readonly bend: NonNullable<FeElement['bend']>;
    readonly tangent: number;
  }
  const corners = new Map<number, Corner>();
  for (let i = 1; i < pts.length - 1; i++) {
    const incoming = unit(sub(pts[i] as Vec3, pts[i - 1] as Vec3));
    const outgoing = unit(sub(pts[i + 1] as Vec3, pts[i] as Vec3));
    const radius = vertexRadius(i);
    if (radius <= 0 || dot(incoming, outgoing) > 1 - 1e-12) continue;
    const geometry = bendChords(pts[i] as Vec3, incoming, outgoing, radius);
    if (geometry === null)
      return fail('PST_BEND_TOO_TIGHT', `pipe ${pipe.id}: the turn at point ${i} is a reversal or the radius ${radius} mm is invalid`, [
        pipe.id,
      ]);
    const sif = computeSif(set, { component: 'elbow', odMm: pipe.odMm, wallMm, bendRadiusMm: radius });
    if (isSifRefusal(sif)) return fail('PST_BEND_TOO_TIGHT', `pipe ${pipe.id} point ${i}: ${sif.reason}`, [pipe.id], [`points.${i}`]);
    corners.set(i, {
      near: geometry.points[0] as Vec3,
      far: geometry.points[geometry.points.length - 1] as Vec3,
      chords: geometry.points as Vec3[],
      tangent: geometry.tangentLength,
      bend: { radiusMm: radius, k: sif.k, ii: sif.ii, io: sif.io, normal: unit(cross(incoming, outgoing)) },
    });
  }
  const pieces: Piece[] = [];
  const empty = (): Pick<Piece, 'cuts' | 'startKeys' | 'endKeys'> => ({ cuts: [], startKeys: [], endKeys: [] });
  for (let leg = 0; leg < pts.length - 1; leg++) {
    const startCorner = corners.get(leg);
    const endCorner = corners.get(leg + 1);
    const room = length(sub(pts[leg + 1] as Vec3, pts[leg] as Vec3)) - (startCorner?.tangent ?? 0) - (endCorner?.tangent ?? 0);
    if (room < -1e-6)
      return fail(
        'PST_BEND_TOO_TIGHT',
        `pipe ${pipe.id}: leg ${leg + 1} is ${(-room).toFixed(1)} mm shorter than the bend tangent lengths (bend radius ${(endCorner ?? startCorner)?.bend.radiusMm} mm)`,
        [pipe.id],
        [`points.${leg}`],
      );
    const from = startCorner?.far ?? (pts[leg] as Vec3);
    const to = endCorner?.near ?? (pts[leg + 1] as Vec3);
    if (room > 1e-6) pieces.push({ kind: 'straight', p: from, q: to, ...empty() });
    if (endCorner !== undefined) {
      const chordPoints = endCorner.chords;
      for (let c = 1; c < chordPoints.length; c++) {
        pieces.push({ kind: 'chord', p: chordPoints[c - 1] as Vec3, q: chordPoints[c] as Vec3, bend: endCorner.bend, ...empty() });
      }
    }
  }
  return pieces;
}

/** Nearest piece to `point`: the piece, its parameter and the distance. */
function nearest(pieces: readonly Piece[], point: Vec3): { piece: Piece; t: number; distance: number } | null {
  let best: { piece: Piece; t: number; distance: number } | null = null;
  for (const piece of pieces) {
    const d = sub(piece.q, piece.p);
    const l2 = dot(d, d);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(point, piece.p), d) / l2));
    const distance = length(sub(point, lerp(piece.p, piece.q, t)));
    if (best === null || distance < best.distance - 1e-9) best = { piece, t, distance };
  }
  return best;
}

/**
 * Builds nodes and elements of all pipes. Pipe ends within 1 mm of another pipe's end share a node; a pipe end on the interior of another pipe
 * (a branch) is refused (tees arrive with the 02 RTE components in M5).
 * @failure corner leg shorter than the tangent lengths / invalid bend -> PST_BEND_TOO_TIGHT; attachment farther than max(5 mm, OD) from its pipe -> PST_POINT_OFF_PIPE;
 *   branch -> PST_BRANCH_UNSUPPORTED
 */
export function buildLayout(
  pipes: readonly SourcePipe[],
  walls: ReadonlyMap<string, number>,
  set: RuleSet,
  options: { readonly maxElementLengthMm: number; readonly elbowRadiusFactor: number },
  attachments: readonly Attachment[],
): Layout | LayoutFailure {
  const nodes: Vec3[] = [];
  const mergeable: number[] = [];
  const nodeAt = (point: Vec3, merge: boolean): number => {
    if (merge) {
      const found = mergeable.find((index) => length(sub(nodes[index] as Vec3, point)) < MERGE_MM);
      if (found !== undefined) return found;
    }
    nodes.push(point);
    if (merge) mergeable.push(nodes.length - 1);
    return nodes.length - 1;
  };
  const elements: FeElement[] = [];
  const attached = new Map<string, { node: number; axis: Vec3 }>();
  const endNodes = new Map<string, readonly [number, number]>();
  const allPieces = new Map<string, Piece[]>();
  for (const pipe of pipes) {
    const pieces = piecesOf(pipe, set, walls.get(pipe.id) as number, options.elbowRadiusFactor);
    if (!Array.isArray(pieces)) return pieces;
    if (pieces.length === 0) return fail('PST_NO_PIPES', `pipe ${pipe.id} has no length`, [pipe.id]);
    allPieces.set(pipe.id, pieces);
  }
  for (const pipe of pipes) {
    const own = allPieces.get(pipe.id) as Piece[];
    for (const other of pipes) {
      if (other.id === pipe.id) continue;
      const ownStart = (own[0] as Piece).p;
      const ownEnd = (own[own.length - 1] as Piece).q;
      for (const end of [other.points[0], other.points[other.points.length - 1]] as Vec3[]) {
        if (length(sub(end, ownStart)) < MERGE_MM || length(sub(end, ownEnd)) < MERGE_MM) continue;
        const hit = nearest(own, end);
        if (hit !== null && hit.distance < MERGE_MM)
          return fail(
            'PST_BRANCH_UNSUPPORTED',
            `pipe ${other.id} ends on the interior of pipe ${pipe.id}: tees and branches arrive with M5`,
            [pipe.id, other.id],
          );
      }
    }
  }
  for (const attachment of attachments) {
    const pipe = pipes.find((candidate) => candidate.id === attachment.pipeId);
    const pieces = allPieces.get(attachment.pipeId);
    const hit = pieces === undefined ? null : nearest(pieces, attachment.point);
    if (pipe === undefined || hit === null || hit.distance > Math.max(5, pipe.odMm))
      return fail(
        'PST_POINT_OFF_PIPE',
        `${attachment.key} is ${hit === null ? 'on no modelled pipe' : `${hit.distance.toFixed(1)} mm from the centreline of pipe ${attachment.pipeId}`}`,
        [attachment.pipeId],
        [attachment.key],
      );
    const span = length(sub(hit.piece.q, hit.piece.p));
    if (hit.piece.kind === 'straight' && hit.t * span > END_CLEARANCE_MM && (1 - hit.t) * span > END_CLEARANCE_MM) {
      const existing = hit.piece.cuts.find((cut) => Math.abs(cut.t - hit.t) * span <= END_CLEARANCE_MM);
      if (existing === undefined) hit.piece.cuts.push({ t: hit.t, keys: [attachment.key] });
      else existing.keys.push(attachment.key);
    } else if (hit.t < 0.5) hit.piece.startKeys.push(attachment.key);
    else hit.piece.endKeys.push(attachment.key);
  }
  const sharpCorners: string[] = [];
  for (const pipe of pipes) {
    const pieces = allPieces.get(pipe.id) as Piece[];
    const wallMm = walls.get(pipe.id) as number;
    if (options.elbowRadiusFactor === 0 && Object.keys(pipe.bendRadii).length === 0 && pipe.points.length > 2) sharpCorners.push(pipe.id);
    let previous = -1;
    let first = -1;
    pieces.forEach((piece, pieceIndex) => {
      const axis = unit(sub(piece.q, piece.p));
      const start = previous >= 0 ? previous : nodeAt(piece.p, true);
      if (pieceIndex === 0) first = start;
      const cuts = [...piece.cuts].sort((a, b) => a.t - b.t);
      const span = length(sub(piece.q, piece.p));
      const last = pieceIndex === pieces.length - 1;
      let end = -1;
      const stops: { t: number; keys: string[] }[] = [{ t: 0, keys: piece.startKeys }, ...cuts, { t: 1, keys: piece.endKeys }];
      let from = start;
      for (let s = 1; s < stops.length; s++) {
        const stop = stops[s] as { t: number; keys: string[] };
        const before = stops[s - 1] as { t: number; keys: string[] };
        const parts =
          piece.kind === 'straight' ? Math.max(1, Math.ceil(((stop.t - before.t) * span) / options.maxElementLengthMm - 1e-9)) : 1;
        const inner = Array.from({ length: parts - 1 }, (_, part) =>
          nodeAt(lerp(piece.p, piece.q, before.t + ((stop.t - before.t) * (part + 1)) / parts), false),
        );
        const to = s === stops.length - 1 ? (end = nodeAt(piece.q, last)) : nodeAt(lerp(piece.p, piece.q, stop.t), false);
        let a = from;
        for (const b of [...inner, to]) {
          elements.push({
            id: `E${elements.length + 1}`,
            a,
            b,
            pipeId: pipe.id,
            kind: piece.kind === 'chord' ? 'bend' : 'straight',
            odMm: pipe.odMm,
            wallMm,
            ...(piece.bend === undefined ? {} : { bend: piece.bend }),
          });
          a = b;
        }
        for (const key of before.keys) attached.set(key, { node: from, axis });
        for (const key of stop.keys) attached.set(key, { node: to, axis });
        from = to;
      }
      previous = end;
    });
    endNodes.set(pipe.id, [first, previous]);
  }
  return { nodes, elements, attached, endNodes, sharpCorners };
}
