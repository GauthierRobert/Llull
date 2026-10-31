// Colour map of the Jacobian determinant of a deformation (01 DEF M4, presentation only): the answer of `deform_jacobian_map` as buffers for a coloured mesh.
// det J = 1 keeps volume (neutral), > 1 stretches (red), < 1 compresses (blue); a vertex at or below the floor is folded (magenta).

export type Rgb = readonly [number, number, number];

export const NEUTRAL: Rgb = [0.92, 0.92, 0.92];
export const STRETCHED: Rgb = [0.95, 0.25, 0.2];
export const COMPRESSED: Rgb = [0.15, 0.35, 0.95];
export const FOLDED: Rgb = [1, 0, 1];

/** det J at which the ramp saturates: a factor of two either way (log scale, so 2 and 0.5 are equally far from neutral). */
const SATURATION = 2;

const mix = (from: Rgb, to: Rgb, t: number): Rgb =>
  t >= 1 ? to : [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];

/** The colour of a vertex whose map has determinant `det`; `floor` is the fold threshold of the query. */
export function jacobianColor(det: number, floor: number): Rgb {
  if (!(det > floor)) return FOLDED;
  const t = Math.max(-1, Math.min(1, Math.log(det) / Math.log(SATURATION)));
  return t < 0 ? mix(NEUTRAL, COMPRESSED, -t) : mix(NEUTRAL, STRETCHED, t);
}

export interface JacobianView {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly colors: Float32Array;
  readonly min: number | null;
  readonly max: number | null;
  readonly folded: number;
}

const isNumbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((item) => typeof item === 'number');

/** The map of a `deform_jacobian_map` answer; null when the data is not that shape (arrays of different length, a triangle past the vertices). */
export function parseJacobianMap(data: unknown): JacobianView | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const { positions, indices, determinant, floor, min, max, folded } = d;
  if (!isNumbers(positions) || !isNumbers(indices) || !isNumbers(determinant) || typeof floor !== 'number') return null;
  const count = determinant.length;
  if (
    positions.length !== 3 * count ||
    indices.length % 3 !== 0 ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index >= count)
  )
    return null;
  const colors = new Float32Array(3 * count);
  determinant.forEach((det, v) => colors.set(jacobianColor(det, floor), 3 * v));
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    colors,
    min: typeof min === 'number' ? min : null,
    max: typeof max === 'number' ? max : null,
    folded: typeof folded === 'number' ? folded : 0,
  };
}
