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
  /** Non-indexed triangles (3 vertices x 3 coordinates each): every triangle carries one flat colour. */
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly min: number | null;
  readonly max: number | null;
  readonly folded: number;
  readonly floor: number;
  readonly law: string;
  /** Deform nodes whose determinants the map multiplies (1: a single deformation, or the outermost scope). */
  readonly deforms: number;
}

const isNumbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((item) => typeof item === 'number');

/** The map of a `deform_jacobian_map` answer (one determinant per triangle); null when the data is not that shape (lengths that disagree, a triangle past the vertices). */
export function parseJacobianMap(data: unknown): JacobianView | null {
  if (typeof data !== 'object' || data === null) return null;
  const { positions, indices, determinant, floor, min, max, folded, law, deforms } = data as Record<string, unknown>;
  if (!isNumbers(positions) || !isNumbers(indices) || !isNumbers(determinant) || typeof floor !== 'number') return null;
  const vertices = positions.length / 3;
  if (!Number.isInteger(vertices) || indices.length !== 3 * determinant.length) return null;
  if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices)) return null;
  const flat = new Float32Array(9 * determinant.length);
  const colors = new Float32Array(9 * determinant.length);
  determinant.forEach((det, t) => {
    const rgb = jacobianColor(det, floor);
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[3 * t + corner] as number;
      for (let k = 0; k < 3; k++) {
        flat[9 * t + 3 * corner + k] = positions[3 * vertex + k] as number;
        colors[9 * t + 3 * corner + k] = rgb[k] as number;
      }
    }
  });
  return {
    positions: flat,
    colors,
    min: typeof min === 'number' ? min : null,
    max: typeof max === 'number' ? max : null,
    folded: typeof folded === 'number' ? folded : 0,
    floor,
    law: typeof law === 'string' ? law : '',
    deforms: typeof deforms === 'number' && deforms >= 1 ? deforms : 1,
  };
}
