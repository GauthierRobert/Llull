/** Mesh volume and winding helpers over flat xyz position arrays. */

import type { Vec3 } from '../model/vectors';
import { cross3, dot3, vec3At } from '../lib/vec3';

/** Corner indices `0..n-1` of a triangle soup (9 numbers per triangle). */
export function soupIndices(positions: ReadonlyArray<number>): number[] {
  return Array.from({ length: Math.floor(positions.length / 3) }, (_, corner) => corner);
}

/**
 * Signed volume of a consistently wound mesh (Σ A·(B×C) / 6): positive when wound outward. An empty `indices` means `positions` is a
 * triangle soup.
 */
export function signedMeshVolume(positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number {
  const corners = indices.length > 0 ? indices : soupIndices(positions);
  const corner = (n: number): Vec3 => vec3At(positions, (corners[n] ?? 0) * 3);
  let sum = 0;
  for (let t = 0; t + 2 < corners.length; t += 3) sum += dot3(corner(t), cross3(corner(t + 1), corner(t + 2)));
  return sum / 6;
}

/** Swaps the 2nd and 3rd corner of every triangle in `corners`, in place. */
export function flipTriangleWinding<T>(corners: T[]): void {
  for (let i = 0; i + 2 < corners.length; i += 3) {
    const second = corners[i + 1] as T;
    corners[i + 1] = corners[i + 2] as T;
    corners[i + 2] = second;
  }
}

/**
 * Corner list of a closed mesh wound outward: `indices` as given (or the soup's own order), with every triangle flipped when the mesh is
 * inside-out. Never mutates its inputs.
 */
export function orientOutward(positions: ReadonlyArray<number>, indices: ReadonlyArray<number>): number[] {
  const corners = indices.length > 0 ? [...indices] : soupIndices(positions);
  if (signedMeshVolume(positions, corners) < 0) flipTriangleWinding(corners);
  return corners;
}
