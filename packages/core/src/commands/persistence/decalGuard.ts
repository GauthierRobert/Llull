/**
 * Load guard of the 03 WRP fields of a decal: `mapping`, `wrap` (the developable surface) and `mask` (the packed font coverage). A hostile file must not make the viewport allocate
 * an image of an arbitrary size, so the mask dimensions are bounded by the producer's own limit and its payload length is checked against them.
 */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber, isPositiveNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';

/** Largest mask side the decal producer emits. */
const MAX_MASK_SIDE = 1024;

const nonZero = (v: unknown): boolean => isVec3(v) && Math.hypot(...(v as readonly number[])) > 1e-12;

function wrapProblem(wrap: unknown): string | null {
  if (!isRecord(wrap)) return 'wrap must be a cylinder or cone surface';
  if (!nonZero(wrap['axis']) || !nonZero(wrap['xDir'])) return 'wrap axis and xDir must be finite non-zero Vec3';
  if (wrap['type'] === 'cylinder') {
    if (!isVec3(wrap['origin'])) return 'wrap origin must be a finite Vec3';
    return isPositiveNumber(wrap['radius']) ? null : 'wrap radius must be finite and > 0';
  }
  if (wrap['type'] === 'cone') {
    if (!isVec3(wrap['apex'])) return 'wrap apex must be a finite Vec3';
    const angle = wrap['semiAngle'];
    return isFiniteNumber(angle) && angle > 0 && angle < Math.PI / 2 ? null : 'wrap semiAngle must be in (0, pi/2)';
  }
  return 'wrap type must be cylinder or cone';
}

function maskProblem(mask: unknown): string | null {
  if (!isRecord(mask)) return 'mask must be { width, height, bits }';
  const { width, height, bits } = mask;
  const side = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_MASK_SIDE;
  if (!side(width) || !side(height)) return `mask width and height must be integers in 1..${MAX_MASK_SIDE}`;
  const bytes = Math.ceil(((width as number) * (height as number)) / 8);
  if (typeof bits !== 'string' || bits.length !== 4 * Math.ceil(bytes / 3)) return `mask bits must be base64 of ${bytes} bytes`;
  return null;
}

/** First problem of the WRP fields of a decal record, or null when valid. */
export function decalWrapFieldsProblem(decal: Record<string, unknown>): string | null {
  const { mapping, wrap, mask } = decal;
  if (mapping !== undefined && mapping !== 'project' && mapping !== 'wrap') return 'mapping must be project or wrap';
  if ((mapping === 'wrap') !== (wrap !== undefined)) return 'wrap goes with mapping wrap, and only with it';
  return (wrap === undefined ? null : wrapProblem(wrap)) ?? (mask === undefined ? null : maskProblem(mask));
}
