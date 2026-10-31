/**
 * Mitred walls across a sharp edge (03 WRP M5, TECHNICAL_SPEC §14.15): an emboss or deboss whose outline crosses a straight edge between two plane faces is built face by face
 * (slabs with walls normal to their face). Where the offset surfaces of the two faces do not overlap the corner is closed with a mitre: a convex edge with an emboss, or a concave edge with
 * a deboss, leaves the column between the two end walls and the two offset planes empty (emboss) or standing (deboss), and a prism along the edge over the stretch the outline covers, whose cross-section is
 * (edge point, s d nA, M, s d nB), fills it (union) or removes it (subtract). In the other two cases the slabs overlap and the union is already the mitred corner.
 * @invariant M = s d (nA + nB) / (1 + nA . nB) (s = +1 emboss, -1 deboss) is the intersection of the two offset planes; the filler's length is the length of the intervals the outline covers on the edge,
 *   its volume area x length; `delta` is the change of the volume the closed forms of the faces miss: + the filler (emboss) / - the filler (deboss), - the overlap of the slabs (emboss) / + it (deboss)
 * @failure a curved piece of the outline crossing the edge, a crossing other than at right angles or through a vertex, an edge of unknown convexity, a curved edge or a non-plane face, an edge sharper than
 *   the mitre can follow (M farther than 20 d) -> `{ code, message }`. A crossing at an angle where the slabs overlap anyway is built, with `exact: false` (no closed-form volume)
 */

import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import { pointInPolygon } from '../../lib/polygon';
import { eulerFromAxes } from '../../lib/eulerRotation';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { newEntity } from '../entity/newEntity';
import type { Chain } from './chainCharts';
import type { ChartRegion } from './sketchProfiles';

export interface MitreFailure {
  readonly code: string;
  readonly message: string;
}

export interface MitreBuild {
  readonly fillers: ShapeRecipe[];
  /** Change of the volume change that the closed forms of the faces do not count (signed: emboss adds filler and loses overlap, deboss the opposite). */
  readonly delta: number;
  readonly fillerVolume: number;
  readonly overlapVolume: number;
  /** False when a sharp edge was crossed at an angle where only the overlap needs no filler: the closed form then misses the overlap. */
  readonly exact: boolean;
  /** Why the closed form is not exact (one entry per edge). */
  readonly reasons: string[];
  readonly edges: Array<{
    readonly edge: number;
    readonly kind: 'filler' | 'overlap';
    readonly intervals: number;
    readonly length: number;
    readonly area: number;
  }>;
}

export const isMitreFailure = (value: MitreBuild | MitreFailure): value is MitreFailure => 'code' in value;

const PERPENDICULAR = 1e-6;
const MAX_REACH = 20;

/**
 * The crossings of the loops of `regions` with the line through `first` in direction `dir`, as sorted positions along the line, or the reason they cannot be used. Only the stretch [-tolerance, length + tolerance]
 * of the line is the edge: pieces that meet the line beyond its ends belong to another edge of the chain and are ignored.
 */
function crossings(regions: readonly ChartRegion[], first: Vec2, dir: Vec2, edge: number, length: number): number[] | string {
  const side = (p: Vec2): number => dir[0] * (p[1] - first[1]) - dir[1] * (p[0] - first[0]);
  const along = (p: Vec2): number => (p[0] - first[0]) * dir[0] + (p[1] - first[1]) * dir[1];
  const slack = 1e-9 * Math.max(1, length);
  const onEdge = (position: number): boolean => position >= -slack && position <= length + slack;
  const found: number[] = [];
  for (const region of regions)
    for (const loop of [region.outer, ...region.holes])
      for (const piece of loop as readonly PlaneSegment[]) {
        if (piece.kind !== 'line') {
          const points = sampleSegment(piece, 33);
          const samples = points.map(side);
          const crossesAt = samples.findIndex((value, k) => k > 0 && value * (samples[k - 1] as number) <= 0);
          if (crossesAt > 0 && onEdge(along(points[crossesAt] as Vec2)))
            return `a curved piece of the outline crosses edge ${edge}: a mitre is built for straight segments that cross the edge at right angles`;
          continue;
        }
        const [sa, sb] = [side(piece.from), side(piece.to)];
        const onLine = Math.abs(sa) < 1e-9 * Math.max(1, length) ? piece.from : Math.abs(sb) < 1e-9 * Math.max(1, length) ? piece.to : null;
        if (onLine !== null) {
          if (onEdge(along(onLine)))
            return `a vertex of the outline lies on the line of edge ${edge}: move the sketch so that it crosses the edge between two vertices`;
          continue;
        }
        if (sa * sb > 0) continue;
        const direction: Vec2 = [piece.to[0] - piece.from[0], piece.to[1] - piece.from[1]];
        const t = sa / (sa - sb);
        const position = along([piece.from[0] + t * direction[0], piece.from[1] + t * direction[1]]);
        if (!onEdge(position)) continue;
        const span = Math.hypot(direction[0], direction[1]);
        if (!(span > 0) || Math.abs((direction[0] * dir[0] + direction[1] * dir[1]) / span) > PERPENDICULAR)
          return `the outline meets edge ${edge} at an angle: the normal walls of the two faces would not meet in a mitre; rotate the sketch so that its segments cross the edge at right angles, or use scribe`;
        found.push(position);
      }
  return found.sort((x, y) => x - y);
}

const loopPolygon = (loop: readonly PlaneSegment[]): Vec2[] =>
  loop.flatMap((piece) => (piece.kind === 'line' ? [piece.from] : sampleSegment(piece, 33).slice(0, -1)));

const insideRegions = (regions: readonly ChartRegion[], point: Vec2): boolean =>
  regions.some(
    (region) => pointInPolygon(point, loopPolygon(region.outer)) && !region.holes.some((hole) => pointInPolygon(point, loopPolygon(hole))),
  );

/** True when the outline contains the strip [s0, s1] x [-reach, reach] about the edge line (sampled), i.e. the slabs of both faces reach as far as the mitre does. */
function stripInside(regions: readonly ChartRegion[], first: Vec2, dir: Vec2, s0: number, s1: number, reach: number): boolean {
  const across: Vec2 = [-dir[1], dir[0]];
  for (let i = 0; i < 9; i++)
    for (let j = 0; j <= 16; j++) {
      const position = s0 + ((s1 - s0) * (i + 0.5)) / 9;
      const offset = reach * (1 - 1e-9) * (-1 + (2 * j) / 16);
      if (!insideRegions(regions, [first[0] + dir[0] * position + across[0] * offset, first[1] + dir[1] * position + across[1] * offset]))
        return false;
    }
  return true;
}

/** True when some loop of the outline comes within `reach` of the edge (the band about its stretch). */
function outlineNear(regions: readonly ChartRegion[], first: Vec2, dir: Vec2, length: number, reach: number): boolean {
  return regions.some((region) =>
    [region.outer, ...region.holes].some((loop) =>
      loopPolygon(loop).some((point) => {
        const along = (point[0] - first[0]) * dir[0] + (point[1] - first[1]) * dir[1];
        const side = dir[0] * (point[1] - first[1]) - dir[1] * (point[0] - first[0]);
        return along >= -reach && along <= length + reach && Math.abs(side) <= reach;
      }),
    ),
  );
}

const area2 = (polygon: readonly Vec2[]): number =>
  polygon.reduce(
    (sum, p, k) => sum + p[0] * (polygon[(k + 1) % polygon.length] as Vec2)[1] - (polygon[(k + 1) % polygon.length] as Vec2)[0] * p[1],
    0,
  ) / 2;

/** Sutherland-Hodgman: the convex `subject` clipped by the convex counter-clockwise `clip`. */
function clipConvex(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  let output = [...subject];
  for (let k = 0; k < clip.length && output.length > 0; k++) {
    const [a, b] = [clip[k] as Vec2, clip[(k + 1) % clip.length] as Vec2];
    const inside = (p: Vec2): boolean => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const [p, q] = [input[j] as Vec2, input[(j + 1) % input.length] as Vec2];
      const [ip, iq] = [inside(p), inside(q)];
      if (ip !== iq) {
        const [dp, dq] = [
          (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]),
          (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]),
        ];
        const t = dp / (dp - dq);
        output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
      if (iq) output.push(q);
    }
  }
  return output;
}

const counterClockwise = (polygon: Vec2[]): Vec2[] => (area2(polygon) < 0 ? [...polygon].reverse() : polygon);

/**
 * The fillers of the sharp edges the outline crosses, or null when every edge it crosses is smooth.
 * @param inked the faces that carry a part of the outline
 */
export function mitreFillers(input: {
  readonly chain: Chain;
  readonly inked: ReadonlySet<number>;
  readonly regions: readonly ChartRegion[];
  readonly mode: 'emboss' | 'deboss';
  readonly depth: number;
}): MitreBuild | MitreFailure | null {
  const { chain, mode, depth } = input;
  const sign = mode === 'emboss' ? 1 : -1;
  const fillers: ShapeRecipe[] = [];
  const edges: MitreBuild['edges'] = [];
  let delta = 0;
  let fillerVolume = 0;
  let overlapVolume = 0;
  let exact = true;
  const reasons: string[] = [];
  for (const edge of chain.edges) {
    if (!edge.faces.every((face) => input.inked.has(face)) || edge.convexity === 'smooth') continue;
    const unsupported = (why: string): MitreFailure => ({
      code: 'WRP_CHAIN_EDGE_SHARP',
      message: `edge ${edge.edge} between faces ${edge.faces.join(' and ')} is a ${edge.convexity} edge the sketch crosses: ${why}; use scribe, round the edge first (fillet_edge), or emboss each face separately`,
    });
    if (edge.convexity === 'unknown')
      return unsupported('the kernel could not say whether it is convex or concave, so the mitre cannot be chosen');
    const faces = edge.faces.map((index) => chain.faces.find((face) => face.session.face === index));
    if (faces.some((face) => face === undefined || face.session.surface.type !== 'plane'))
      return unsupported('mitred walls are built across straight edges between two plane faces');
    const [e0, e1] = edge.world;
    const direction = sub3(e1, e0);
    const e3 = scale3(direction, 1 / len3(direction));
    const middle = add3(e0, scale3(direction, 0.5));
    const perpendicularTo = (v: Vec3): Vec3 => sub3(v, scale3(e3, dot3(v, e3)));
    const normals = faces.map((face) => {
      const hit = face?.session.query.projectOnFace(face.session.shape, face.session.face, [middle])?.[0];
      return hit === undefined || hit === null ? null : normalize3(perpendicularTo(hit.normal));
    });
    const [nA, nB] = normals;
    if (nA === null || nB === null || nA === undefined || nB === undefined)
      return unsupported('the kernel gave no normal of a face at the edge');
    const cosine = dot3(nA, nB);
    const m = scale3(add3(nA, nB), (sign * depth) / (1 + cosine));
    if (!(1 + cosine > 1e-9) || len3(m) > MAX_REACH * depth)
      return unsupported(
        `the edge is sharper than the mitre can follow (the normals of its two faces are ${((Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI).toFixed(1)} degrees apart)`,
      );
    const b1 = nA;
    const b2 = cross3(e3, b1);
    const local = (v: Vec3): Vec2 => [dot3(v, b1), dot3(v, b2)];
    const towards = (face: (typeof faces)[number]): Vec3 => normalize3(perpendicularTo(sub3((face?.probe ?? middle) as Vec3, middle)));
    // a slab of one face in the plane of the cross-section: along the face from the edge, and off the face by s d
    const inwardOf = (normal: Vec3, face: (typeof faces)[number]): Vec3 =>
      normalize3(sub3(towards(face), scale3(normal, dot3(towards(face), normal))));
    const slab = (normal: Vec3, inward: Vec3): Vec2[] => {
      const reach = 4 * MAX_REACH * depth;
      return counterClockwise([
        [0, 0],
        local(scale3(inward, reach)),
        local(add3(scale3(inward, reach), scale3(normal, sign * depth))),
        local(scale3(normal, sign * depth)),
      ]);
    };
    const [inwardA, inwardB] = [inwardOf(nA, faces[0]), inwardOf(nB, faces[1])];
    const clip = clipConvex(slab(nA, inwardA), slab(nB, inwardB));
    const overlap = Math.abs(area2(clip));
    // how far from the edge, along each face, the region between the slabs reaches: the outline must cover that much of both faces for the closed form to hold
    const reachOf = (polygon: readonly Vec2[]): number =>
      Math.max(
        0,
        ...polygon.map((p) =>
          Math.max(p[0] * dot3(inwardA, b1) + p[1] * dot3(inwardA, b2), p[0] * dot3(inwardB, b1) + p[1] * dot3(inwardB, b2)),
        ),
      );
    const needs = (edge.convexity === 'convex') === (mode === 'emboss');
    const gap = counterClockwise([[0, 0], local(scale3(nA, sign * depth)), local(m), local(scale3(nB, sign * depth))]);
    const [first, last] = edge.line;
    const lineLength = Math.hypot(last[0] - first[0], last[1] - first[1]);
    const dir: Vec2 = [(last[0] - first[0]) / lineLength, (last[1] - first[1]) / lineLength];
    const found = crossings(input.regions, first, dir, edge.edge, lineLength);
    const columnReach = reachOf(clip);
    if (typeof found === 'string') {
      if (needs) return unsupported(found);
      exact = false;
      reasons.push(`edge ${edge.edge}: ${found}`);
      continue;
    }
    if (found.length % 2 !== 0) {
      if (needs) return unsupported('the outline crosses the edge an odd number of times');
      exact = false;
      reasons.push(`edge ${edge.edge}: the outline crosses it an odd number of times`);
      continue;
    }
    let covered = 0;
    let count = 0;
    for (let k = 0; k + 1 < found.length; k += 2) {
      const [s0, s1] = [found[k] as number, found[k + 1] as number];
      // a filler is a column beside the edge, outside both slabs, whatever the width of the outline; the overlap of the slabs is only as wide as the outline is
      if (!needs && !stripInside(input.regions, first, dir, s0, s1, columnReach)) {
        exact = false;
        reasons.push(`edge ${edge.edge}: the outline covers less than the overlap of the two slabs`);
      }
      covered += s1 - s0;
      count += 1;
      if (!needs) continue;
      fillers.push({
        op: 'place',
        source: {
          op: 'solid',
          entity: newEntity('extrusion', `mitre-${edge.edge}.${count}`, { profile: gap, depth: s1 - s0 }, [0, 0, 0], '#cccccc'),
        },
        position: add3(e0, scale3(e3, s0)),
        rotation: eulerFromAxes(b1, b2, e3),
      });
    }
    if (count === 0) {
      if (!needs && outlineNear(input.regions, first, dir, lineLength, columnReach)) {
        exact = false;
        reasons.push(`edge ${edge.edge}: the outline lies beside the edge without crossing it`);
      }
      continue;
    }
    if (needs) {
      fillerVolume += Math.abs(area2(gap)) * covered;
      delta += sign * Math.abs(area2(gap)) * covered;
      edges.push({ edge: edge.edge, kind: 'filler', intervals: count, length: covered, area: Math.abs(area2(gap)) });
    } else {
      overlapVolume += overlap * covered;
      delta -= sign * overlap * covered;
      edges.push({ edge: edge.edge, kind: 'overlap', intervals: count, length: covered, area: overlap });
    }
  }
  return edges.length === 0 && exact ? null : { fillers, delta, fillerVolume, overlapVolume, exact, reasons, edges };
}
