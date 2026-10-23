/**
 * Mesh repair modes of increasing intrusiveness (07 MSH FR-MSH-05): weld, clean, orient, stitch, close_holes, plus the removal of small
 * shells. Every step reports what it changed. Exact doubles, deterministic (lowest index wins every tie).
 * @invariant no step moves a surviving vertex except `weld` / `stitch`, which merge vertices onto the lowest-index one of their cluster
 */

import type { MeshData } from '../../model/types';
import { analyzeIndexedMesh } from './analysis';
import { fillHoles } from './holeFill';
import { buildTopology } from './topology';
import { meshDiagonal, weldMesh } from './weld';

export type RepairMode = 'weld' | 'clean' | 'orient' | 'stitch' | 'close_holes';

export interface SmallComponentRule {
  readonly maxFaces?: number;
  readonly maxVolume?: number;
}

export interface RepairParams {
  readonly mode: RepairMode;
  readonly weldTolerance: number;
  readonly maxGap: number;
  readonly smallComponents?: SmallComponentRule;
  readonly maxBoundaryEdges: number;
}

export interface RepairChanges {
  welded: number;
  duplicatesRemoved: number;
  degenerateRemoved: number;
  flipped: number;
  stitched: number;
  holesFilled: number;
  componentsRemoved: number;
  facesRemovedWithComponents: number;
}

export interface RepairOutcome {
  readonly mesh: MeshData;
  readonly changes: RepairChanges;
  readonly notes: string[];
  readonly skippedHoles: number;
}

/** First-use canonical renumbering; unreferenced vertices disappear. */
function compact(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>): MeshData {
  const remap = new Map<number, number>();
  const out: number[] = [];
  const indices = triangles.map((v) => {
    let m = remap.get(v);
    if (m === undefined) {
      m = out.length / 3;
      out.push(positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number);
      remap.set(v, m);
    }
    return m;
  });
  return { positions: out, indices };
}

/** Remove faces with a repeated vertex or area below `areaFloor`, and later copies of a face with the same vertex set. */
function cleanFaces(
  positions: ReadonlyArray<number>,
  triangles: ReadonlyArray<number>,
  areaFloor: number,
  dropDuplicates: boolean,
): { triangles: number[]; degenerate: number; duplicates: number } {
  const kept: number[] = [];
  const seen = new Set<string>();
  let degenerate = 0;
  let duplicates = 0;
  for (let f = 0; f + 2 < triangles.length; f += 3) {
    const [a, b, c] = [triangles[f] as number, triangles[f + 1] as number, triangles[f + 2] as number];
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    const p = (v: number): [number, number, number] => [
      positions[v * 3] as number,
      positions[v * 3 + 1] as number,
      positions[v * 3 + 2] as number,
    ];
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const w = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const area =
      Math.hypot(
        (u[1] as number) * (w[2] as number) - (u[2] as number) * (w[1] as number),
        (u[2] as number) * (w[0] as number) - (u[0] as number) * (w[2] as number),
        (u[0] as number) * (w[1] as number) - (u[1] as number) * (w[0] as number),
      ) / 2;
    if (area <= areaFloor) {
      degenerate++;
      continue;
    }
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (dropDuplicates && seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    kept.push(a, b, c);
  }
  return { triangles: kept, degenerate, duplicates };
}

/** Make every shell's winding consistent (BFS from its lowest face), then outward when the shell is closed. Returns the faces flipped. */
function orientFaces(positions: ReadonlyArray<number>, triangles: number[]): number {
  const faceCount = triangles.length / 3;
  const vertexCount = positions.length / 3;
  const edgeFaces = new Map<number, Array<{ face: number; forward: boolean }>>();
  for (let f = 0; f < faceCount; f++)
    for (let k = 0; k < 3; k++) {
      const [a, b] = [triangles[f * 3 + k] as number, triangles[f * 3 + ((k + 1) % 3)] as number];
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      const list = edgeFaces.get(key) ?? [];
      list.push({ face: f, forward: a < b });
      edgeFaces.set(key, list);
    }
  const flipped = new Int8Array(faceCount).fill(-1);
  const components: number[][] = [];
  for (let seed = 0; seed < faceCount; seed++) {
    if ((flipped[seed] as number) >= 0) continue;
    const component = [seed];
    flipped[seed] = 0;
    for (let head = 0; head < component.length; head++) {
      const f = component[head] as number;
      for (let k = 0; k < 3; k++) {
        const [a, b] = [triangles[f * 3 + k] as number, triangles[f * 3 + ((k + 1) % 3)] as number];
        const uses = edgeFaces.get(Math.min(a, b) * vertexCount + Math.max(a, b)) as Array<{ face: number; forward: boolean }>;
        if (uses.length !== 2) continue;
        const effective = a < b !== ((flipped[f] as number) === 1);
        for (const other of uses) {
          if (other.face === f || (flipped[other.face] as number) >= 0) continue;
          flipped[other.face] = other.forward === effective ? 1 : 0;
          component.push(other.face);
        }
      }
    }
    components.push(component);
  }
  for (const component of components) {
    const closed = component.every((f) =>
      [0, 1, 2].every((k) => {
        const [a, b] = [triangles[f * 3 + k] as number, triangles[f * 3 + ((k + 1) % 3)] as number];
        return (edgeFaces.get(Math.min(a, b) * vertexCount + Math.max(a, b)) as unknown[]).length === 2;
      }),
    );
    if (!closed) continue;
    let volume = 0;
    for (const f of component) {
      const corner = [0, 1, 2].map((k) => triangles[f * 3 + k] as number);
      const order = (flipped[f] as number) === 1 ? [corner[0], corner[2], corner[1]] : corner;
      const [a, b, c] = order.map(
        (v) => [positions[(v as number) * 3], positions[(v as number) * 3 + 1], positions[(v as number) * 3 + 2]] as number[],
      ) as [number[], number[], number[]];
      volume +=
        ((a[0] as number) * ((b[1] as number) * (c[2] as number) - (b[2] as number) * (c[1] as number)) -
          (a[1] as number) * ((b[0] as number) * (c[2] as number) - (b[2] as number) * (c[0] as number)) +
          (a[2] as number) * ((b[0] as number) * (c[1] as number) - (b[1] as number) * (c[0] as number))) /
        6;
    }
    if (volume < 0) for (const f of component) flipped[f] = (flipped[f] as number) === 1 ? 0 : 1;
  }
  let count = 0;
  for (let f = 0; f < faceCount; f++) {
    if ((flipped[f] as number) !== 1) continue;
    const tmp = triangles[f * 3 + 1] as number;
    triangles[f * 3 + 1] = triangles[f * 3 + 2] as number;
    triangles[f * 3 + 2] = tmp;
    count++;
  }
  return count;
}

/** Merge boundary vertices closer than `maxGap` (lowest index wins) when that does not create non-manifold edges. */
function stitchVertices(
  positions: ReadonlyArray<number>,
  triangles: ReadonlyArray<number>,
  maxGap: number,
): { triangles: number[]; merged: number; reverted: boolean } {
  const vertexCount = positions.length / 3;
  const topology = buildTopology(vertexCount, triangles);
  const boundary = new Set<number>();
  for (const [a, b] of topology.boundaryEdges) {
    boundary.add(a);
    boundary.add(b);
  }
  const cell = Math.max(maxGap, 1e-300);
  const grid = new Map<string, number[]>();
  const keyOf = (v: number): [number, number, number] => [
    Math.floor((positions[v * 3] as number) / cell),
    Math.floor((positions[v * 3 + 1] as number) / cell),
    Math.floor((positions[v * 3 + 2] as number) / cell),
  ];
  const interior = new Set<number>();
  const edgeKey = (a: number, b: number): number => Math.min(a, b) * vertexCount + Math.max(a, b);
  const uses = new Map<number, number>();
  for (let f = 0; f + 2 < triangles.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(triangles[f + k] as number, triangles[f + ((k + 1) % 3)] as number);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  for (const [key, count] of uses) if (count > 1) interior.add(key);
  const target = new Int32Array(vertexCount).map((_, i) => i);
  let merged = 0;
  for (const v of [...boundary].sort((a, b) => a - b)) {
    const [ci, cj, ck] = keyOf(v);
    let best = -1;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (let dk = -1; dk <= 1; dk++)
          for (const u of grid.get(`${ci + di},${cj + dj},${ck + dk}`) ?? []) {
            if (target[u] !== u || interior.has(edgeKey(u, v))) continue;
            const d = Math.hypot(
              (positions[u * 3] as number) - (positions[v * 3] as number),
              (positions[u * 3 + 1] as number) - (positions[v * 3 + 1] as number),
              (positions[u * 3 + 2] as number) - (positions[v * 3 + 2] as number),
            );
            if (d <= maxGap && (best < 0 || u < best)) best = u;
          }
    if (best >= 0) {
      target[v] = best;
      merged++;
    } else {
      const key = `${ci},${cj},${ck}`;
      grid.set(key, [...(grid.get(key) ?? []), v]);
    }
  }
  if (merged === 0) return { triangles: [...triangles], merged: 0, reverted: false };
  const remapped = triangles.map((v) => target[v] as number);
  const cleaned = cleanFaces(positions, remapped, 0, true).triangles;
  const after = buildTopology(vertexCount, cleaned);
  const worse =
    after.nonManifoldEdges.length > topology.nonManifoldEdges.length || after.boundaryEdges.length > topology.boundaryEdges.length;
  return worse ? { triangles: [...triangles], merged: 0, reverted: true } : { triangles: cleaned, merged, reverted: false };
}

/** Remove shells with at most `maxFaces` faces or (closed shells) |volume| at most `maxVolume`; the largest shell always stays. */
function removeSmallShells(
  positions: ReadonlyArray<number>,
  triangles: number[],
  rule: SmallComponentRule,
): { triangles: number[]; shells: number; faces: number } {
  const analysis = analyzeIndexedMesh(positions, triangles, { selfIntersections: false, maxListed: Number.MAX_SAFE_INTEGER });
  const topology = buildTopology(positions.length / 3, triangles);
  const small = analysis.shells.map(
    (shell) =>
      (rule.maxFaces !== undefined && shell.faces <= rule.maxFaces) ||
      (rule.maxVolume !== undefined && shell.volume !== null && Math.abs(shell.volume) <= rule.maxVolume),
  );
  if (small.length > 0 && small.every(Boolean)) {
    let largest = 0;
    analysis.shells.forEach((shell, k) => {
      if (shell.faces > (analysis.shells[largest]?.faces ?? 0)) largest = k;
    });
    small[largest] = false;
  }
  const kept: number[] = [];
  let faces = 0;
  for (let f = 0; f < topology.faceCount; f++) {
    const shell = topology.faceShell[f] as number;
    if (shell >= 0 && small[shell] === true) {
      faces++;
      continue;
    }
    kept.push(triangles[f * 3] as number, triangles[f * 3 + 1] as number, triangles[f * 3 + 2] as number);
  }
  return { triangles: kept, shells: small.filter(Boolean).length, faces };
}

/** Run one repair mode on `input` (any indexed mesh; vertices are welded first at `weldTolerance`). */
export function repairTriangles(input: MeshData, params: RepairParams): RepairOutcome {
  const changes: RepairChanges = {
    welded: 0,
    duplicatesRemoved: 0,
    degenerateRemoved: 0,
    flipped: 0,
    stitched: 0,
    holesFilled: 0,
    componentsRemoved: 0,
    facesRemovedWithComponents: 0,
  };
  const notes: string[] = [];
  const welded = weldMesh(input, params.weldTolerance);
  changes.welded = welded.mergedVertices;
  let positions: number[] = welded.positions;
  let triangles: number[] = welded.triangles;
  const areaFloor = 1e-12 * meshDiagonal(positions) ** 2;
  const clean = (): void => {
    const result = cleanFaces(positions, triangles, areaFloor, true);
    changes.degenerateRemoved += result.degenerate;
    changes.duplicatesRemoved += result.duplicates;
    triangles = result.triangles;
  };
  if (params.mode === 'weld') {
    const result = cleanFaces(positions, triangles, -1, false);
    changes.degenerateRemoved += result.degenerate;
    triangles = result.triangles;
  } else if (params.mode === 'clean' || params.mode === 'stitch' || params.mode === 'close_holes') {
    clean();
  }
  if (params.mode === 'stitch' || params.mode === 'close_holes') {
    const result = stitchVertices(positions, triangles, params.maxGap);
    triangles = result.triangles;
    changes.stitched = result.merged;
    if (result.reverted)
      notes.push('stitch reverted: merging the close boundary vertices would create non-manifold edges or more boundary');
    clean();
  }
  if (params.smallComponents !== undefined) {
    const result = removeSmallShells(positions, triangles, params.smallComponents);
    triangles = result.triangles;
    changes.componentsRemoved = result.shells;
    changes.facesRemovedWithComponents = result.faces;
  }
  let skippedHoles = 0;
  if (params.mode === 'close_holes') {
    const compacted = compact(positions, triangles);
    const filled = fillHoles(compacted.positions, compacted.indices, {
      select: 'all',
      maxBoundaryEdges: params.maxBoundaryEdges,
      fairing: 'none',
      refine: false,
    });
    changes.holesFilled = filled.filled.length;
    skippedHoles = filled.skipped.length;
    positions = [...filled.mesh.positions];
    triangles = [...filled.mesh.indices];
  }
  if (params.mode === 'orient') changes.flipped = orientFaces(positions, triangles);
  return { mesh: compact(positions, triangles), changes, notes, skippedHoles };
}
