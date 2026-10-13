/** Axis-aligned extent of flat component tuples. */

/**
 * Component-wise min/max of `values` read as consecutive `components`-tuples (a trailing partial tuple is ignored). With no whole tuple,
 * min is `Infinity` and max `-Infinity` on every axis.
 */
export function tupleExtent(values: ArrayLike<number>, components: number): { min: number[]; max: number[] } {
  const min = Array.from({ length: components }, () => Infinity);
  const max = Array.from({ length: components }, () => -Infinity);
  for (let i = 0; i + components <= values.length; i += components) {
    for (let axis = 0; axis < components; axis++) {
      const value = values[i + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  return { min, max };
}

/** 2D extents of `points`; all zeros for an empty list. */
export function pointsExtent(points: ReadonlyArray<readonly [number, number]>): { minX: number; minY: number; maxX: number; maxY: number } {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const { min, max } = tupleExtent(points.flat(), 2);
  return { minX: min[0] as number, minY: min[1] as number, maxX: max[0] as number, maxY: max[1] as number };
}

/** Diagonal of the 2D bounding box of `points`; 0 for an empty list. */
export function pointsDiagonal(points: ReadonlyArray<readonly [number, number]>): number {
  const { minX, minY, maxX, maxY } = pointsExtent(points);
  return Math.hypot(maxX - minX, maxY - minY);
}
