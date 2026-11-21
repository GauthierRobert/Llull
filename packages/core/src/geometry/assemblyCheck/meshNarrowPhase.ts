/**
 * Mesh narrow phase (TECHNICAL_SPEC 5.3 step 4, TR-ASC-08): one batched triangle-BVH distance query per candidate pair through the injected
 * `GeometryQueryEngine.placedDistanceBatch` (the port a native batch `check_pairs` replaces, D7). A pair whose meshes are further apart than
 * the tolerance plus both display-mesh chord errors cannot touch, overlap or violate the clearance: it never reaches the kernel.
 * @invariant kernel-optional: this phase reads meshes only; the kernel (exact when native, mesh-accurate on Manifold) classifies what is left
 * @invariant conservative: a pair with a missing / empty mesh, or with one box inside the other (containment), is kept
 */

import type { AssemblyPart } from './partTypes';
import { type GeometryQueryEngine } from '../geometryQueries';

/** Display-mesh chord error bound (see `assemblyParts`): max(0.1, 1e-3 x bounding-box diagonal) document units. */
function chordBound(part: AssemblyPart): number {
  const diagonal = Math.hypot(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]);
  return Math.max(0.1, 1e-3 * diagonal);
}

/** One part's box lies inside the other's (grown by `slack`): containment gives no surface contact, so the mesh distance cannot clear it. */
function nested(a: AssemblyPart, b: AssemblyPart, slack: number): boolean {
  const inside = (inner: AssemblyPart, outer: AssemblyPart): boolean =>
    [0, 1, 2].every((k) => (inner.min[k] ?? 0) >= (outer.min[k] ?? 0) - slack && (inner.max[k] ?? 0) <= (outer.max[k] ?? 0) + slack);
  return inside(a, b) || inside(b, a);
}

/** Per pair: true when the meshes are provably further apart than `threshold` (document units). */
export function meshClearPairs(
  parts: readonly AssemblyPart[],
  pairs: ReadonlyArray<readonly [number, number]>,
  threshold: number,
  engine: GeometryQueryEngine,
): boolean[] {
  const usable = (part: AssemblyPart | undefined): part is AssemblyPart => part?.mesh != null && part.mesh.indices.length >= 3;
  const meshIndex = new Map<number, number>();
  const meshes: NonNullable<AssemblyPart['mesh']>[] = [];
  const queries: Array<{ pair: number; a: number; b: number; maxDistance: number }> = [];
  pairs.forEach(([i, j], pair) => {
    const [a, b] = [parts[i], parts[j]];
    if (!usable(a) || !usable(b) || nested(a, b, chordBound(a) + chordBound(b))) return;
    for (const [index, part] of [
      [i, a],
      [j, b],
    ] as const)
      if (!meshIndex.has(index)) {
        meshIndex.set(index, meshes.length);
        meshes.push(part.mesh as NonNullable<AssemblyPart['mesh']>);
      }
    queries.push({ pair, a: meshIndex.get(i) ?? 0, b: meshIndex.get(j) ?? 0, maxDistance: threshold + chordBound(a) + chordBound(b) });
  });
  const clear = pairs.map(() => false);
  if (queries.length === 0) return clear;
  const answers = engine.placedDistanceBatch(
    meshes,
    queries.map(({ a, b, maxDistance }) => ({ a, b, placement: null, maxDistance })),
  );
  queries.forEach(({ pair }, k) => {
    clear[pair] = answers[k] === null;
  });
  return clear;
}
