/**
 * Hole chains (07 FTR §5.6 step 2): coaxial concave revolution faces joined through annular steps, classified as simple / counterbore /
 * countersink holes, through or blind (flat bottom or drill point).
 * @invariant the entrance is the open end with the larger radius (ties: the end whose host plane faces the greater z, y, x), the axis points INTO the material
 * @failure a chain no hole kind explains (undercut, two counterbores, an opening onto a curved face) -> not reported, its faces stay unclassified
 */

import type { Vec3 } from '../../model/types';
import { roundTo } from '../../lib/compactNumber';
import { add3, distance3, dot3, scale3, sub3 } from '../../lib/vec3';
import { type Group, type Model, distanceToAxis, edgesOf, outwardNormal } from './model';
import type { RecognizedHole } from './types';

/** A countersink shallower than this fraction of the bore diameter could be a chamfer: reported as ambiguous. */
const CHAMFER_MAX_RATIO = 0.1;
const FULL_TURN = 2 * Math.PI - 1e-3;

interface Axis {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

function axisOf(group: Group): Axis | null {
  const surface = group.surface;
  if (surface.type === 'cylinder') return { origin: surface.origin, direction: surface.axis };
  if (surface.type === 'cone') return { origin: surface.apex, direction: surface.axis };
  return null;
}

const isRevolvedCavity = (group: Group): boolean =>
  group.reversed && group.span >= FULL_TURN && (group.surface.type === 'cylinder' || group.surface.type === 'cone');

function coaxial(model: Model, a: Axis, b: Axis): boolean {
  const { length, angle } = model.tolerance;
  return 1 - Math.abs(dot3(a.direction, b.direction)) < angle * angle && distanceToAxis(b.origin, a.origin, a.direction) < length;
}

/** Plane groups that only touch revolved cavities of one axis (annular steps, flat bottoms), perpendicular to that axis. */
function stepPlane(model: Model, plane: Group, cavities: ReadonlySet<Group>): boolean {
  const normal = outwardNormal(plane);
  const neighbours = model.boundary(plane).map((entry) => entry.other);
  const [first] = neighbours;
  const axis = first === undefined ? null : axisOf(first);
  if (normal === null || axis === null || neighbours.length === 0) return false;
  const { angle } = model.tolerance;
  return (
    1 - Math.abs(dot3(normal, axis.direction)) < angle * angle &&
    neighbours.every((other) => {
      const otherAxis = axisOf(other);
      return cavities.has(other) && otherAxis !== null && coaxial(model, axis, otherAxis);
    })
  );
}

/** Connected sets of candidate groups (cavities + step planes) linked through shared edges. */
function components(model: Model, candidates: ReadonlySet<Group>): Group[][] {
  const seen = new Set<Group>();
  const result: Group[][] = [];
  for (const start of candidates) {
    if (seen.has(start)) continue;
    const part: Group[] = [];
    const stack = [start];
    seen.add(start);
    for (let group = stack.pop(); group !== undefined; group = stack.pop()) {
      part.push(group);
      for (const { other } of model.boundary(group)) {
        if (!candidates.has(other) || seen.has(other)) continue;
        const [a, b] = [axisOf(group), axisOf(other)];
        if (a !== null && b !== null && !coaxial(model, a, b)) continue;
        seen.add(other);
        stack.push(other);
      }
    }
    result.push(part);
  }
  return result;
}

interface Segment {
  readonly group: Group;
  readonly from: number;
  readonly to: number;
}

const greaterNormal = (a: Vec3, b: Vec3): boolean => {
  for (const k of [2, 1, 0] as const) if (Math.abs(a[k] - b[k]) > 1e-9) return a[k] > b[k];
  return false;
};

interface OpenEnd {
  readonly point: Vec3;
  readonly radius: number;
  readonly hostNormal: Vec3;
}

/** The open ends of a component: its boundary circles onto planes perpendicular to the axis; null when one opens onto anything else. */
function openEnds(model: Model, part: readonly Group[], axis: Axis): OpenEnd[] | null {
  const members = new Set(part);
  const ends: OpenEnd[] = [];
  for (const group of part)
    for (const { edge, other } of model.boundary(group)) {
      if (members.has(other)) continue;
      const normal = outwardNormal(other);
      const point = model.edgePoints(edge)[0];
      if (normal === null || point === undefined || 1 - Math.abs(dot3(normal, axis.direction)) > model.tolerance.angle ** 2) return null;
      ends.push({ point, radius: distanceToAxis(point, axis.origin, axis.direction), hostNormal: normal });
    }
  return ends;
}

/** The entrance among the open ends (larger radius; ties by the greater host normal) and whether another end exists. */
function entranceOf(ends: readonly OpenEnd[], axis: Axis, length: number): { entrance: OpenEnd; exit: boolean } | null {
  const level = (end: OpenEnd): number => dot3(sub3(end.point, axis.origin), axis.direction);
  const [first] = ends;
  if (first === undefined) return null;
  const others = ends.filter((end) => Math.abs(level(end) - level(first)) > length);
  const best = [first, ...others].reduce((chosen, end) => {
    if (Math.abs(end.radius - chosen.radius) > length) return end.radius > chosen.radius ? end : chosen;
    return greaterNormal(end.hostNormal, chosen.hostNormal) ? end : chosen;
  });
  return { entrance: best, exit: others.length > 0 };
}

function segmentsOf(model: Model, part: readonly Group[], entrance: OpenEnd, depthDirection: Vec3): Segment[] {
  return part.map((group) => {
    const depths = edgesOf(model, group)
      .flatMap((edge) => model.edgePoints(edge))
      .map((point) => dot3(sub3(point, entrance.point), depthDirection));
    return { group, from: Math.min(...depths), to: Math.max(...depths) };
  });
}

/** A cone whose tip belongs to the face: a degenerate edge, or an edge point at the apex. */
function hasApex(model: Model, group: Group): boolean {
  const surface = group.surface;
  if (surface.type !== 'cone') return false;
  return edgesOf(model, group).some(
    (edge) =>
      model.topology.edges[edge]?.degenerate === true ||
      model.edgePoints(edge).some((point) => distance3(point, surface.apex) < model.tolerance.length),
  );
}

function loopCount(model: Model, group: Group): number {
  return group.faces.reduce((sum, face) => sum + (model.graph.faces[face]?.loops.length ?? 0), 0);
}

function classify(model: Model, part: readonly Group[]): RecognizedHole | null {
  const axis = part.map(axisOf).find((candidate) => candidate !== null) ?? null;
  const ends = axis === null ? null : openEnds(model, part, axis);
  if (axis === null || ends === null || ends.length === 0) return null;
  const chosen = entranceOf(ends, axis, model.tolerance.length);
  if (chosen === null) return null;
  const { entrance, exit } = chosen;
  const depthDirection: Vec3 = [-entrance.hostNormal[0], -entrance.hostNormal[1], -entrance.hostNormal[2]];
  const segments = segmentsOf(model, part, entrance, depthDirection).sort((a, b) => a.from - b.from || a.to - b.to);
  const tol = model.tolerance.length;
  const cylinders = segments.filter((s) => s.group.surface.type === 'cylinder');
  const cones = segments.filter((s) => s.group.surface.type === 'cone');
  const planes = segments.filter((s) => s.group.surface.type === 'plane');
  const drill = cones.filter((s) => hasApex(model, s.group));
  const csk = cones.filter((s) => !hasApex(model, s.group));
  const discs = planes.filter((s) => loopCount(model, s.group) === 1);
  const steps = planes.length - discs.length;
  const bottoms = discs.length + drill.length;
  const [first, main] = [cylinders[0], cylinders[cylinders.length - 1]];
  const cone = csk[0];
  const cskOk = csk.length === 0 || (csk.length === 1 && cone !== undefined && Math.abs(cone.from) < tol);
  const valid =
    main !== undefined &&
    first !== undefined &&
    cskOk &&
    cylinders.length <= 2 &&
    drill.length <= 1 &&
    discs.length <= 1 &&
    bottoms === (exit ? 0 : 1) &&
    (cylinders.length === 2 ? steps === 1 : steps === 0);
  if (!valid) return null;
  const cboreSegment = cylinders.length === 2 ? first : undefined;
  const cskSurface = cone?.group.surface;
  const tip = drill[0]?.group.surface;
  const both = cone !== undefined && cboreSegment !== undefined;
  const subtype = cone !== undefined ? 'countersink' : cboreSegment !== undefined ? 'counterbore' : 'simple';
  const diameter = main.group.surface.type === 'cylinder' ? 2 * main.group.surface.radius : 0;
  const cskDepth = cone === undefined ? undefined : cone.to - cone.from;
  const ambiguous = both || (cskDepth !== undefined && cskDepth < CHAMFER_MAX_RATIO * diameter);
  const r = (value: number): number => roundTo(value, 9) + 0;
  const point = (value: Vec3): Vec3 => [r(value[0]), r(value[1]), r(value[2])];
  const onAxis = add3(axis.origin, scale3(axis.direction, dot3(sub3(entrance.point, axis.origin), axis.direction)));
  return {
    subtype,
    axisPoint: point(onAxis),
    axis: point(depthDirection),
    diameter: r(diameter),
    ...(cone === undefined || cskSurface?.type !== 'cone'
      ? {}
      : {
          cskDiameter: r(2 * entrance.radius),
          cskAngleDeg: r(((2 * cskSurface.semiAngle) / Math.PI) * 180),
          cskDepth: r(cone.to - cone.from),
        }),
    ...(cboreSegment === undefined || cboreSegment.group.surface.type !== 'cylinder'
      ? {}
      : { cboreDiameter: r(2 * cboreSegment.group.surface.radius), cboreDepth: r(cboreSegment.to - cboreSegment.from) }),
    ...(exit ? {} : { depth: r(main.to) }),
    through: exit,
    ...(tip?.type === 'cone' ? { drillPointAngleDeg: r(((2 * tip.semiAngle) / Math.PI) * 180) } : {}),
    faceIndices: [...new Set(part.flatMap((group) => group.faces))].sort((a, b) => a - b),
    confidence: ambiguous ? 'ambiguous' : 'exact',
  };
}

const RANK = { simple: 0, counterbore: 1, countersink: 2 } as const;

/** Holes of the model, in a deterministic order (kind, then axis point x, y, z). `taken` receives the groups they explain. */
export function recognizeHoles(model: Model, taken: Set<Group>): RecognizedHole[] {
  const cavities = new Set(model.groups.filter(isRevolvedCavity));
  const candidates = new Set<Group>(cavities);
  for (const group of model.groups) if (group.surface.type === 'plane' && stepPlane(model, group, cavities)) candidates.add(group);
  const holes: RecognizedHole[] = [];
  for (const part of components(model, candidates)) {
    const hole = part.some((group) => cavities.has(group)) ? classify(model, part) : null;
    if (hole === null) continue;
    holes.push(hole);
    part.forEach((group) => taken.add(group));
  }
  const step = Math.max(model.tolerance.length, 1e-6);
  const key = (value: number): number => Math.round(value / step);
  return holes.sort(
    (a, b) =>
      RANK[a.subtype] - RANK[b.subtype] ||
      key(a.axisPoint[0]) - key(b.axisPoint[0]) ||
      key(a.axisPoint[1]) - key(b.axisPoint[1]) ||
      key(a.axisPoint[2]) - key(b.axisPoint[2]),
  );
}
