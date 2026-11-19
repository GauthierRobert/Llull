/**
 * Area, volume and edge health of a large indexed mesh with typed arrays only (no per-edge objects): the measure the mesh commands report
 * before and after an operation on a million triangles. Closed means every edge is used by exactly two faces running in opposite directions.
 */

import type { MeshData } from '../../model/types';

export interface FastMeasure {
  readonly faces: number;
  readonly vertices: number;
  readonly area: number;
  /** Signed volume when the mesh is closed and consistently wound; else null. */
  readonly volume: number | null;
  /** Volume centroid when `volume` is a non-zero number; else null. */
  readonly centroid: readonly [number, number, number] | null;
  readonly closed: boolean;
  /** Faces repeating a vertex index. */
  readonly degenerateFaces: number;
  /** Edges used by exactly one face. */
  readonly boundaryEdges: number;
  /** Edges used by more than two faces. */
  readonly nonManifoldEdges: number;
  /** Edges whose two faces run in the same direction (orientation disagreement). */
  readonly inconsistentEdges: number;
}

interface EdgeHealth {
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly inconsistentEdges: number;
}

/** Runs of equal undirected edges in sorted `keys` (edge x 2 + direction bit), counted by use. */
function countRuns(keys: Float64Array | Uint32Array, from: number, to: number, tally: Int32Array): void {
  for (let i = from; i < to; ) {
    const edge = Math.floor((keys[i] as number) / 2);
    let end = i + 1;
    while (end < to && Math.floor((keys[end] as number) / 2) === edge) end++;
    const uses = end - i;
    if (uses === 1) tally[0] = (tally[0] as number) + 1;
    else if (uses > 2) tally[1] = (tally[1] as number) + 1;
    else if ((keys[i] as number) % 2 === (keys[i + 1] as number) % 2) tally[2] = (tally[2] as number) + 1;
    i = end;
  }
}

/** Edge health by one sort of every edge key: the reference, kept for meshes whose indices are not vertex numbers. */
function edgeHealthBySort(indices: ReadonlyArray<number>, faces: number, vertexCount: number): EdgeHealth {
  const keys = new Float64Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k] as number;
      const b = indices[f * 3 + ((k + 1) % 3)] as number;
      keys[f * 3 + k] = (Math.min(a, b) * vertexCount + Math.max(a, b)) * 2 + (a < b ? 1 : 0);
    }
  }
  keys.sort();
  const tally = new Int32Array(3);
  countRuns(keys, 0, keys.length, tally);
  return { boundaryEdges: tally[0] as number, nonManifoldEdges: tally[1] as number, inconsistentEdges: tally[2] as number };
}

/** Rows up to this length are ordered by insertion; a longer one (a vertex with very many edges) by the typed-array sort. */
const SHORT_ROW = 24;

/**
 * Edge health without a global sort: every edge goes to the row of its lower vertex (counting sort), then each row (a handful of
 * entries: higher vertex x 2 + direction bit) is ordered on its own. Same counts as `edgeHealthBySort` for indices in 0..vertexCount-1 while
 * 2·vertexCount² ≤ 2^53 (vertexCount ≤ ~6.7e7): beyond that the Float64 key of the sort merges distinct edges and this count is the exact one.
 */
function edgeHealthByVertex(indices: ReadonlyArray<number>, faces: number, vertexCount: number): EdgeHealth {
  const rowStart = new Uint32Array(vertexCount + 1);
  for (let f = 0; f < faces; f++) {
    const a = indices[f * 3] as number;
    const b = indices[f * 3 + 1] as number;
    const c = indices[f * 3 + 2] as number;
    rowStart[(a < b ? a : b) + 1] = (rowStart[(a < b ? a : b) + 1] as number) + 1;
    rowStart[(b < c ? b : c) + 1] = (rowStart[(b < c ? b : c) + 1] as number) + 1;
    rowStart[(c < a ? c : a) + 1] = (rowStart[(c < a ? c : a) + 1] as number) + 1;
  }
  for (let v = 0; v < vertexCount; v++) rowStart[v + 1] = (rowStart[v + 1] as number) + (rowStart[v] as number);
  const next = rowStart.slice(0, vertexCount);
  const rows = new Uint32Array(faces * 3);
  const place = (a: number, b: number): void => {
    const low = a < b ? a : b;
    const slot = next[low] as number;
    next[low] = slot + 1;
    rows[slot] = a < b ? b * 2 + 1 : a * 2;
  };
  for (let f = 0; f < faces; f++) {
    const a = indices[f * 3] as number;
    const b = indices[f * 3 + 1] as number;
    const c = indices[f * 3 + 2] as number;
    place(a, b);
    place(b, c);
    place(c, a);
  }
  const tally = new Int32Array(3);
  for (let v = 0; v < vertexCount; v++) {
    const from = rowStart[v] as number;
    const to = rowStart[v + 1] as number;
    if (to - from > SHORT_ROW) rows.subarray(from, to).sort();
    else {
      for (let i = from + 1; i < to; i++) {
        const key = rows[i] as number;
        let j = i - 1;
        for (; j >= from && (rows[j] as number) > key; j--) rows[j + 1] = rows[j] as number;
        rows[j + 1] = key;
      }
    }
    countRuns(rows, from, to, tally);
  }
  return { boundaryEdges: tally[0] as number, nonManifoldEdges: tally[1] as number, inconsistentEdges: tally[2] as number };
}

export function fastMeasure(mesh: MeshData): FastMeasure {
  const { positions, indices } = mesh;
  const faces = Math.floor(indices.length / 3);
  const vertexCount = positions.length / 3;
  const referenced = new Uint8Array(vertexCount);
  let area = 0;
  let volume = 0;
  let cxSum = 0;
  let cySum = 0;
  let czSum = 0;
  let degenerateFaces = 0;
  let vertexNumbers = Number.isInteger(vertexCount) && vertexCount < 0x7fffffff;
  for (let f = 0; f < faces; f++) {
    const a = indices[f * 3] as number;
    const b = indices[f * 3 + 1] as number;
    const c = indices[f * 3 + 2] as number;
    // An index that is not a vertex number (negative, fractional, past the end) fails one of these: `>>> 0` keeps only 0..2^32-1 integers.
    if (a >>> 0 !== a || b >>> 0 !== b || c >>> 0 !== c || a >= vertexCount || b >= vertexCount || c >= vertexCount) vertexNumbers = false;
    referenced[a] = 1;
    referenced[b] = 1;
    referenced[c] = 1;
    if (a === b || b === c || a === c) degenerateFaces++;
    const ax = positions[a * 3] as number;
    const ay = positions[a * 3 + 1] as number;
    const az = positions[a * 3 + 2] as number;
    const bx = positions[b * 3] as number;
    const by = positions[b * 3 + 1] as number;
    const bz = positions[b * 3 + 2] as number;
    const cx = positions[c * 3] as number;
    const cy = positions[c * 3 + 1] as number;
    const cz = positions[c * 3 + 2] as number;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const signed = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    volume += signed;
    cxSum += (signed * (ax + bx + cx)) / 4;
    cySum += (signed * (ay + by + cy)) / 4;
    czSum += (signed * (az + bz + cz)) / 4;
  }
  const { boundaryEdges, nonManifoldEdges, inconsistentEdges } = vertexNumbers
    ? edgeHealthByVertex(indices, faces, vertexCount)
    : edgeHealthBySort(indices, faces, vertexCount);
  let vertices = 0;
  for (const used of referenced) vertices += used;
  const closed = faces > 0 && degenerateFaces === 0 && boundaryEdges === 0 && nonManifoldEdges === 0;
  const measured = closed && inconsistentEdges === 0;
  return {
    faces,
    vertices,
    area,
    volume: measured ? volume : null,
    centroid: measured && volume !== 0 ? [cxSum / volume, cySum / volume, czSum / volume] : null,
    closed,
    degenerateFaces,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
  };
}
