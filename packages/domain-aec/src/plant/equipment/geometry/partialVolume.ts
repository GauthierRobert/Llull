/**
 * Liquid volume at a level in a vessel with formed heads (plant 03 EQP §5.2, Jones). Level h is measured from the lowest inside point
 * (vertical: apex of the bottom head; horizontal: bottom of the shell). Lengths in one consistent unit.
 */

import { headFilledVolume, headVolume, type HeadShape } from './heads';

/** Circular segment area of a circle of radius r filled to depth h. */
function segmentArea(radius: number, h: number): number {
  const depth = Math.min(Math.max(h, 0), 2 * radius);
  return (
    radius * radius * Math.acos((radius - depth) / radius) - (radius - depth) * Math.sqrt(Math.max(0, 2 * radius * depth - depth * depth))
  );
}

/** Total inside height of a vertical vessel (bottom depth + tangent length + top depth). */
export const verticalHeight = (bottom: HeadShape, top: HeadShape, length: number): number => bottom.depth + length + top.depth;

/** Liquid volume of a vertical vessel filled to h above the lowest inside point (the top head is the bottom formula mirrored). */
export function verticalVolume(radius: number, length: number, bottom: HeadShape, top: HeadShape, h: number): number {
  const area = Math.PI * radius * radius;
  if (h <= bottom.depth) return headFilledVolume(bottom, radius, h);
  const bottomFull = headVolume(bottom, radius);
  if (h <= bottom.depth + length) return bottomFull + area * (h - bottom.depth);
  const inTop = Math.min(h - bottom.depth - length, top.depth);
  return bottomFull + area * length + headVolume(top, radius) - headFilledVolume(top, radius, top.depth - inTop);
}

/** Closed form of one conical head of a horizontal cylinder filled to level h (Jones; integral of circular segments along the cone). */
function conicalHeadHorizontal(radius: number, depth: number, h: number): number {
  const y = h - radius;
  const q = Math.sqrt(Math.max(0, radius * radius - y * y));
  const logTerm = y === 0 || Math.abs(y) >= radius ? 0 : (y ** 3 / 3) * Math.log((radius + q) / Math.abs(y));
  const antiderivative = (radius ** 3 / 3) * Math.acos(Math.max(-1, Math.min(1, -y / radius))) + ((2 * y) / 3) * radius * q - logTerm;
  return (depth / radius) * antiderivative;
}

/** Volume of one head of a horizontal vessel at level h, or null when no closed form exists (torispherical between empty and full). */
function horizontalHead(shape: HeadShape, radius: number, h: number): number | null {
  const level = Math.min(Math.max(h, 0), 2 * radius);
  if (level === 0 || shape.kind === 'flat') return 0;
  if (level === 2 * radius) return headVolume(shape, radius);
  switch (shape.kind) {
    case 'ellipsoidal':
      return (Math.PI * shape.depth * level * level * (1 - level / (3 * radius))) / 2;
    case 'spherical':
      return Math.abs(shape.depth - radius) <= 1e-12 * radius
        ? (Math.PI * shape.depth * level * level * (1 - level / (3 * radius))) / 2
        : null;
    case 'conical':
      return conicalHeadHorizontal(radius, shape.depth, level);
    case 'torispherical':
      return null;
  }
}

/** Liquid volume of a horizontal vessel at level h, or null when a head has no closed form at that level. */
export function horizontalVolume(radius: number, length: number, first: HeadShape, second: HeadShape, h: number): number | null {
  const one = horizontalHead(first, radius, h);
  const two = horizontalHead(second, radius, h);
  if (one === null || two === null) return null;
  return segmentArea(radius, h) * length + one + two;
}
