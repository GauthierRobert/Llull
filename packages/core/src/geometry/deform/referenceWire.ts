/** Wire drawing of the analytic reference surfaces of `analyze_deformation` compareTo (01 DEF M4 overlays): polylines in world coordinates, document units. */

import type { Vec3 } from '../../model/vectors';
import { add3, cross3, len3, normalize3, scale3 } from '../../lib/vec3';
import type { ReferenceShape } from './referenceShape';

/** Where the wire is drawn: the body the shape is compared with (unbounded shapes, planes and axes, are cut to its size). */
export interface WireExtent {
  readonly centre: Vec3;
  /** Half the diagonal of the body bounds, document units, > 0. */
  readonly radius: number;
}

const STEPS = 48;
const RINGS = 5;
const RULINGS = 8;

/** Two unit vectors perpendicular to the unit `axis` and to each other (a deterministic pair). */
function basisAround(axis: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize3(cross3(axis, helper));
  return [u, cross3(axis, u)];
}

const at = (origin: Vec3, a: Vec3, x: number, b: Vec3, y: number, c: Vec3 = [0, 0, 0], z = 0): Vec3 =>
  add3(origin, add3(add3(scale3(a, x), scale3(b, y)), scale3(c, z)));

/** A closed ellipse `centre + a cos t + b sin t`. */
function ring(centre: Vec3, a: Vec3, b: Vec3, offset: Vec3 = [0, 0, 0]): Vec3[] {
  return Array.from({ length: STEPS + 1 }, (_, i) => {
    const t = (2 * Math.PI * i) / STEPS;
    return add3(add3(centre, offset), add3(scale3(a, Math.cos(t)), scale3(b, Math.sin(t))));
  });
}

const unit = (v: Vec3 | undefined, fallback: Vec3): Vec3 => (v !== undefined && len3(v) > 0 ? normalize3(v) : fallback);

/**
 * Polylines of `shape` (world), or null when a number it needs is missing. The surfaces that are infinite are drawn over the body: rings and rulings of a cylinder, a
 * cone, an elliptic cylinder or a helicoid span the body's size around the point of the axis nearest the body centre; a plane is a grid of that size.
 */
export function referenceWire(shape: ReferenceShape, extent: WireExtent): Vec3[][] | null {
  const R = extent.radius;
  const spread = (count: number): number[] => Array.from({ length: count }, (_, i) => (count === 1 ? 0 : -1 + (2 * i) / (count - 1)));
  switch (shape.kind) {
    case 'sphere': {
      const { center, radius } = shape;
      if (center === undefined || radius === undefined) return null;
      return [
        ring(center, [radius, 0, 0], [0, radius, 0]),
        ring(center, [radius, 0, 0], [0, 0, radius]),
        ring(center, [0, radius, 0], [0, 0, radius]),
      ];
    }
    case 'spheroid': {
      const { center, semiAxes } = shape;
      if (center === undefined || semiAxes === undefined) return null;
      const [a, b, c] = semiAxes;
      return [ring(center, [a, 0, 0], [0, b, 0]), ring(center, [a, 0, 0], [0, 0, c]), ring(center, [0, b, 0], [0, 0, c])];
    }
    case 'torus': {
      const { center, axis, majorRadius, minorRadius } = shape;
      if (center === undefined || axis === undefined || majorRadius === undefined || minorRadius === undefined) return null;
      const w = unit(axis, [0, 0, 1]);
      const [u, v] = basisAround(w);
      const wires = [
        ring(center, scale3(u, majorRadius + minorRadius), scale3(v, majorRadius + minorRadius)),
        ring(center, scale3(u, majorRadius - minorRadius), scale3(v, majorRadius - minorRadius)),
      ];
      for (let k = 0; k < 12; k++) {
        const angle = (2 * Math.PI * k) / 12;
        const radial = add3(scale3(u, Math.cos(angle)), scale3(v, Math.sin(angle)));
        wires.push(ring(add3(center, scale3(radial, majorRadius)), scale3(radial, minorRadius), scale3(w, minorRadius)));
      }
      return wires;
    }
    case 'cylinder':
    case 'ellipticCylinder': {
      const { point, axis } = shape;
      if (point === undefined || axis === undefined) return null;
      const w = unit(axis, [0, 0, 1]);
      let a: Vec3;
      let b: Vec3;
      if (shape.kind === 'cylinder') {
        if (shape.radius === undefined) return null;
        const [u, v] = basisAround(w);
        [a, b] = [scale3(u, shape.radius), scale3(v, shape.radius)];
      } else {
        if (shape.reference === undefined || shape.radii === undefined || shape.radii.length !== 2) return null;
        const across = add3(
          shape.reference,
          scale3(w, -(shape.reference[0] * w[0] + shape.reference[1] * w[1] + shape.reference[2] * w[2])),
        );
        const u = len3(across) > 0 ? normalize3(across) : basisAround(w)[0];
        [a, b] = [scale3(u, shape.radii[0] as number), scale3(cross3(w, u), shape.radii[1] as number)];
      }
      // the point of the axis nearest the body centre is the middle of the drawing
      const t0 = (extent.centre[0] - point[0]) * w[0] + (extent.centre[1] - point[1]) * w[1] + (extent.centre[2] - point[2]) * w[2];
      const middle = add3(point, scale3(w, t0));
      const wires = spread(RINGS).map((s) => ring(add3(middle, scale3(w, s * R)), a, b));
      for (let k = 0; k < RULINGS; k++) {
        const angle = (2 * Math.PI * k) / RULINGS;
        const rim = add3(scale3(a, Math.cos(angle)), scale3(b, Math.sin(angle)));
        wires.push([add3(add3(middle, scale3(w, -R)), rim), add3(add3(middle, scale3(w, R)), rim)]);
      }
      return wires;
    }
    case 'cone': {
      const { apex, axis, halfAngleDeg } = shape;
      if (apex === undefined || axis === undefined || halfAngleDeg === undefined) return null;
      const w = unit(axis, [0, 0, 1]);
      const [u, v] = basisAround(w);
      const slope = Math.tan((halfAngleDeg * Math.PI) / 180);
      const wires: Vec3[][] = [];
      for (let i = 1; i <= RINGS; i++) {
        const d = (i / RINGS) * 2 * R;
        wires.push(ring(add3(apex, scale3(w, d)), scale3(u, d * slope), scale3(v, d * slope)));
      }
      for (let k = 0; k < RULINGS; k++) {
        const angle = (2 * Math.PI * k) / RULINGS;
        const rim = add3(scale3(u, Math.cos(angle) * 2 * R * slope), scale3(v, Math.sin(angle) * 2 * R * slope));
        wires.push([apex, add3(add3(apex, scale3(w, 2 * R)), rim)]);
      }
      return wires;
    }
    case 'plane': {
      const { point, normal } = shape;
      if (point === undefined || normal === undefined) return null;
      const w = unit(normal, [0, 0, 1]);
      const [u, v] = basisAround(w);
      const offset = (extent.centre[0] - point[0]) * w[0] + (extent.centre[1] - point[1]) * w[1] + (extent.centre[2] - point[2]) * w[2];
      // the plane itself, centred on the foot of the body centre
      const origin = add3(extent.centre, scale3(w, -offset));
      const wires: Vec3[][] = [];
      for (const s of spread(RINGS)) {
        wires.push([at(origin, u, s * R, v, -R), at(origin, u, s * R, v, R)]);
        wires.push([at(origin, u, -R, v, s * R), at(origin, u, R, v, s * R)]);
      }
      return wires;
    }
    case 'helicoid': {
      const { point, axis, reference, rate } = shape;
      if (point === undefined || axis === undefined || reference === undefined || rate === undefined) return null;
      const w = unit(axis, [0, 0, 1]);
      const across = add3(reference, scale3(w, -(reference[0] * w[0] + reference[1] * w[1] + reference[2] * w[2])));
      const x = len3(across) > 0 ? normalize3(across) : basisAround(w)[0];
      const y = cross3(w, x);
      const offset = shape.offset ?? 0;
      const t0 = (extent.centre[0] - point[0]) * w[0] + (extent.centre[1] - point[1]) * w[1] + (extent.centre[2] - point[2]) * w[2];
      const wires: Vec3[][] = [];
      // the twisted plane x cos(k z) + y sin(k z) = offset: one line per height, and rulings along z at fixed distances from the axis
      for (const s of spread(2 * RINGS + 1)) {
        const z = t0 + s * R;
        const [c, d] = [Math.cos(rate * z), Math.sin(rate * z)];
        const foot = add3(point, scale3(w, z));
        const direction = add3(scale3(x, -d), scale3(y, c));
        const start = add3(foot, add3(scale3(x, offset * c), scale3(y, offset * d)));
        wires.push([add3(start, scale3(direction, -R)), add3(start, scale3(direction, R))]);
      }
      for (const r of spread(RINGS)) {
        wires.push(
          Array.from({ length: STEPS + 1 }, (_, i) => {
            const z = t0 - R + (2 * R * i) / STEPS;
            const [c, d] = [Math.cos(rate * z), Math.sin(rate * z)];
            const along = add3(scale3(x, offset * c - r * R * d), scale3(y, offset * d + r * R * c));
            return add3(add3(point, scale3(w, z)), along);
          }),
        );
      }
      return wires;
    }
  }
}
