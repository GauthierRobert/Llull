/**
 * Centroids of a formed head (plant 03 EQP-FU, centre of gravity): the distance from the tangent plane, along the axis toward the apex, of the metal
 * solid (inside profile offset outward by t, closed by the tangent plane, as in `headMetalVolume`) and of the inside cavity. The first moment about
 * the tangent plane of a solid of revolution is the integral over the filled height of its cumulative volume: M = integral of V(x) dx, x from the apex.
 */

import { headFilledVolume, headVolume, torisphericalGeometry, type HeadShape } from './heads';
import { headMetalVolume } from './headOffset';
import { integrate } from './gaussLegendre';

/** First moment about the tangent plane of the solid enclosed by `shape` (rim radius `radius`) and the tangent plane. */
const momentOf = (shape: HeadShape, radius: number): number => integrate((x) => headFilledVolume(shape, radius, x), 0, shape.depth);

/** Moment about the tangent plane of the volume under the ellipse quadrant (semi-axes radius, depth) offset outward by t (the parametrisation of `headOffset`). */
function ellipsoidalOffsetMoment(radius: number, depth: number, t: number): number {
  return integrate(
    (u) => {
      const sin = Math.sin(u);
      const cos = Math.cos(u);
      const n = Math.sqrt(radius * radius * sin * sin + depth * depth * cos * cos);
      const x = cos * (radius + (t * depth) / n);
      const z = sin * (depth + (t * radius) / n);
      const dz = cos * (depth + (t * radius) / n) - (sin * t * radius * ((sin * cos * (radius * radius - depth * depth)) / n)) / (n * n);
      return Math.PI * x * x * z * dz;
    },
    0,
    Math.PI / 2,
  );
}

/** Moment about the tangent plane of the solid under the inside profile offset outward by t. */
function offsetMoment(shape: HeadShape, radius: number, t: number): number {
  switch (shape.kind) {
    case 'flat':
      return 0;
    case 'ellipsoidal':
      return ellipsoidalOffsetMoment(radius, shape.depth, t);
    case 'spherical': {
      const sphere = (radius * radius + shape.depth * shape.depth) / (2 * shape.depth);
      const capRadius = Math.sqrt((sphere + t) ** 2 - (sphere - shape.depth) ** 2);
      return momentOf({ kind: 'spherical', depth: shape.depth + t }, capRadius);
    }
    case 'conical': {
      const cosHalfAngle = shape.depth / Math.sqrt(radius * radius + shape.depth * shape.depth);
      const outerRadius = radius + t / cosHalfAngle;
      return momentOf({ kind: 'conical', depth: (shape.depth * outerRadius) / radius }, outerRadius);
    }
    case 'torispherical': {
      const outer = torisphericalGeometry(radius + t, shape.crownRadius + t, shape.knuckleRadius + t);
      return momentOf({ kind: 'torispherical', depth: outer.crownDepth + outer.knuckleDepth, ...outer }, radius + t);
    }
  }
}

/**
 * Distance of the centroid of the head metal from the tangent plane toward the apex (0 for a head without metal).
 * @invariant same solid as `headMetalVolume`; a flat head is a disc of thickness t beyond the tangent plane (t / 2)
 */
export function headMetalCentroid(shape: HeadShape, radius: number, t: number): number {
  if (shape.kind === 'flat') return t / 2;
  const volume = headMetalVolume(shape, radius, t);
  return volume > 0 ? (offsetMoment(shape, radius, t) - offsetMoment(shape, radius, 0)) / volume : 0;
}

/**
 * Liquid in the inside cavity of the head between its tangent plane and `height` above it (the lower part of a hanging head is full when height =
 * depth): its volume and the distance of its centroid from the tangent plane toward the apex. M = height x V(height) - integral of V, by parts.
 */
export function headFillCentroid(shape: HeadShape, radius: number, height: number): { volume: number; centroid: number } {
  const total = headVolume(shape, radius);
  const filledTo = (z: number): number => total - headFilledVolume(shape, radius, shape.depth - z);
  const level = Math.min(Math.max(height, 0), shape.depth);
  const volume = filledTo(level);
  if (!(volume > 0)) return { volume: 0, centroid: 0 };
  return { volume, centroid: (level * volume - integrate(filledTo, 0, level)) / volume };
}
