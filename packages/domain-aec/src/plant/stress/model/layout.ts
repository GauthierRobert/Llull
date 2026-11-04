/**
 * Centreline to finite elements (07 PST §5.1): corners become bends (arc chords carrying the flexibility factor k, `bendChords`), straight legs are
 * split at attachment points (supports, restraints, forces, component faces, branch junctions) and so that no element exceeds the maximum length.
 * Components (valves, flanges, reducers) mark the elements between their faces; a branch pipe ending on another pipe becomes a tee node whose SIF
 * `applyJunctions` attaches. Pure geometry; no document access.
 */

import { bendChords } from '@lib/frame3d/bend';
import type { Vec3 } from '@core/model/vectors';
import { computeSif, isSifRefusal } from '../code/sif';
import type { RuleSet } from '../code/ruleSets';
import { applyJunctions, type JunctionFitting } from './junctions';
import type { Attachment, ElementComponent, FeElement, Layout, LayoutFailure } from './layoutTypes';
import { arcOf, sectionAt, vertexArcs, type Section, type SectionStep } from './sections';
import type { SourcePipe } from './sources';

export interface LayoutComponent {
  readonly key: string;
  readonly pipeId: string;
  readonly kind: ElementComponent['kind'];
  readonly faces: readonly [Vec3, Vec3];
  readonly rigid: boolean;
  readonly stiffnessFactor: number;
  readonly weightKg: number | null;
  /** Reducers: the section of the element between the faces. */
  readonly section?: Section;
}

export interface LayoutInput {
  readonly pipes: readonly SourcePipe[];
  /** Sections along each pipe (the first step starts at 0). */
  readonly sections: ReadonlyMap<string, readonly SectionStep[]>;
  readonly set: RuleSet;
  readonly options: { readonly maxElementLengthMm: number; readonly elbowRadiusFactor: number };
  readonly attachments: readonly Attachment[];
  readonly components: readonly LayoutComponent[];
  /** The fitting of the tee whose branch pipe is `branchPipeId`. */
  readonly fittingOf: (branchPipeId: string) => JunctionFitting;
}

interface Piece {
  readonly kind: 'straight' | 'chord';
  readonly p: Vec3;
  readonly q: Vec3;
  readonly bend?: FeElement['bend'];
  /** Chords: the section of the bend. */
  readonly bendSection?: Section;
  /** Cut parameters in (0, 1) with the attachment keys snapped there. */
  readonly cuts: { t: number; keys: string[] }[];
  /** Attachment keys snapped to the start / end node. */
  readonly startKeys: string[];
  readonly endKeys: string[];
}

const MERGE_MM = 1;
const END_CLEARANCE_MM = 1;
const JUNCTION = 'junction:';

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

function piecesOf(pipe: SourcePipe, set: RuleSet, steps: readonly SectionStep[], radiusFactor: number): Piece[] | LayoutFailure {
  const pts = pipe.points;
  const arcs = vertexArcs(pts);
  const vertexRadius = (i: number): number => pipe.bendRadii[i] ?? (radiusFactor > 0 ? radiusFactor * (pipe.dn ?? pipe.odMm) : 0);
  interface Corner {
    readonly near: Vec3;
    readonly far: Vec3;
    readonly chords: Vec3[];
    readonly bend: NonNullable<FeElement['bend']>;
    readonly section: Section;
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
    const section = sectionAt(steps, arcs[i] as number);
    const sif = computeSif(set, { component: 'elbow', odMm: section.odMm, wallMm: section.wallMm, bendRadiusMm: radius });
    if (isSifRefusal(sif)) return fail('PST_BEND_TOO_TIGHT', `pipe ${pipe.id} point ${i}: ${sif.reason}`, [pipe.id], [`points.${i}`]);
    corners.set(i, {
      near: geometry.points[0] as Vec3,
      far: geometry.points[geometry.points.length - 1] as Vec3,
      chords: geometry.points as Vec3[],
      tangent: geometry.tangentLength,
      section,
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
        pieces.push({
          kind: 'chord',
          p: chordPoints[c - 1] as Vec3,
          q: chordPoints[c] as Vec3,
          bend: endCorner.bend,
          bendSection: endCorner.section,
          ...empty(),
        });
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

/** Marks the elements between the faces of every component and gives reducers their section. */
function markComponents(
  elements: readonly FeElement[],
  components: readonly LayoutComponent[],
  attached: ReadonlyMap<string, { node: number }>,
): FeElement[] | LayoutFailure {
  const out = [...elements];
  for (const component of components) {
    const nodeA = attached.get(`component:${component.key}:a`)?.node;
    const nodeB = attached.get(`component:${component.key}:b`)?.node;
    if (nodeA === undefined || nodeB === undefined || nodeA === nodeB) continue;
    const first = out.findIndex((element) => element.pipeId === component.pipeId && element.a === nodeA);
    let last = first;
    while (last >= 0 && last < out.length && out[last]?.b !== nodeB && out[last]?.pipeId === component.pipeId) last++;
    if (first < 0 || last >= out.length || out[last]?.b !== nodeB)
      return fail(
        'PST_COMPONENT_UNSUPPORTED',
        `component ${component.key} does not lie on straight pipe between two nodes of ${component.pipeId}`,
        [component.pipeId],
      );
    const marked: ElementComponent = {
      key: component.key,
      kind: component.kind,
      rigid: component.rigid,
      stiffnessFactor: component.stiffnessFactor,
      weightKg: component.weightKg,
      elements: last - first + 1,
    };
    for (let i = first; i <= last; i++) {
      const element = out[i] as FeElement;
      if (element.kind === 'bend')
        return fail('PST_COMPONENT_UNSUPPORTED', `component ${component.key} lies on a bend of ${component.pipeId}`, [component.pipeId]);
      out[i] = { ...element, component: marked, ...(component.section === undefined ? {} : component.section) };
    }
  }
  return out;
}

/** Junction attachments: another pipe's end on the interior of a straight piece of `pipe` (a bend there is refused). */
function junctionAttachments(pipes: readonly SourcePipe[], allPieces: ReadonlyMap<string, Piece[]>): Attachment[] | LayoutFailure {
  const found: Attachment[] = [];
  for (const pipe of pipes) {
    const own = allPieces.get(pipe.id) as Piece[];
    const ownStart = (own[0] as Piece).p;
    const ownEnd = (own[own.length - 1] as Piece).q;
    for (const other of pipes) {
      if (other.id === pipe.id) continue;
      const ends: [number, Vec3][] = [
        [0, other.points[0] as Vec3],
        [1, other.points[other.points.length - 1] as Vec3],
      ];
      for (const [index, end] of ends) {
        if (length(sub(end, ownStart)) < MERGE_MM || length(sub(end, ownEnd)) < MERGE_MM) continue;
        const hit = nearest(own, end);
        if (hit === null || hit.distance >= MERGE_MM) continue;
        if (hit.piece.kind === 'chord')
          return fail('PST_BRANCH_UNSUPPORTED', `pipe ${other.id} ends on a bend of pipe ${pipe.id}: a branch needs straight header pipe`, [
            pipe.id,
            other.id,
          ]);
        found.push({ key: `${JUNCTION}${other.id}:${index}`, pipeId: pipe.id, point: end });
      }
    }
  }
  return found;
}

/**
 * Builds nodes and elements of all pipes. Pipe ends within 1 mm of another pipe's end share a node; a pipe end on the interior of another pipe is
 * a tee node (the header is cut there).
 * @failure corner leg shorter than the tangent lengths / invalid bend -> PST_BEND_TOO_TIGHT; attachment farther than max(5 mm, OD) from its pipe -> PST_POINT_OFF_PIPE;
 *   branch on a bend, within 1 mm of a node, or not a plain 90 degree tee -> PST_BRANCH_UNSUPPORTED; component on a bend -> PST_COMPONENT_UNSUPPORTED
 */
export function buildLayout(input: LayoutInput): Layout | LayoutFailure {
  const { pipes, sections, set, options, components } = input;
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
    const pieces = piecesOf(pipe, set, sections.get(pipe.id) as SectionStep[], options.elbowRadiusFactor);
    if (!Array.isArray(pieces)) return pieces;
    if (pieces.length === 0) return fail('PST_NO_PIPES', `pipe ${pipe.id} has no length`, [pipe.id]);
    allPieces.set(pipe.id, pieces);
  }
  const attachments: Attachment[] = [...input.attachments];
  for (const component of components)
    component.faces.forEach((point, face) =>
      attachments.push({ key: `component:${component.key}:${face === 0 ? 'a' : 'b'}`, pipeId: component.pipeId, point }),
    );
  const junctions = junctionAttachments(pipes, allPieces);
  if (!Array.isArray(junctions)) return junctions;
  attachments.push(...junctions);
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
    } else if (attachment.key.startsWith(JUNCTION))
      return fail(
        'PST_BRANCH_UNSUPPORTED',
        `pipe ${attachment.key.slice(JUNCTION.length).split(':')[0]} ends within 1 mm of a node of pipe ${attachment.pipeId} (a bend or a pipe end): move the branch onto straight pipe`,
        [attachment.pipeId],
      );
    else if (hit.t < 0.5) hit.piece.startKeys.push(attachment.key);
    else hit.piece.endKeys.push(attachment.key);
  }
  const sharpCorners: string[] = [];
  for (const pipe of pipes) {
    const pieces = allPieces.get(pipe.id) as Piece[];
    const steps = sections.get(pipe.id) as SectionStep[];
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
        const tAt = (part: number): number => before.t + ((stop.t - before.t) * part) / parts;
        const inner = Array.from({ length: parts - 1 }, (_, part) => nodeAt(lerp(piece.p, piece.q, tAt(part + 1)), false));
        const junction = stop.keys.some((key) => key.startsWith(JUNCTION));
        const to = s === stops.length - 1 ? (end = nodeAt(piece.q, last)) : nodeAt(lerp(piece.p, piece.q, stop.t), junction);
        let a = from;
        let part = 0;
        for (const b of [...inner, to]) {
          const section =
            piece.bendSection ?? sectionAt(steps, arcOf(pipe.points, lerp(piece.p, piece.q, (tAt(part) + tAt(part + 1)) / 2)));
          part++;
          elements.push({
            id: `E${elements.length + 1}`,
            a,
            b,
            pipeId: pipe.id,
            kind: piece.kind === 'chord' ? 'bend' : 'straight',
            odMm: section.odMm,
            wallMm: section.wallMm,
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
  const marked = markComponents(elements, components, attached);
  if (!Array.isArray(marked)) return marked;
  const tees = applyJunctions(nodes, marked, set, input.fittingOf);
  if ('ok' in tees) return tees;
  return { nodes, elements: tees.elements, attached, endNodes, sharpCorners, junctions: tees.junctions };
}
