/** Numeric inspector of an indexed triangle mesh (07 MSH FR-MSH-03): counts, topology, shells, loops, orientation, area, volume, quality, self-intersections. */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, sub3 } from '../../lib/vec3';
import { findSelfIntersections } from './selfIntersection';
import { buildTopology } from './topology';
import { meshDiagonal } from './weld';

interface LoopSummary {
  readonly edges: number;
  readonly length: number;
  readonly centroid: Vec3;
}

interface ShellSummary {
  readonly faces: number;
  readonly vertices: number;
  readonly edges: number;
  readonly closed: boolean;
  readonly eulerCharacteristic: number;
  /** (2 - chi) / 2 of a closed manifold shell; null for an open or non-manifold shell. */
  readonly genus: number | null;
  readonly area: number;
  /** Signed volume (negative = inside-out); null when the shell is open. */
  readonly volume: number | null;
}

export interface MeshAnalysis {
  readonly vertices: number;
  readonly edges: number;
  readonly faces: number;
  readonly eulerCharacteristic: number;
  readonly genus: number | null;
  readonly closed: boolean;
  readonly manifold: boolean;
  readonly orientationConsistent: boolean;
  readonly boundaryEdges: number;
  readonly boundaryLoopCount: number;
  readonly boundaryLoops: LoopSummary[];
  readonly nonManifoldEdgeCount: number;
  readonly nonManifoldEdges: Array<{ readonly a: number; readonly b: number; readonly uses: number }>;
  readonly shellCount: number;
  readonly shells: ShellSummary[];
  readonly degenerateFaces: number;
  readonly duplicateFaces: number;
  readonly area: number;
  /** Sum of the signed volumes of the closed shells; null when no shell is closed. */
  readonly volume: number | null;
  /** Volume-weighted centroid of the closed shells; null when none is closed or the volume vanishes. */
  readonly centroid: Vec3 | null;
  readonly selfIntersectionPairs: number | null;
  readonly selfIntersections: Array<readonly [number, number]>;
  readonly edgeLength: { readonly min: number; readonly max: number; readonly mean: number };
  /** Longest edge / (2 sqrt(3) x inradius): 1 for an equilateral triangle. */
  readonly aspectRatio: { readonly max: number; readonly mean: number };
  readonly minAngleDeg: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly diagonal: number;
}

interface FaceMetrics {
  area: number;
  signedVolume: number;
  volumeCentroid: Vec3;
  aspect: number;
  minAngle: number;
  edges: [number, number, number];
}

function faceMetrics(corner: (i: number) => Vec3, a: number, b: number, c: number): FaceMetrics {
  const [pa, pb, pc] = [corner(a), corner(b), corner(c)];
  const normal = cross3(sub3(pb, pa), sub3(pc, pa));
  const area = Math.hypot(...normal) / 2;
  const edges: [number, number, number] = [Math.hypot(...sub3(pb, pa)), Math.hypot(...sub3(pc, pb)), Math.hypot(...sub3(pa, pc))];
  const perimeter = edges[0] + edges[1] + edges[2];
  const inradius = perimeter > 0 ? (2 * area) / perimeter : 0;
  const longest = Math.max(...edges);
  const angle = (adjacent1: number, adjacent2: number, opposite: number): number =>
    adjacent1 * adjacent2 > 0
      ? Math.acos(Math.max(-1, Math.min(1, (adjacent1 ** 2 + adjacent2 ** 2 - opposite ** 2) / (2 * adjacent1 * adjacent2))))
      : 0;
  const minAngle = Math.min(angle(edges[0], edges[2], edges[1]), angle(edges[0], edges[1], edges[2]), angle(edges[1], edges[2], edges[0]));
  const signedVolume = dot3(pa, cross3(pb, pc)) / 6;
  const volumeCentroid: Vec3 = [
    (signedVolume * (pa[0] + pb[0] + pc[0])) / 4,
    (signedVolume * (pa[1] + pb[1] + pc[1])) / 4,
    (signedVolume * (pa[2] + pb[2] + pc[2])) / 4,
  ];
  return { area, signedVolume, volumeCentroid, aspect: inradius > 0 ? longest / (2 * Math.sqrt(3) * inradius) : Infinity, minAngle, edges };
}

/**
 * Analyse a welded mesh. `selfIntersections` runs the pair search (skipped = null); lists are capped at `maxListed`.
 * @invariant deterministic: same arrays -> same report
 */
export function analyzeIndexedMesh(
  positions: ReadonlyArray<number>,
  triangles: ReadonlyArray<number>,
  options: { readonly selfIntersections: boolean; readonly maxListed: number },
): MeshAnalysis {
  const vertexCount = Math.floor(positions.length / 3);
  const topology = buildTopology(vertexCount, triangles);
  const corner = (i: number): Vec3 => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
  const shellFaces = Array.from({ length: topology.shellCount }, () => [] as number[]);
  topology.faceShell.forEach((shell, face) => shellFaces[shell]?.push(face));
  const metrics = Array.from({ length: topology.faceCount }, (_, f) =>
    faceMetrics(corner, triangles[f * 3] as number, triangles[f * 3 + 1] as number, triangles[f * 3 + 2] as number),
  );
  const edgeShell = new Map<number, number>();
  const collected = shellFaces.map((faces, shell) => {
    const vertices = new Set<number>();
    const edgeIds = new Set<number>();
    let area = 0;
    let volume = 0;
    for (const face of faces) {
      const ids = [triangles[face * 3] as number, triangles[face * 3 + 1] as number, triangles[face * 3 + 2] as number];
      ids.forEach((v, k) => {
        vertices.add(v);
        const w = ids[(k + 1) % 3] as number;
        const id = Math.min(v, w) * vertexCount + Math.max(v, w);
        edgeIds.add(id);
        edgeShell.set(id, shell);
      });
      area += (metrics[face] as FaceMetrics).area;
      volume += (metrics[face] as FaceMetrics).signedVolume;
    }
    return { faces, vertices, edgeIds, area, volume };
  });
  const unclosed = new Set<number>();
  for (const [a, b] of topology.boundaryEdges) unclosed.add(edgeShell.get(Math.min(a, b) * vertexCount + Math.max(a, b)) ?? -1);
  for (const e of topology.nonManifoldEdges) unclosed.add(edgeShell.get(e.a * vertexCount + e.b) ?? -1);
  const shells: ShellSummary[] = collected.map(({ faces, vertices, edgeIds, area, volume }, shell) => {
    const closed = !unclosed.has(shell);
    const consistent = !faces.some((face) => topology.inconsistentFaces.has(face));
    const chi = vertices.size - edgeIds.size + faces.length;
    return {
      faces: faces.length,
      vertices: vertices.size,
      edges: edgeIds.size,
      closed,
      eulerCharacteristic: chi,
      genus: closed && consistent && chi % 2 === 0 ? (2 - chi) / 2 : null,
      area,
      volume: closed && consistent ? volume : null,
    };
  });
  const closedShells = shells.filter((s) => s.volume !== null);
  const volume = closedShells.length > 0 ? closedShells.reduce((sum, s) => sum + (s.volume as number), 0) : null;
  let centroid: Vec3 | null = null;
  if (volume !== null && Math.abs(volume) > 0) {
    const weighted: [number, number, number] = [0, 0, 0];
    shellFaces.forEach((faces, shell) => {
      if (shells[shell]?.volume === null) return;
      for (const face of faces) {
        const m = (metrics[face] as FaceMetrics).volumeCentroid;
        weighted[0] += m[0];
        weighted[1] += m[1];
        weighted[2] += m[2];
      }
    });
    centroid = [weighted[0] / volume, weighted[1] / volume, weighted[2] / volume];
  }
  const finite = metrics.filter((m) => Number.isFinite(m.aspect));
  const edgeLengths = metrics.flatMap((m) => m.edges);
  const solidFaces = topology.faceCount - topology.degenerateFaces.length;
  const closed = solidFaces > 0 && topology.boundaryEdges.length === 0 && topology.nonManifoldEdges.length === 0;
  const degenerate = new Set(topology.degenerateFaces);
  const referenced = new Set(triangles.filter((_, k) => !degenerate.has(Math.floor(k / 3))));
  const euler = referenced.size - topology.edgeCount + solidFaces;
  const manifold = topology.nonManifoldEdges.length === 0;
  const intersections = options.selfIntersections ? findSelfIntersections(positions, triangles, options.maxListed) : null;
  const extent = bounds(positions);
  return {
    vertices: referenced.size,
    edges: topology.edgeCount,
    faces: topology.faceCount,
    eulerCharacteristic: euler,
    genus:
      closed && shells.length > 0 && shells.every((s) => s.genus !== null) ? shells.reduce((sum, s) => sum + (s.genus as number), 0) : null,
    closed,
    manifold,
    orientationConsistent: topology.inconsistentEdges === 0,
    boundaryEdges: topology.boundaryEdges.length,
    boundaryLoopCount: topology.loops.length,
    boundaryLoops: topology.loops.slice(0, options.maxListed).map(({ vertices }) => {
      const points = vertices.map(corner);
      const length = points.reduce((sum, p, k) => sum + Math.hypot(...sub3(points[(k + 1) % points.length] as Vec3, p)), 0);
      const sum = points.reduce<Vec3>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
      return { edges: vertices.length, length, centroid: [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length] };
    }),
    nonManifoldEdgeCount: topology.nonManifoldEdges.length,
    nonManifoldEdges: topology.nonManifoldEdges.slice(0, options.maxListed),
    shellCount: shells.length,
    shells: shells.slice(0, options.maxListed),
    degenerateFaces: topology.degenerateFaces.length,
    duplicateFaces: topology.duplicateFaces.length,
    area: metrics.reduce((sum, m) => sum + m.area, 0),
    volume,
    centroid,
    selfIntersectionPairs: intersections?.count ?? null,
    selfIntersections: intersections?.pairs ?? [],
    edgeLength: {
      min: edgeLengths.length > 0 ? edgeLengths.reduce((m, v) => Math.min(m, v), Infinity) : 0,
      max: edgeLengths.reduce((m, v) => Math.max(m, v), 0),
      mean: edgeLengths.length > 0 ? edgeLengths.reduce((s, v) => s + v, 0) / edgeLengths.length : 0,
    },
    aspectRatio: {
      max: finite.reduce((m, f) => Math.max(m, f.aspect), 0),
      mean: finite.length > 0 ? finite.reduce((s, f) => s + f.aspect, 0) / finite.length : 0,
    },
    minAngleDeg: metrics.length > 0 ? (metrics.reduce((m, f) => Math.min(m, f.minAngle), Infinity) * 180) / Math.PI : 0,
    bounds: extent,
    diagonal: meshDiagonal(positions),
  };
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNullable =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === null || check(value);
const isPair = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every(isCount);
const isList2 = (value: unknown): boolean => Array.isArray(value) && value.every(isPair);
const isPoint = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isNumber);
const isList = (value: unknown, item: (entry: Record<string, unknown>) => boolean): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null && item(entry as Record<string, unknown>));

/** True when `value` (parsed JSON from a native job) has every field and type of a `MeshAnalysis`: the check before the engine hands it to a command. */
export function isMeshAnalysis(value: unknown): value is MeshAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const stats = (key: string, fields: readonly string[]): boolean => {
    const entry = v[key];
    return typeof entry === 'object' && entry !== null && fields.every((field) => isNumber((entry as Record<string, unknown>)[field]));
  };
  const extent = v['bounds'] as Record<string, unknown> | null;
  return (
    [
      'vertices',
      'edges',
      'faces',
      'boundaryEdges',
      'boundaryLoopCount',
      'nonManifoldEdgeCount',
      'shellCount',
      'degenerateFaces',
      'duplicateFaces',
    ].every((key) => isCount(v[key])) &&
    ['eulerCharacteristic', 'area', 'minAngleDeg', 'diagonal'].every((key) => isNumber(v[key])) &&
    ['closed', 'manifold', 'orientationConsistent'].every((key) => typeof v[key] === 'boolean') &&
    isNullable(Number.isInteger)(v['genus']) &&
    isNullable(isNumber)(v['volume']) &&
    isNullable(isPoint)(v['centroid']) &&
    isNullable(isCount)(v['selfIntersectionPairs']) &&
    isList2(v['selfIntersections']) &&
    isList(v['boundaryLoops'], (l) => isCount(l['edges']) && isNumber(l['length']) && isPoint(l['centroid'])) &&
    isList(v['nonManifoldEdges'], (e) => isCount(e['a']) && isCount(e['b']) && isCount(e['uses'])) &&
    isList(
      v['shells'],
      (s) =>
        ['faces', 'vertices', 'edges'].every((key) => isCount(s[key])) &&
        typeof s['closed'] === 'boolean' &&
        isNumber(s['eulerCharacteristic']) &&
        isNullable(Number.isInteger)(s['genus']) &&
        isNumber(s['area']) &&
        isNullable(isNumber)(s['volume']),
    ) &&
    stats('edgeLength', ['min', 'max', 'mean']) &&
    stats('aspectRatio', ['max', 'mean']) &&
    extent !== null &&
    typeof extent === 'object' &&
    isPoint(extent['min']) &&
    isPoint(extent['max'])
  );
}

function bounds(positions: ReadonlyArray<number>): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  return positions.length === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}
