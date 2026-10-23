/**
 * Metal volume of a constant-thickness formed head (plant 03 EQP §5.3): the exact solid between the inside profile and its outward offset
 * by t, closed by the tangent plane. Never the thin-wall rule (area x t is 1.6 % low for a 2:1 head D 1500 / t 10).
 */

import { integrate } from './gaussLegendre';
import { headVolume, torisphericalGeometry, type HeadShape } from './heads';

/** Volume enclosed by the ellipse quadrant (semi-axes radius, depth) offset outward by t and the tangent plane: 64-point Gauss-Legendre on u. */
function ellipsoidalOffsetVolume(radius: number, depth: number, t: number): number {
  return integrate(
    (u) => {
      const sin = Math.sin(u);
      const cos = Math.cos(u);
      const n = Math.sqrt(radius * radius * sin * sin + depth * depth * cos * cos);
      const x = cos * (radius + (t * depth) / n);
      const dz = cos * (depth + (t * radius) / n) - (sin * t * radius * ((sin * cos * (radius * radius - depth * depth)) / n)) / (n * n);
      return Math.PI * x * x * dz;
    },
    0,
    Math.PI / 2,
  );
}

/**
 * Metal volume of a head of inside radius `radius` and shell-matching thickness t. Method per kind: ellipsoidal = offset quadrature;
 * spherical / torispherical = difference of the closed-form volumes of the arcs offset by t (same centres); conical = offset cone
 * (thickness normal to the surface); flat = disc of the inside radius.
 */
export function headMetalVolume(shape: HeadShape, radius: number, t: number): number {
  switch (shape.kind) {
    case 'flat':
      return Math.PI * radius * radius * t;
    case 'ellipsoidal':
      return ellipsoidalOffsetVolume(radius, shape.depth, t) - ellipsoidalOffsetVolume(radius, shape.depth, 0);
    case 'spherical':
      return sphericalOffsetVolume(radius, shape.depth, t) - sphericalOffsetVolume(radius, shape.depth, 0);
    case 'conical': {
      const cosHalfAngle = shape.depth / Math.sqrt(radius * radius + shape.depth * shape.depth);
      const outerRadius = radius + t / cosHalfAngle;
      const outerDepth = (shape.depth * outerRadius) / radius;
      return (Math.PI / 3) * (outerRadius * outerRadius * outerDepth - radius * radius * shape.depth);
    }
    case 'torispherical': {
      const outerRadius = radius + t;
      const outer = torisphericalGeometry(outerRadius, shape.crownRadius + t, shape.knuckleRadius + t);
      const outerShape: HeadShape = { kind: 'torispherical', depth: outer.crownDepth + outer.knuckleDepth, ...outer };
      return headVolume(outerShape, outerRadius) - headVolume(shape, radius);
    }
  }
}

/** Volume above the tangent plane of the sphere through the head rim and apex, its radius grown by t about the same centre (cap formula). */
function sphericalOffsetVolume(radius: number, depth: number, t: number): number {
  const sphere = (radius * radius + depth * depth) / (2 * depth);
  const capHeight = depth + t;
  const capRadiusSquared = (sphere + t) ** 2 - (sphere - depth) ** 2;
  return (Math.PI * capHeight * (3 * capRadiusSquared + capHeight * capHeight)) / 6;
}
