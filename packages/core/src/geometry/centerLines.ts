/**
 * Centre lines of round features (ISO 128 chain lines): an axis seen end-on gets a centre mark (cross), an axis seen side-on gets a centre
 * line along it, and three or more equal end-on marks spaced evenly about a common centre get their pitch circle (PCD). Round features are
 * found in the entity itself, in the leaves of its B-rep recipe (holes cut by a boolean included) and in the children of an instance.
 */

import type { CadDocument, Entity, ShapeRecipe, Vec2, Vec3 } from '../model/types';
import type { DrawingPrimitive } from '../model/drawing';
import { add3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';
import { entityLocalToWorld } from './entityFrame';
import { expandInstance } from './instanceExpansion';
import { quantizedKey } from '../lib/quantize';
import type { Bounds } from './bounds';
import { rotatedEntityBounds } from './rotatedBounds';
import { revolutionAxisIndex } from './revolution';
import { MAX_RECIPE_DEPTH, recipeOf } from './shapeRecipe';
import { type ViewFrame } from './viewProjection';

/** A round feature: `radius` about the line origin + t·direction, t in [from, to]. */
interface RoundAxis {
  readonly origin: Vec3;
  /** Unit axis; null for a sphere (a centre mark in every view). */
  readonly direction: Vec3 | null;
  readonly from: number;
  readonly to: number;
  readonly radius: number;
}

type Placement = (point: Vec3) => Vec3;

const IDENTITY: Placement = (point) => point;
const MAX_DEPTH = 8;
/** Centre lines overshoot the outline by this fraction of the radius. */
const OVERSHOOT = 0.25;
const END_ON = 0.999;
const SIDE_ON = 0.02;

function axisOf(entity: Entity, place: Placement, scale: number): RoundAxis | null {
  const world = (local: Vec3): Vec3 => place(entityLocalToWorld(entity, local));
  const line = (localDirection: Vec3, from: number, to: number, radius: number): RoundAxis | null => {
    const origin = world([0, 0, 0]);
    const direction = sub3(world(localDirection), origin);
    if (Math.hypot(...direction) < 1e-12 || !(radius > 0)) return null;
    return { origin, direction: normalize3(direction), from: from * scale, to: to * scale, radius };
  };
  switch (entity.kind) {
    case 'cylinder':
      return line([0, 0, 1], -entity.height / 2, entity.height / 2, entity.radius * scale);
    case 'cone':
      return line([0, 0, 1], 0, entity.height, entity.radius * scale);
    case 'torus':
      return line([0, 0, 1], -entity.tubeRadius, entity.tubeRadius, (entity.ringRadius + entity.tubeRadius) * scale);
    case 'revolution': {
      const axial = entity.profile.map(([, along]) => along);
      const radius = Math.max(...entity.profile.map(([radial]) => Math.abs(radial)));
      // The axis the mesh really spins about (dominant world axis, sign ignored).
      const direction: [number, number, number] = [0, 0, 0];
      direction[revolutionAxisIndex(entity.axis)] = 1;
      return line(direction, Math.min(...axial), Math.max(...axial), radius * scale);
    }
    case 'sphere':
      return entity.radius > 0 ? { origin: world([0, 0, 0]), direction: null, from: 0, to: 0, radius: entity.radius * scale } : null;
    default:
      return null;
  }
}

function recipeAxes(recipe: ShapeRecipe, place: Placement, scale: number, depth: number): RoundAxis[] {
  if (depth > MAX_RECIPE_DEPTH) return [];
  switch (recipe.op) {
    case 'solid': {
      const axis = axisOf(recipe.entity, place, scale);
      return axis ? [axis] : [];
    }
    case 'boolean':
      return [...recipeAxes(recipe.a, place, scale, depth + 1), ...recipeAxes(recipe.b, place, scale, depth + 1)];
    case 'blend':
      return recipe.sources.flatMap((source) => recipeAxes(source, place, scale, depth + 1));
    case 'fillet':
    case 'chamfer':
    case 'shell':
      return recipeAxes(recipe.source, place, scale, depth + 1);
    case 'place': {
      const frame = { position: recipe.position, rotation: recipe.rotation };
      return recipeAxes(recipe.source, (point) => place(entityLocalToWorld(frame, point)), scale, depth + 1);
    }
    case 'scale':
      return recipeAxes(recipe.source, (point) => place(scale3(point, recipe.factor)), scale * recipe.factor, depth + 1);
  }
}

/**
 * The part of `axis` inside `box` (slab test), or null when it misses: a boolean tool that only trims the part, or lies beyond it, gets no
 * centre line, and a through-hole tool longer than the part is cut to the part.
 */
function axisWithin(axis: RoundAxis, box: Bounds): RoundAxis | null {
  const margin = axis.radius * 1e-3;
  const inside = (point: Vec3): boolean =>
    point.every((v, i) => v >= (box.min[i] as number) - margin && v <= (box.max[i] as number) + margin);
  if (axis.direction === null) return inside(axis.origin) ? axis : null;
  let [from, to] = [axis.from, axis.to];
  for (let i = 0; i < 3; i++) {
    const [o, d] = [axis.origin[i] as number, axis.direction[i] as number];
    const [low, high] = [(box.min[i] as number) - margin, (box.max[i] as number) + margin];
    if (Math.abs(d) < 1e-12) {
      if (o < low || o > high) return null;
      continue;
    }
    const [t0, t1] = [(low - o) / d, (high - o) / d];
    from = Math.max(from, Math.min(t0, t1));
    to = Math.min(to, Math.max(t0, t1));
  }
  return from <= to ? { ...axis, from, to } : null;
}

/** The part of `axis` on the far side of the section plane (its near side is cut away), or null. */
function axisBehindCut(axis: RoundAxis, frame: ViewFrame, cutDepth: number): RoundAxis | null {
  if (!Number.isFinite(cutDepth)) return axis;
  const base = dot3(axis.origin, frame.toViewer);
  // A sphere, or an axis seen side-on, keeps its line while any of its body reaches behind the cut.
  if (axis.direction === null) return base - axis.radius <= cutDepth ? axis : null;
  const rate = dot3(axis.direction, frame.toViewer);
  if (Math.abs(rate) < 1e-12) return base - axis.radius <= cutDepth ? axis : null;
  const limit = (cutDepth - base) / rate;
  const [from, to] = rate > 0 ? [axis.from, Math.min(axis.to, limit)] : [Math.max(axis.from, limit), axis.to];
  return from <= to ? { ...axis, from, to } : null;
}

/** Round features of a 3D entity in world space (instances expanded through `doc`). */
function roundAxes(entity: Entity, doc: Pick<CadDocument, 'components'>, depth = 0): RoundAxis[] {
  if (entity.kind === 'instance') {
    const component = doc.components[entity.componentId];
    if (!component || depth >= MAX_DEPTH) return [];
    return expandInstance(entity, component).flatMap((child) => roundAxes(child, doc, depth + 1));
  }
  const box = rotatedEntityBounds(entity);
  return recipeAxes(recipeOf(entity), IDENTITY, 1, 0).flatMap((axis) => {
    const kept = axisWithin(axis, box);
    return kept ? [kept] : [];
  });
}

/** ISO centre mark of a circle: two chain lines crossing at `center`, overshooting the outline. @pure */
export function centreMarkLines(center: Vec2, radius: number, layer: string): DrawingPrimitive[] {
  const [x, y] = center;
  const reach = radius * (1 + OVERSHOOT);
  return [
    { type: 'line', layer, style: 'center', a: [x - reach, y], b: [x + reach, y] },
    { type: 'line', layer, style: 'center', a: [x, y - reach], b: [x, y + reach] },
  ];
}

interface CentreMark {
  readonly center: Vec2;
  readonly radius: number;
  /** Position along the view direction (marks on one pitch circle share it). */
  readonly depth: number;
}

/**
 * Pitch circles (PCD) of ≥ 3 equal marks at one depth, equally distant from their common centre AND evenly spaced around it (a rectangle's
 * four corners are not a bolt circle).
 */
function pitchCircles(marks: ReadonlyArray<CentreMark>, unit: number): Array<Omit<CentreMark, 'depth'>> {
  const groups = new Map<string, CentreMark[]>();
  for (const mark of marks) {
    const key = quantizedKey([mark.radius, mark.depth], unit);
    groups.set(key, [...(groups.get(key) ?? []), mark]);
  }
  const circles: Array<Omit<CentreMark, 'depth'>> = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const center: Vec2 = [
      group.reduce((sum, mark) => sum + mark.center[0], 0) / group.length,
      group.reduce((sum, mark) => sum + mark.center[1], 0) / group.length,
    ];
    const offsets = group.map(({ center: [x, y] }) => [x - center[0], y - center[1]] as const);
    const pitch = Math.hypot(...(offsets[0] ?? [0, 0]));
    const radius = group[0]?.radius ?? 0;
    if (!(pitch > radius) || offsets.some((o) => Math.abs(Math.hypot(...o) - pitch) > unit * 10)) continue;
    const angles = offsets.map(([x, y]) => Math.atan2(y, x)).sort((a, b) => a - b);
    const step = (2 * Math.PI) / angles.length;
    const even = angles.every((angle, i) => {
      const next = i + 1 < angles.length ? (angles[i + 1] as number) : (angles[0] as number) + 2 * Math.PI;
      return Math.abs(next - angle - step) < 1e-3;
    });
    if (even) circles.push({ center, radius: pitch });
  }
  return circles;
}

/**
 * Centre-line primitives (style `center`, on `layer`) of the round features of `entity` in `frame`; features in front of the section plane
 * at `cutDepth` are cut away with the material.
 * @returns [] for an entity without round features or with axes oblique to the view
 */
export function centerLinePrimitives(
  entity: Entity,
  doc: Pick<CadDocument, 'components'>,
  frame: ViewFrame,
  layer: string,
  cutDepth = Infinity,
): DrawingPrimitive[] {
  const axes = roundAxes(entity, doc).flatMap((axis) => {
    const kept = axisBehindCut(axis, frame, cutDepth);
    return kept ? [kept] : [];
  });
  if (axes.length === 0) return [];
  const unit = Math.max(...axes.map((axis) => axis.radius)) * 1e-4;
  const seen = new Set<string>();
  const primitives: DrawingPrimitive[] = [];
  const marks = new Map<string, CentreMark>();
  const line = (a: Vec2, b: Vec2): void => {
    const key = quantizedKey([...a, ...b], unit);
    if (seen.has(key)) return;
    seen.add(key);
    primitives.push({ type: 'line', layer, style: 'center', a, b });
  };
  // Concentric end-on features share one cross, sized by the largest.
  const crosses = new Map<string, CentreMark>();
  for (const axis of axes) {
    const along = axis.direction === null ? 1 : Math.abs(dot3(axis.direction, frame.toViewer));
    if (along > END_ON) {
      const middle = axis.direction === null ? axis.origin : add3(axis.origin, scale3(axis.direction, (axis.from + axis.to) / 2));
      const center = frame.project(middle);
      const mark = { center, radius: axis.radius, depth: dot3(middle, frame.toViewer) };
      marks.set(quantizedKey([...center, axis.radius, mark.depth], unit), mark);
      const key = quantizedKey(center, unit);
      if ((crosses.get(key)?.radius ?? 0) < axis.radius) crosses.set(key, mark);
    } else if (along < SIDE_ON && axis.direction !== null) {
      const overshoot = axis.radius * OVERSHOOT;
      const point = (t: number): Vec2 => frame.project(add3(axis.origin, scale3(axis.direction as Vec3, t)));
      line(point(axis.from - overshoot), point(axis.to + overshoot));
    }
  }
  for (const { center, radius } of crosses.values()) {
    for (const mark of centreMarkLines(center, radius, layer)) {
      if (mark.type === 'line') line(mark.a, mark.b);
    }
  }
  for (const circle of pitchCircles([...marks.values()], unit)) primitives.push({ type: 'circle', layer, style: 'center', ...circle });
  return primitives;
}
