/** Vertex welding and degenerate-triangle removal of a triangle soup (TECHNICAL_SPEC §5.1 step 3). Pure, deterministic (input order). */

export interface IndexedSurface {
  /** Flat xyz of the welded vertices. */
  readonly vertices: number[];
  /** Flat vertex indices, 3 per triangle. */
  readonly triangles: number[];
}

export interface WeldResult extends IndexedSurface {
  /** Triangles dropped for a repeated welded vertex or an area below `minArea`. */
  readonly degenerate: number;
}

/**
 * Weld vertices closer than `tolerance` (first occurrence wins) and drop degenerate triangles.
 * @invariant triangle order and winding of the survivors are those of the input
 */
export function weldSurface(positions: readonly number[], indices: readonly number[], tolerance: number, minArea: number): WeldResult {
  const vertexCount = Math.floor(positions.length / 3);
  const cell = tolerance > 0 ? tolerance : 1e-12;
  const buckets = new Map<string, number[]>();
  const vertices: number[] = [];
  const remap = new Int32Array(vertexCount);
  const at = (v: number, axis: number): number => positions[v * 3 + axis] ?? 0;
  for (let v = 0; v < vertexCount; v++) {
    const cx = Math.floor(at(v, 0) / cell);
    const cy = Math.floor(at(v, 1) / cell);
    const cz = Math.floor(at(v, 2) / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++)
          for (const w of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const near =
              Math.abs((vertices[w * 3] ?? 0) - at(v, 0)) <= tolerance &&
              Math.abs((vertices[w * 3 + 1] ?? 0) - at(v, 1)) <= tolerance &&
              Math.abs((vertices[w * 3 + 2] ?? 0) - at(v, 2)) <= tolerance;
            if (near) {
              found = w;
              break;
            }
          }
    if (found >= 0) {
      remap[v] = found;
      continue;
    }
    const index = vertices.length / 3;
    vertices.push(at(v, 0), at(v, 1), at(v, 2));
    remap[v] = index;
    const key = `${cx},${cy},${cz}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [index]);
    else bucket.push(index);
  }
  const triangles: number[] = [];
  let degenerate = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = remap[indices[t] ?? 0] ?? 0;
    const b = remap[indices[t + 1] ?? 0] ?? 0;
    const c = remap[indices[t + 2] ?? 0] ?? 0;
    if (a === b || b === c || a === c || triangleArea(vertices, a, b, c) < minArea) degenerate++;
    else triangles.push(a, b, c);
  }
  return { vertices, triangles, degenerate };
}

function triangleArea(vertices: readonly number[], a: number, b: number, c: number): number {
  const ux = (vertices[b * 3] ?? 0) - (vertices[a * 3] ?? 0);
  const uy = (vertices[b * 3 + 1] ?? 0) - (vertices[a * 3 + 1] ?? 0);
  const uz = (vertices[b * 3 + 2] ?? 0) - (vertices[a * 3 + 2] ?? 0);
  const vx = (vertices[c * 3] ?? 0) - (vertices[a * 3] ?? 0);
  const vy = (vertices[c * 3 + 1] ?? 0) - (vertices[a * 3 + 1] ?? 0);
  const vz = (vertices[c * 3 + 2] ?? 0) - (vertices[a * 3 + 2] ?? 0);
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
