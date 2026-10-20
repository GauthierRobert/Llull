/** Zone blending, ply drop ranks and ramps (06 CMP §5.6): the zone stacks become one master sequence of plies with regions and ramp offsets. */

import type { CompositePart, PlyDropRules, Zone } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { clipToConvex, isConvex, unionPolygons } from '@lib/polygonBoolean';
import { offsetPolygon, pointInPolygon, polygonArea, segmentsIntersect } from '@lib/polygon';
import { boundaryDistance, insideOrOn } from './geometry2d';

export interface BlendedPly {
  /** Index in the master sequence (0 = tool side). */
  readonly index: number;
  readonly angle: number;
  /** Zones that contain this ply. */
  readonly zoneIds: readonly string[];
  /** 1 = first dropped; 0 = continuous over the whole face. */
  readonly dropRank: number;
  /** Ramp extension beyond the full-thickness region, document units. */
  readonly extension: number;
  /** Final regions (full-thickness region plus the ramp) in the part frame. */
  readonly polygons: readonly (readonly Vec2[])[];
}

export interface RampConflict {
  readonly zoneIds: readonly string[];
  /** Ramp width this group of plies needs (document units). */
  readonly needed: number;
  /** Distance to the next boundary (document units). */
  readonly available: number;
  readonly location: Vec2;
}

export type BlendResult =
  | {
      readonly ok: true;
      readonly master: readonly number[];
      readonly plies: readonly BlendedPly[];
      readonly conflicts: readonly RampConflict[];
    }
  | {
      readonly ok: false;
      readonly code:
        | 'CMP_ZONES_NOT_BLENDABLE'
        | 'CMP_ZONES_EQUAL_THICKNESS_CONFLICT'
        | 'CMP_COVER_PLIES_DROPPED'
        | 'CMP_OUTLINE_NOT_CONVEX';
      readonly message: string;
      readonly zoneIds: readonly string[];
    };

const sameStack = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((angle, i) => angle === b[i]);

/** Greedy indices of `wanted` in `master` scanning from the start (`from` = 'start') or the end; null when not embeddable. */
function greedy(master: readonly number[], wanted: readonly number[], from: 'start' | 'end', limit: number): number[] | null {
  const indices: number[] = [];
  let position = from === 'start' ? 0 : master.length - 1;
  const step = from === 'start' ? 1 : -1;
  for (const angle of wanted) {
    while (position >= 0 && position < master.length && master[position] !== angle) position += step;
    if (position < 0 || position >= master.length) return null;
    indices.push(position);
    position += step;
  }
  return indices.length <= limit ? indices : null;
}

/** Master indices of a zone stack: symmetric halves matched from both ends inward, else plain leftmost subsequence; null when infeasible. */
function embed(master: readonly number[], stack: readonly number[]): number[] | null {
  const n = stack.length;
  const half = Math.floor(n / 2);
  const bottom = greedy(master, stack.slice(0, half), 'start', n);
  const top = greedy(master, stack.slice(n - half).reverse(), 'end', n);
  if (bottom !== null && top !== null) {
    const lastBottom = bottom.length > 0 ? (bottom[bottom.length - 1] as number) : -1;
    const firstTop = top.length > 0 ? (top[top.length - 1] as number) : master.length;
    if (n % 2 === 0 ? lastBottom < firstTop : true) {
      if (n % 2 === 0) return [...bottom, ...top.reverse()];
      const middle = master.findIndex((angle, i) => i > lastBottom && i < firstTop && angle === stack[half]);
      if (middle >= 0) return [...bottom, middle, ...top.reverse()];
    }
  }
  return greedy(master, stack, 'start', n);
}

/** True when the two zone polygons share interior area (touching along an edge does not count). */
function overlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  const inside = (p: Vec2, polygon: readonly Vec2[]): boolean => pointInPolygon(p, polygon) && boundaryDistance(p, polygon) > 1e-6;
  const crossing = a.some((p, i) =>
    b.some((q, j) => segmentsIntersect(p, a[(i + 1) % a.length] as Vec2, q, b[(j + 1) % b.length] as Vec2)),
  );
  const centre = (polygon: readonly Vec2[]): Vec2 => [
    polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length,
    polygon.reduce((sum, [, y]) => sum + y, 0) / polygon.length,
  ];
  return a.some((p) => inside(p, b)) || b.some((p) => inside(p, a)) || crossing || inside(centre(a), b) || inside(centre(b), a);
}

/** Sample points along the edges of `polygon`, about every `spacing` units (at most 400 per edge). */
function samples(polygon: readonly Vec2[], spacing: number): Vec2[] {
  return polygon.flatMap((a, i) => {
    const b = polygon[(i + 1) % polygon.length] as Vec2;
    const count = Math.min(400, Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing)));
    return Array.from({ length: count + 1 }, (_, k): Vec2 => [a[0] + ((b[0] - a[0]) * k) / count, a[1] + ((b[1] - a[1]) * k) / count]);
  });
}

const coversFace = (union: readonly (readonly Vec2[])[], outline: readonly Vec2[]): boolean =>
  outline.every((vertex) => union.some((polygon) => insideOrOn(vertex, polygon))) &&
  union.reduce((sum, polygon) => sum + polygonArea(polygon), 0) >= polygonArea(outline) * (1 - 1e-9);

/**
 * Blends the zone stacks of a part into plies.
 * @invariant plies are listed bottom to top; a ply's regions = union of its zones, extended by rank * max(t * rampRatio, minStagger) and clipped to a convex face outline
 * @failure a stack that does not embed in the master -> CMP_ZONES_NOT_BLENDABLE (both zones named); equally thick distinct maxima -> CMP_ZONES_EQUAL_THICKNESS_CONFLICT; cover plies not in every zone -> CMP_COVER_PLIES_DROPPED
 */
export function blendZones(zones: readonly Zone[], part: CompositePart, rules: PlyDropRules, plyThickness: number): BlendResult {
  const longest = Math.max(...zones.map((zone) => zone.angles.length));
  const thickest = zones.filter((zone) => zone.angles.length === longest);
  const masterZone = thickest[0] as Zone;
  const conflicting = thickest.find((zone) => !sameStack(zone.angles, masterZone.angles));
  if (conflicting !== undefined)
    return {
      ok: false,
      code: 'CMP_ZONES_EQUAL_THICKNESS_CONFLICT',
      message: `zones "${masterZone.name}" and "${conflicting.name}" both have ${longest} plies but different stacks`,
      zoneIds: [masterZone.id, conflicting.id],
    };
  const master = masterZone.angles;
  const embeddings = new Map<string, number[]>();
  for (const zone of zones) {
    const indices = embed(master, zone.angles);
    if (indices === null)
      return {
        ok: false,
        code: 'CMP_ZONES_NOT_BLENDABLE',
        message: `the stack of zone "${zone.name}" does not embed in the thickest zone "${masterZone.name}"`,
        zoneIds: [zone.id, masterZone.id],
      };
    embeddings.set(zone.id, indices);
  }
  for (const a of zones)
    for (const b of zones) {
      if (a.id >= b.id || !overlap(a.boundary, b.boundary)) continue;
      const [high, low] = a.priority >= b.priority ? [a, b] : [b, a];
      const lowSet = embeddings.get(low.id) as number[];
      const highSet = new Set(embeddings.get(high.id));
      if (a.priority === b.priority || lowSet.some((index) => !highSet.has(index)))
        return {
          ok: false,
          code: 'CMP_ZONES_NOT_BLENDABLE',
          message: `zones "${a.name}" and "${b.name}" overlap and the higher-priority one is not the thicker (priorities ${a.priority}, ${b.priority}); nest thicker zones inside thinner ones with a higher priority`,
          zoneIds: [a.id, b.id],
        };
    }
  const cover = Math.min(rules.coverPlies, Math.floor(master.length / 2));
  const coverIndices = [...Array.from({ length: cover }, (_, i) => i), ...Array.from({ length: cover }, (_, i) => master.length - 1 - i)];
  for (const zone of zones) {
    const held = new Set(embeddings.get(zone.id));
    if (coverIndices.some((index) => !held.has(index)))
      return {
        ok: false,
        code: 'CMP_COVER_PLIES_DROPPED',
        message: `zone "${zone.name}" does not carry the ${rules.coverPlies} outer cover ply(ies) of every surface`,
        zoneIds: [zone.id],
      };
  }
  const support = master.map((_, index) => zones.filter((zone) => embeddings.get(zone.id)?.includes(index)));
  const groups = new Map<string, number[]>();
  support.forEach((zs, index) => {
    const key = zs.map((zone) => zone.id).join('|');
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const middle = (master.length - 1) / 2;
  const step = Math.max(
    plyThickness * rules.rampRatio,
    rules.staggerUnit === 'length' ? rules.minStagger : rules.minStagger * plyThickness,
  );
  const rankOf = new Map<number, number>();
  for (const members of groups.values()) {
    const sorted = [...members].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
    (rules.dropOrder === 'inner_first' ? sorted : sorted.reverse()).forEach((index, k) => rankOf.set(index, k + 1));
  }
  const convexOutline = isConvex(part.outline);
  const rampGroups = [...groups.values()].filter((members) => {
    const zs = support[members[0] as number] as Zone[];
    return !coversFace(unionPolygons(zs.map((zone) => zone.boundary)), part.outline);
  });
  if (!convexOutline && rampGroups.length > 0)
    return {
      ok: false,
      code: 'CMP_OUTLINE_NOT_CONVEX',
      message: 'ramps need a convex tool-face outline (the grown ramp regions cannot be clipped to a concave one yet)',
      zoneIds: [],
    };
  const conflicts: RampConflict[] = [];
  const plies = master.map((angle, index): BlendedPly => {
    const zs = support[index] as Zone[];
    const union = unionPolygons(zs.map((zone) => zone.boundary));
    if (coversFace(union, part.outline))
      return { index, angle, zoneIds: zs.map((z) => z.id), dropRank: 0, extension: 0, polygons: [[...part.outline]] };
    const dropRank = rankOf.get(index) as number;
    const extension = dropRank * step;
    const grown = unionPolygons(union.map((polygon) => offsetPolygon(polygon, extension)));
    const polygons = grown.map((polygon) => clipToConvex(polygon, part.outline)).filter((polygon) => polygon.length >= 3);
    return { index, angle, zoneIds: zs.map((z) => z.id), dropRank, extension, polygons };
  });
  for (const [key, members] of groups) {
    const zs = support[members[0] as number] as Zone[];
    const union = unionPolygons(zs.map((zone) => zone.boundary));
    if (coversFace(union, part.outline)) continue;
    const needed = Math.max(...members.map((index) => rankOf.get(index) as number)) * step;
    const others = [...zones.filter((zone) => !key.split('|').includes(zone.id)).map((zone) => zone.boundary), part.outline];
    let worst: RampConflict | null = null;
    const touches = (point: Vec2): boolean => union.some((polygon) => boundaryDistance(point, polygon) <= 1e-6);
    for (const boundary of others)
      for (const [i, from] of boundary.entries()) {
        const edge = samples([from, boundary[(i + 1) % boundary.length] as Vec2], Math.max(needed / 4, 0.5));
        if (edge.some(touches)) continue;
        for (const point of edge) {
          if (union.some((polygon) => pointInPolygon(point, polygon))) continue;
          const available = Math.min(...union.map((polygon) => boundaryDistance(point, polygon)));
          if (available < needed - 1e-9 && (worst === null || available < worst.available))
            worst = { zoneIds: zs.map((zone) => zone.id), needed, available, location: point };
        }
      }
    if (worst !== null) conflicts.push(worst);
  }
  return { ok: true, master, plies, conflicts };
}
