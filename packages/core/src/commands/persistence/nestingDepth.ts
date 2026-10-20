/**
 * Load-time nesting-depth guard: a value nested beyond `JSON.stringify`'s stack loads but can never be saved again (SC-D2).
 * Cost: one pass that only descends into containers. Scalars are never pushed: an array of numbers (mesh positions, indices, sample
 * tables: the bulk of a large document) costs one tight typeof loop and no allocation.
 */

/** Iterative (no recursion, so no stack overflow on hostile input): does `root` nest arrays/objects deeper than `limit`? */
export function exceedsNestingDepth(root: unknown, limit: number): boolean {
  const values: object[] = [];
  const depths: number[] = [];
  if (root !== null && typeof root === 'object') {
    values.push(root);
    depths.push(1);
  }
  while (values.length > 0) {
    const value = values.pop() as object;
    const depth = depths.pop() as number;
    if (depth > limit) return true;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const child: unknown = value[index];
        if (child !== null && typeof child === 'object') {
          values.push(child);
          depths.push(depth + 1);
        }
      }
      continue;
    }
    for (const key in value) {
      const child: unknown = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        values.push(child);
        depths.push(depth + 1);
      }
    }
  }
  return false;
}
