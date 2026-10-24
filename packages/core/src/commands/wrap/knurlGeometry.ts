/**
 * Modeled straight knurl (03 WRP M5): N V-grooves cut along the axis of a cylindrical face. Each groove is a triangular prism whose apex lies `depth` below the surface and whose
 * flanks make half the tooth angle with the radial direction; adjacent grooves leave a flat land of `landRatio` x pitch, so no two tool edges coincide with the surface
 * (a sharp crest would leave the exact kernel a tangent edge). The grooves are united and subtracted in one boolean.
 * @invariant volume removed = teeth x length x A, A = integral over |x| <= x_m of (sqrt(r^2 - x^2) - (r - depth) - |x| / tan(half angle)) dx (closed form below)
 */

import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { FaceGraph } from '../../geometry/kernelPorts';
import { dot3 } from '../../lib/vec3';
import { newEntity } from '../entity/newEntity';
import { axisFrame } from '../solids/shared';

/** Fraction of the pitch left as a flat land between grooves when `depth` is not given (a named default, not a standard). */
export const DEFAULT_LAND_RATIO = 0.1;
/** Included angle of the V, degrees, when none is given (90 is the usual knurl form; a named default, not a standard). */
export const DEFAULT_TOOTH_ANGLE_DEG = 90;
/** The groove tool rises this fraction of its depth above the surface and runs past an END CAP of the face by it (a shoulder or chamfer end is cut flush). */
const OVERSHOOT = 0.5;

export interface KnurlShape {
  readonly teeth: number;
  readonly radius: number;
  readonly depth: number;
  readonly toothAngleDeg: number;
}

/** Area of one groove inside the cylinder, closed form (see the module comment). */
export function grooveArea({ radius: r, depth, toothAngleDeg }: KnurlShape): number {
  const c = 1 / Math.tan((toothAngleDeg * Math.PI) / 360);
  const base = r - depth;
  const m = (-base * c + Math.sqrt(base * base * c * c - (1 + c * c) * (base * base - r * r))) / (1 + c * c);
  const circle = (x: number): number => (x * Math.sqrt(Math.max(0, r * r - x * x)) + r * r * Math.asin(Math.min(1, x / r))) / 2;
  return 2 * (circle(m) - base * m - (c * m * m) / 2);
}

/** Depth that leaves a land of `landRatio` x pitch between grooves. */
export function depthForLand(pitch: number, toothAngleDeg: number, landRatio: number): number {
  return (pitch * (1 - landRatio)) / (2 * Math.tan((toothAngleDeg * Math.PI) / 360));
}

/** Land width left between adjacent grooves for a depth, document units (negative: the grooves would overlap). */
export const landFor = (pitch: number, toothAngleDeg: number, depth: number): number =>
  pitch - 2 * depth * Math.tan((toothAngleDeg * Math.PI) / 360);

/** Balanced union of `parts`. */
function unionOf(parts: readonly ShapeRecipe[]): ShapeRecipe {
  if (parts.length === 1) return parts[0] as ShapeRecipe;
  const half = Math.ceil(parts.length / 2);
  return { op: 'boolean', boolean: 'union', a: unionOf(parts.slice(0, half)), b: unionOf(parts.slice(half)) };
}

export interface KnurlCut {
  readonly origin: Vec3;
  readonly axis: Vec3;
  /** Axial extent of the face from `origin` along the axis. */
  readonly from: number;
  readonly to: number;
  /** Run the tool past the end of the face (true: the end is a free end cap, so the overshoot cuts air; false: a shoulder or other face stands there). */
  readonly pastFrom: boolean;
  readonly pastTo: boolean;
}

/**
 * Which axial ends of cylinder face `face` (axial coordinates `from`, `to` from the axis origin) are free end caps: the neighbouring plane there bounded by that one circle.
 * @invariant no face graph -> both true (nothing is known to stand beyond the ends); an end without a plane neighbour, or with a ring-shaped one (a shoulder, a bore end), is not a cap
 */
export function freeEnds(
  graph: FaceGraph | null,
  face: number,
  axis: { readonly origin: Vec3; readonly dir: Vec3 },
  ends: readonly [number, number],
  tolerance: number,
): readonly [boolean, boolean] {
  if (graph === null) return [true, true];
  const own = graph.faces.find((candidate) => candidate.index === face);
  if (own === undefined) return [false, false];
  const neighbours = new Set(own.loops.flat().flatMap((edge) => graph.edgeFaces[edge] ?? []));
  const capAt = (end: number): boolean =>
    graph.faces.some(
      (other) =>
        other.index !== face &&
        neighbours.has(other.index) &&
        other.surface.type === 'plane' &&
        other.loops.length === 1 &&
        Math.abs(dot3(other.surface.normal, axis.dir)) > 1 - 1e-6 &&
        Math.abs(dot3(other.surface.origin, axis.dir) - dot3(axis.origin, axis.dir) - end) <= tolerance,
    );
  return [capAt(ends[0]), capAt(ends[1])];
}

/** The recipe of `source` with the grooves cut. @failure a zero-length axis -> null */
export function knurlRecipe(source: ShapeRecipe, shape: KnurlShape, cut: KnurlCut, idPrefix: string, color: string): ShapeRecipe | null {
  const frame = axisFrame(cut.axis, cut.origin);
  if (typeof frame === 'string') return null;
  const { radius, depth, teeth } = shape;
  const half = Math.tan((shape.toothAngleDeg * Math.PI) / 360);
  const over = OVERSHOOT * depth;
  const wide = (depth + over) * half;
  const [before, after] = [cut.pastFrom ? over : 0, cut.pastTo ? over : 0];
  const grooves = Array.from({ length: teeth }, (_, i): ShapeRecipe => {
    const angle = (2 * Math.PI * i) / teeth;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const at = (radial: number, across: number): Vec2 => [radial * c - across * s, radial * s + across * c];
    const profile: Vec2[] = [at(radius - depth, 0), at(radius + over, -wide), at(radius + over, wide)];
    return {
      op: 'solid',
      entity: newEntity('extrusion', `${idPrefix}.g${i}`, { profile, depth: cut.to - cut.from + before + after }, [0, 0, 0], color),
    };
  });
  const tool: ShapeRecipe = {
    op: 'place',
    source: unionOf(grooves),
    position: frame.worldAt([0, 0, cut.from - before]),
    rotation: frame.rotation,
  };
  return { op: 'boolean', boolean: 'subtract', a: source, b: tool };
}
