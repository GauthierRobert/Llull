/**
 * Axis-aligned extent of flat component tuples.
 *
 * @layer lib
 * @pure
 */

/**
 * Component-wise min/max of `values` read as consecutive `components`-tuples (a trailing partial
 * tuple is ignored). With no whole tuple, min is `Infinity` and max `-Infinity` on every axis.
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
