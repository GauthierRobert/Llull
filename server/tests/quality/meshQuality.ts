/**
 * @layer server/tests/quality
 *
 * Pure triangle-soup diagnostics for the import quality gates. Not a test file.
 * @invariant input is a flat world-space triangle soup [x0,y0,z0, ...] (9 numbers per triangle)
 */

export type Box6 = readonly [number, number, number, number, number, number];

export interface MeshReport {
  readonly triangles: number;
  readonly nonFiniteValues: number;
  /** Triangles whose area is below 1e-12 of the squared bbox diagonal. */
  readonly degenerateTriangles: number;
  /** Undirected edges used by exactly one triangle (holes / cracks). */
  readonly boundaryEdges: number;
  /** Undirected edges used by three or more triangles. */
  readonly nonManifoldEdges: number;
  readonly edges: number;
  /** Signed-tetrahedra volume: > 0 for a closed, outward-wound solid. */
  readonly signedVolume: number;
  readonly box: Box6;
}

/**
 * Vertex key quantised to `1e-6 · diagonal`, so seam vertices from adjacent faces weld.
 * Limitation: two vertices closer than the quantum that straddle a cell boundary do not weld
 * (a false boundary edge); OCCT seam vertices are bit-identical, so this is rare.
 */
function vertexKey(x: number, y: number, z: number, quantum: number): string {
  return `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
}

export function boxOf(positions: readonly number[]): Box6 {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis] ?? 0;
      box[axis] = Math.min(box[axis] ?? value, value);
      box[axis + 3] = Math.max(box[axis + 3] ?? value, value);
    }
  }
  return box as unknown as Box6;
}

export function diagonal(box: Box6): number {
  return Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
}

/** Largest per-component difference between two boxes. */
export function boxDistance(a: Box6, b: Box6): number {
  return Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? NaN))));
}

export function analyzeSoup(positions: readonly number[]): MeshReport {
  const box = boxOf(positions);
  const quantum = Math.max(diagonal(box), 1e-9) * 1e-6;
  const areaFloor = diagonal(box) * diagonal(box) * 1e-12;
  const edgeUse = new Map<string, number>();
  let nonFiniteValues = 0;
  let degenerateTriangles = 0;
  let signedVolume = 0;
  for (const value of positions) if (!Number.isFinite(value)) nonFiniteValues += 1;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = positions.slice(i, i + 9) as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) / 2 < areaFloor) degenerateTriangles += 1;
    signedVolume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const keys = [
      vertexKey(ax, ay, az, quantum),
      vertexKey(bx, by, bz, quantum),
      vertexKey(cx, cy, cz, quantum),
    ];
    for (let corner = 0; corner < 3; corner += 1) {
      const from = keys[corner] ?? '';
      const to = keys[(corner + 1) % 3] ?? '';
      if (from === to) continue;
      const edge = from < to ? `${from}|${to}` : `${to}|${from}`;
      edgeUse.set(edge, (edgeUse.get(edge) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const uses of edgeUse.values()) {
    if (uses === 1) boundaryEdges += 1;
    else if (uses > 2) nonManifoldEdges += 1;
  }
  return {
    triangles: Math.floor(positions.length / 9),
    nonFiniteValues,
    degenerateTriangles,
    boundaryEdges,
    nonManifoldEdges,
    edges: edgeUse.size,
    signedVolume,
    box,
  };
}

/**
 * Pair imported body boxes with reference solid boxes, globally nearest pairs first (so two
 * near-identical parts cannot steal each other's match).
 * @invariant callers check imported.length === reference.length separately (`imports` check);
 *   unmatched reference boxes are therefore not reported here
 * @returns indices of imported boxes with no reference within `relativeTolerance · diagonal + absolute`
 */
export function unmatchedBoxes(
  imported: readonly Box6[],
  reference: readonly Box6[],
  relativeTolerance: number,
  absolute: number,
): number[] {
  const pairs: { body: number; solid: number; distance: number }[] = [];
  imported.forEach((box, body) =>
    reference.forEach((candidate, solid) => {
      const distance = boxDistance(box, candidate);
      if (distance <= relativeTolerance * diagonal(candidate) + absolute) {
        pairs.push({ body, solid, distance });
      }
    }),
  );
  pairs.sort((a, b) => a.distance - b.distance);
  const matchedBodies = new Set<number>();
  const usedSolids = new Set<number>();
  for (const { body, solid } of pairs) {
    if (matchedBodies.has(body) || usedSolids.has(solid)) continue;
    matchedBodies.add(body);
    usedSolids.add(solid);
  }
  return imported.map((_, index) => index).filter((index) => !matchedBodies.has(index));
}
