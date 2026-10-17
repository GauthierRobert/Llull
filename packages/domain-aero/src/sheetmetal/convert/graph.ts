/** Builds the flats-and-bends graph of a sheet-metal solid from its face graph (§5.7): constant thickness, coaxial cylinder pairs as bends. */

import type { Vec2, Vec3 } from '@core/model/types';
import type { FtrCode } from '@core/model/manufacturing';
import type { Frame3, SheetCutout, SheetNode } from '@core/model/sheetMetal';
import { orient2 } from '@lib/vec2';
import { toCounterClockwise } from '@lib/polygon';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '@lib/vec3';
import { bendGeometry, worldToFrame } from '../frames';
import { type CylinderFacts, type Loop3, type PlaneFacts, type SolidFacts, chainLoop, planeGap } from './faces';

export interface ConvertFailure {
  readonly code: FtrCode;
  readonly why: string;
  readonly remediation: string;
  readonly faces: readonly number[];
}

export interface ConvertedGraph {
  readonly nodes: readonly SheetNode[];
  readonly radii: readonly number[];
}

const NOT_SHEET = 'The part is not sheet metal; model it as a machined part.';
const failure = (code: FtrCode, why: string, faces: readonly number[] = [], remediation: string = NOT_SHEET): ConvertFailure => ({
  code,
  why,
  remediation,
  faces,
});

/** Most likely sheet thickness: the area-weighted mode of the gaps between parallel planes and of the radius steps between coaxial cylinders. */
export function estimateThickness(facts: SolidFacts): number | null {
  const gaps: Array<{ gap: number; weight: number }> = [];
  const planes = [...facts.planes.values()];
  planes.forEach((a, i) => {
    for (const b of planes.slice(i + 1)) {
      const gap = planeGap(a, b);
      if (gap !== null && gap > 1e-6) gaps.push({ gap, weight: Math.min(a.area, b.area) });
    }
  });
  const cylinders = [...facts.cylinders.values()];
  cylinders.forEach((a, i) => {
    for (const b of cylinders.slice(i + 1)) {
      const parallel = Math.abs(dot3(a.axis, b.axis)) > 1 - 1e-9;
      const offAxis = Math.hypot(...cross3(sub3(b.origin, a.origin), a.axis));
      if (parallel && offAxis < 1e-6 && Math.abs(a.radius - b.radius) > 1e-6)
        gaps.push({ gap: Math.abs(a.radius - b.radius), weight: Math.min(a.area, b.area) });
    }
  });
  const clusters: Array<{ gap: number; weight: number }> = [];
  for (const entry of [...gaps].sort((x, y) => x.gap - y.gap)) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && Math.abs(entry.gap - last.gap) <= 1e-4 * entry.gap + 1e-9) {
      last.gap = (last.gap * last.weight + entry.gap * entry.weight) / (last.weight + entry.weight || 1);
      last.weight += entry.weight;
    } else clusters.push({ ...entry });
  }
  return [...clusters].sort((x, y) => y.weight - x.weight)[0]?.gap ?? null;
}

interface Bend {
  readonly edge: number;
  readonly cylinder: CylinderFacts;
}

interface Context {
  readonly facts: SolidFacts;
  readonly thickness: number;
  readonly tolerance: number;
}

/** Cylinders touching the planar face along a straight tangent line, with their axis parallel to the plane. */
function bendsOf(ctx: Context, face: number, normal: Vec3): Bend[] {
  const outer = ctx.facts.graph.faces[face]?.loops[0] ?? [];
  return outer.flatMap((edge): Bend[] => {
    if (ctx.facts.edges[edge]?.curve !== 'line') return [];
    return (ctx.facts.graph.edgeFaces[edge] ?? []).flatMap((neighbour): Bend[] => {
      const cylinder = ctx.facts.cylinders.get(neighbour);
      return cylinder !== undefined && Math.abs(dot3(cylinder.axis, normal)) < 1e-6 ? [{ edge, cylinder }] : [];
    });
  });
}

function loopOf(ctx: Context, loopEdges: readonly number[]): Loop3 | null {
  return chainLoop(
    loopEdges.flatMap((index) => ctx.facts.edges[index] ?? []),
    ctx.tolerance,
  );
}

interface Region {
  readonly outline: Vec2[];
  readonly cutouts: SheetCutout[];
}

/** Planar face as outline and cutouts in `frame`; null when a wire does not close or the face is not on the frame plane. */
function regionOf(ctx: Context, face: number, frame: Frame3): Region | null {
  const wires = ctx.facts.graph.faces[face]?.loops ?? [];
  const flat = (point: Vec3): Vec2 | null => {
    const [x, y, z] = worldToFrame(frame, point);
    return Math.abs(z) <= 10 * ctx.tolerance ? [x, y] : null;
  };
  const projected = wires.map((wire) => {
    const loop = loopOf(ctx, wire);
    const points = loop?.points.map(flat) ?? [];
    return loop === null || points.some((p) => p === null) ? null : { loop, points: points as Vec2[] };
  });
  const [outer, ...holes] = projected;
  if (outer === null || outer === undefined || holes.some((hole) => hole === null)) return null;
  return {
    outline: toCounterClockwise(outer.points),
    cutouts: (holes as Array<NonNullable<(typeof projected)[number]>>).map(({ loop, points }): SheetCutout => {
      const center = loop.circle === undefined ? null : flat(loop.circle.center);
      return {
        points: toCounterClockwise(points),
        ...(loop.circle !== undefined && center !== null ? { circle: { center, radius: loop.circle.radius } } : {}),
      };
    }),
  };
}

const centroid2 = (points: readonly Vec2[]): Vec2 => [
  points.reduce((s, p) => s + p[0], 0) / points.length,
  points.reduce((s, p) => s + p[1], 0) / points.length,
];

/** Frame whose x axis runs across the first bend of the root face (so the developed length lies along x), else along its first edge. */
function rootFrame(ctx: Context, face: number, normal: Vec3): Frame3 | ConvertFailure {
  const wire = loopOf(ctx, ctx.facts.graph.faces[face]?.loops[0] ?? []);
  if (wire === null) return failure('FTR_NOT_SHEET_METAL', `the outer wire of face ${face} does not close`, [face]);
  const bend = bendsOf(ctx, face, normal)[0];
  const first = wire.points[0] as Vec3;
  let xDir = normalize3(sub3(wire.points[1] as Vec3, first));
  if (bend !== undefined) {
    const edge = ctx.facts.edges[bend.edge] as { start: Vec3; end: Vec3 };
    const middle = scale3(add3(edge.start, edge.end), 0.5);
    const center = scale3(
      wire.points.reduce<Vec3>((sum, p) => add3(sum, p), [0, 0, 0]),
      1 / wire.points.length,
    );
    const across = sub3(middle, center);
    xDir = normalize3(sub3(across, scale3(bend.cylinder.axis, dot3(across, bend.cylinder.axis))));
  }
  return { origin: first, xDir, normal };
}

/**
 * Flats and bends of the solid, starting from the reference face `root` (material on the side of `normal`).
 * @failure unclosed wires, faces off the bend frames, cones / tori, negative radii -> a failure with the offending face indices
 */
export function buildGraph(facts: SolidFacts, root: PlaneFacts, thickness: number): ConvertedGraph | ConvertFailure {
  const ctx: Context = { facts, thickness, tolerance: Math.max(1e-4 * thickness, 1e-9) };
  const normal = scale3(root.outward, -1);
  const rootFrameOrFailure = rootFrame(ctx, root.index, normal);
  if ('why' in rootFrameOrFailure) return rootFrameOrFailure;
  const rootRegion = regionOf(ctx, root.index, rootFrameOrFailure);
  if (rootRegion === null) return failure('FTR_NOT_SHEET_METAL', `face ${root.index} does not close or is not planar`, [root.index]);

  const nodes: SheetNode[] = [
    { id: 'f1', type: 'flat', outline: rootRegion.outline, frame: rootFrameOrFailure, cutouts: rootRegion.cutouts },
  ];
  const radii: number[] = [];
  const seen = new Set<number>([root.index]);
  const queue = [{ id: 'f1', face: root.index, frame: rootFrameOrFailure, region: rootRegion }];
  let bendCount = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor] as (typeof queue)[number];
    const plane = facts.planes.get(item.face) as PlaneFacts;
    for (const bend of bendsOf(ctx, item.face, item.frame.normal)) {
      if (seen.has(bend.cylinder.index)) continue;
      seen.add(bend.cylinder.index);
      const edges = (facts.graph.faces[bend.cylinder.index]?.loops[0] ?? []).filter(
        (e) => e !== bend.edge && facts.edges[e]?.curve === 'line',
      );
      const farEdge = edges.find(
        (e) =>
          Math.abs(
            dot3(normalize3(sub3((facts.edges[e] as { end: Vec3 }).end, (facts.edges[e] as { start: Vec3 }).start)), bend.cylinder.axis),
          ) >
          1 - 1e-6,
      );
      const childFace = (facts.graph.edgeFaces[farEdge ?? -1] ?? []).find((f) => f !== bend.cylinder.index);
      if (farEdge === undefined || childFace === undefined || !facts.planes.has(childFace) || seen.has(childFace))
        return failure('FTR_NOT_SHEET_METAL', `bend face ${bend.cylinder.index} does not join two flats`, [bend.cylinder.index]);
      seen.add(childFace);
      const up = dot3(sub3(bend.cylinder.origin, plane.origin), item.frame.normal) > 0;
      const radius = up ? bend.cylinder.radius - thickness : bend.cylinder.radius;
      if (radius < -ctx.tolerance)
        return failure(
          'FTR_NOT_SHEET_METAL',
          `bend face ${bend.cylinder.index} radius ${bend.cylinder.radius} is smaller than the thickness`,
          [bend.cylinder.index],
        );
      const insideRadius = Math.max(0, radius);
      const edge = facts.edges[bend.edge] as { start: Vec3; end: Vec3 };
      const [a, b] = [worldToFrame(item.frame, edge.start), worldToFrame(item.frame, edge.end)];
      const pair: [Vec2, Vec2] = [
        [a[0], a[1]],
        [b[0], b[1]],
      ];
      const line: [Vec2, Vec2] = orient2(pair[0], pair[1], centroid2(item.region.outline)) > 0 ? [pair[1], pair[0]] : pair;
      const angle = up ? bend.cylinder.sweep : -bend.cylinder.sweep;
      const child = bendGeometry(item.frame, line, angle, insideRadius, thickness, 0).child;
      const region = regionOf(ctx, childFace, child);
      if (region === null)
        return failure(
          'FTR_NOT_SHEET_METAL',
          `flat face ${childFace} does not continue bend face ${bend.cylinder.index} (non-constant thickness?)`,
          [childFace, bend.cylinder.index],
        );
      bendCount += 1;
      const flatId = `f${queue.length + 1}`;
      nodes.push(
        { id: flatId, type: 'flat', outline: region.outline, frame: child, cutouts: region.cutouts },
        { id: `b${bendCount}`, type: 'bend', from: item.id, to: flatId, lineInFrom: line, angle, insideRadius },
      );
      radii.push(insideRadius);
      queue.push({ id: flatId, face: childFace, frame: child, region });
      if (queue.length > 500) return failure('FTR_NOT_SHEET_METAL', 'more than 500 flats', []);
    }
  }
  return { nodes, radii };
}

export const isFailure = (value: ConvertedGraph | ConvertFailure): value is ConvertFailure => 'why' in value;

/** True when `plane` has a parallel partner plane one thickness behind it (into the material). */
export function hasPartner(facts: SolidFacts, plane: PlaneFacts, thickness: number, tolerance: number): boolean {
  const inward = scale3(plane.outward, -1);
  return [...facts.planes.values()].some(
    (other) =>
      dot3(other.outward, plane.outward) < -1 + 1e-9 && Math.abs(dot3(sub3(other.origin, plane.origin), inward) - thickness) <= tolerance,
  );
}
