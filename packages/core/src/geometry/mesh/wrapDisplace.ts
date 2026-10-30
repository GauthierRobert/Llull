/** Shrink-wrap and displacement of a triangle mesh (07 MSH FR-MSH-38 / FR-MSH-39, TECHNICAL_SPEC 13.18): vertices projected onto another mesh, or moved by a field. */

import { base64ToUint8Array } from '../../lib/base64';
import { compileExpression } from '../../lib/expression';
import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { EditMesh } from './editMesh';
import { heightFieldVolume, isClosed, passEdges, signedVolume } from './sculpt';
import { SurfaceIndex } from './surfaceIndex';

/** Triangles the refined mesh may reach in the TypeScript engine (a native twin would lift it): past it the displacement is refused. */
export const DISPLACE_MAX_TRIANGLES = 1_000_000;

export const SHRINKWRAP_MODES = ['nearest', 'normal', 'direction'] as const;
export const SHRINKWRAP_SIDES = ['keep', 'outside', 'inside'] as const;
type ShrinkwrapMode = (typeof SHRINKWRAP_MODES)[number];
type ShrinkwrapSide = (typeof SHRINKWRAP_SIDES)[number];

export interface ShrinkwrapParams {
  readonly mode: ShrinkwrapMode;
  /** `direction` mode: the projection axis (world, any length); the nearest hit along it either way wins. */
  readonly direction?: Vec3;
  /** Distance kept from the target surface along the target's face normal (document units). */
  readonly offset: number;
  /** Which side of the target the offset is on: the side the vertex was on (`keep`), the face-normal side, or against it. */
  readonly side: ShrinkwrapSide;
  /** Vertices farther than this from the target (along the ray, or nearest) stay where they are. */
  readonly maxDistance?: number;
}

export interface ShrinkwrapResult {
  readonly mesh: MeshData;
  readonly moved: number;
  readonly missed: number;
  readonly maxMove: number;
  readonly meanMove: number;
  /** Largest | distance from the result to the target - offset | over the moved vertices (0 on the surface for offset 0). */
  readonly residual: number;
}

export const DISPLACE_PLANES = ['xy', 'yz', 'xz'] as const;
type DisplacePlane = (typeof DISPLACE_PLANES)[number];

interface HeightMap {
  /** Base64 of `width * height` raw 8-bit grey values, row by row, the first row at the lowest v. */
  readonly pixels: string;
  readonly width: number;
  readonly height: number;
  readonly plane: DisplacePlane;
  /** [u, v] of the map's lower corner and [width, height] of the rectangle it covers, in the plane's two axes. */
  readonly origin: readonly [number, number];
  readonly size: readonly [number, number];
}

export interface DisplaceParams {
  readonly expression?: string;
  readonly heightMap?: HeightMap;
  /** Multiplies the field (document units per unit of the field). */
  readonly strength: number;
  /** The grey level that does not move a vertex (height map only), 0..1. */
  readonly midlevel: number;
  readonly direction: 'normal' | Vec3;
  /** Split every edge longer than this before displacing. */
  readonly refineEdge?: number;
  readonly maxTriangles?: number;
}

export interface DisplaceResult {
  readonly mesh: MeshData;
  readonly movedVertices: number;
  readonly maxDisplacement: number;
  readonly displacedVolume: number;
  readonly volumeBasis: 'closed-volume-difference' | 'height-field-sum';
  readonly refinedEdges: number;
}

export interface DisplaceFailure {
  readonly failure: string;
}

export interface DisplaceTooLarge {
  readonly tooLarge: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (positions: ReadonlyArray<number>, v: number): Vec3 => [
  positions[v * 3] as number,
  positions[v * 3 + 1] as number,
  positions[v * 3 + 2] as number,
];

function unitOf(a: Vec3): Vec3 | null {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 0 && Number.isFinite(length) ? [a[0] / length, a[1] / length, a[2] / length] : null;
}

/** Angle-weighted unit vertex normals (zero vector for a vertex without a non-degenerate triangle). */
function vertexNormalsOf(mesh: MeshData): Vec3[] {
  const sums: Vec3[] = Array.from({ length: mesh.positions.length / 3 }, (): Vec3 => [0, 0, 0]);
  for (let f = 0; f < mesh.indices.length; f += 3) {
    const ids = [mesh.indices[f] as number, mesh.indices[f + 1] as number, mesh.indices[f + 2] as number];
    const p = ids.map((v) => point(mesh.positions, v));
    const normal = unitOf(cross(sub(p[1] as Vec3, p[0] as Vec3), sub(p[2] as Vec3, p[0] as Vec3)));
    if (normal === null) continue;
    for (let k = 0; k < 3; k++) {
      const [e1, e2] = [unitOf(sub(p[(k + 1) % 3] as Vec3, p[k] as Vec3)), unitOf(sub(p[(k + 2) % 3] as Vec3, p[k] as Vec3))];
      if (e1 === null || e2 === null) continue;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
      const sum = sums[ids[k] as number] as Vec3;
      sums[ids[k] as number] = [sum[0] + angle * normal[0], sum[1] + angle * normal[1], sum[2] + angle * normal[2]];
    }
  }
  return sums.map((s) => unitOf(s) ?? [0, 0, 0]);
}

function faceNormal(mesh: MeshData, face: number): Vec3 {
  const [a, b, c] = [0, 1, 2].map((k) => point(mesh.positions, mesh.indices[face * 3 + k] as number)) as [Vec3, Vec3, Vec3];
  return unitOf(cross(sub(b, a), sub(c, a))) ?? [0, 0, 0];
}

/** Move every vertex of `mesh` onto `target` as `params` says; vertices that find nothing within `maxDistance` (or no hit along the ray) stay and are counted as missed. */
export function shrinkwrapMesh(mesh: MeshData, target: MeshData, params: ShrinkwrapParams): ShrinkwrapResult {
  const index = new SurfaceIndex(target.positions, target.indices);
  const normals = params.mode === 'normal' ? vertexNormalsOf(mesh) : null;
  const axis = params.mode === 'direction' && params.direction !== undefined ? unitOf(params.direction) : null;
  const reach = params.maxDistance ?? Infinity;
  const positions = mesh.positions.slice();
  let moved = 0;
  let missed = 0;
  let total = 0;
  let maxMove = 0;
  let residual = 0;
  const sign = (side: ShrinkwrapSide, vertex: Vec3, hit: Vec3, normal: Vec3): number =>
    side === 'outside' ? 1 : side === 'inside' ? -1 : dot(sub(vertex, hit), normal) < 0 ? -1 : 1;
  for (let v = 0; v < positions.length / 3; v++) {
    const p = point(mesh.positions, v);
    let hitPoint: Vec3 | null = null;
    let face = -1;
    if (params.mode === 'nearest') {
      const hit = index.closest(p);
      if (hit.face >= 0 && hit.distance <= reach) [hitPoint, face] = [hit.point, hit.face];
    } else {
      const direction = normals === null ? axis : unitOf(normals[v] as Vec3);
      if (direction !== null) {
        const forward = index.ray(p, direction, reach);
        const backward = index.ray(p, [-direction[0], -direction[1], -direction[2]], reach);
        const useForward = forward !== null && (backward === null || forward.distance <= backward.distance);
        const chosen = useForward ? forward : backward;
        if (chosen !== null) {
          const s = useForward ? 1 : -1;
          hitPoint = [
            p[0] + s * chosen.distance * direction[0],
            p[1] + s * chosen.distance * direction[1],
            p[2] + s * chosen.distance * direction[2],
          ];
          face = chosen.face;
        }
      }
    }
    if (hitPoint === null) {
      missed++;
      continue;
    }
    const normal = faceNormal(target, face);
    const s = params.offset === 0 ? 0 : sign(params.side, p, hitPoint, normal) * params.offset;
    const q: Vec3 = [hitPoint[0] + s * normal[0], hitPoint[1] + s * normal[1], hitPoint[2] + s * normal[2]];
    positions[v * 3] = q[0];
    positions[v * 3 + 1] = q[1];
    positions[v * 3 + 2] = q[2];
    const move = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (move > 0) moved++;
    total += move;
    maxMove = Math.max(maxMove, move);
    residual = Math.max(residual, Math.abs(index.closest(q).distance - Math.abs(params.offset)));
  }
  const handled = positions.length / 3 - missed;
  return {
    mesh: { positions, indices: mesh.indices.slice() },
    moved,
    missed,
    maxMove,
    meanMove: handled === 0 ? 0 : total / handled,
    residual,
  };
}

/** Split every edge longer than `limit` (passes until none is, at most 8), refusing past `maxTriangles`. */
function refineAll(mesh: MeshData, limit: number, maxTriangles: number): { mesh: MeshData; splits: number } | DisplaceTooLarge {
  const edit = new EditMesh(mesh.positions, mesh.indices);
  let splits = 0;
  for (let pass = 0; pass < 8; pass++) {
    let count = 0;
    for (const [u, v] of passEdges(edit)) {
      if (edit.liveFaces > maxTriangles) return { tooLarge: edit.liveFaces };
      if (edit.facesOnEdge(u, v).length === 0) continue;
      const [pu, pv] = [edit.p(u), edit.p(v)];
      if (Math.hypot(pu[0] - pv[0], pu[1] - pv[1], pu[2] - pv[2]) <= limit) continue;
      edit.split(u, v, [(pu[0] + pv[0]) / 2, (pu[1] + pv[1]) / 2, (pu[2] + pv[2]) / 2]);
      count++;
    }
    splits += count;
    if (count === 0) break;
  }
  return { mesh: edit.toMeshData(), splits };
}

const AXES: Record<DisplacePlane, [number, number]> = { xy: [0, 1], yz: [1, 2], xz: [0, 2] };

/** The grey level (0..1) of `map` at `p`, bilinear between pixel centres, clamped at the border; 0 outside the rectangle the map covers. */
function sampleMap(map: HeightMap, grey: Uint8Array, p: Vec3): number | null {
  const [a, b] = AXES[map.plane];
  const u = ((p[a] as number) - map.origin[0]) / map.size[0];
  const w = ((p[b] as number) - map.origin[1]) / map.size[1];
  if (!(u >= 0 && u <= 1 && w >= 0 && w <= 1)) return null;
  const [fx, fy] = [Math.min(Math.max(u * map.width - 0.5, 0), map.width - 1), Math.min(Math.max(w * map.height - 0.5, 0), map.height - 1)];
  const [x0, y0] = [Math.min(Math.floor(fx), map.width - 1), Math.min(Math.floor(fy), map.height - 1)];
  const [x1, y1] = [Math.min(x0 + 1, map.width - 1), Math.min(y0 + 1, map.height - 1)];
  const [tx, ty] = [fx - x0, fy - y0];
  const at = (x: number, y: number): number => (grey[y * map.width + x] as number) / 255;
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

/** Displace every vertex by `strength` x the field, along its normal or a fixed direction, after the optional global refinement. */
export function displaceMesh(input: MeshData, params: DisplaceParams): DisplaceResult | DisplaceFailure | DisplaceTooLarge {
  let grey: Uint8Array | null = null;
  if (params.heightMap !== undefined) {
    grey = base64ToUint8Array(params.heightMap.pixels);
    if (grey === null || grey.length !== params.heightMap.width * params.heightMap.height)
      return {
        failure: `the height map has ${grey?.length ?? 'undecodable'} grey values, not width x height = ${params.heightMap.width * params.heightMap.height}`,
      };
  }
  let mesh = input;
  let splits = 0;
  if (params.refineEdge !== undefined) {
    const refined = refineAll(input, params.refineEdge, params.maxTriangles ?? DISPLACE_MAX_TRIANGLES);
    if ('tooLarge' in refined) return refined;
    ({ mesh, splits } = refined);
  }
  const evaluate = params.expression === undefined ? null : compileExpression(params.expression);
  const normals = params.direction === 'normal' ? vertexNormalsOf(mesh) : null;
  const fixed = params.direction === 'normal' ? null : unitOf(params.direction);
  if (params.direction !== 'normal' && fixed === null) return { failure: 'the displacement direction has no length' };
  const count = mesh.positions.length / 3;
  const positions = new Array<number>(mesh.positions.length);
  let moved = 0;
  let maxDisplacement = 0;
  for (let v = 0; v < count; v++) {
    const p = point(mesh.positions, v);
    const n = normals === null ? (fixed as Vec3) : (normals[v] as Vec3);
    let field = 0;
    if (evaluate !== null) {
      const result = evaluate({ x: p[0], y: p[1], z: p[2], nx: n[0], ny: n[1], nz: n[2] });
      if (!result.ok) return { failure: `vertex ${v}: ${result.error}` };
      field = result.value;
    } else if (params.heightMap !== undefined && grey !== null) {
      const level = sampleMap(params.heightMap, grey, p);
      field = level === null ? 0 : level - params.midlevel;
    }
    const distance = params.strength * field;
    if (!Number.isFinite(distance)) return { failure: `vertex ${v}: strength x field is not a finite number (${distance})` };
    positions[v * 3] = p[0] + distance * n[0];
    positions[v * 3 + 1] = p[1] + distance * n[1];
    positions[v * 3 + 2] = p[2] + distance * n[2];
    if (distance !== 0 && (n[0] !== 0 || n[1] !== 0 || n[2] !== 0)) moved++;
    maxDisplacement = Math.max(maxDisplacement, Math.abs(distance));
  }
  const after = Array.from({ length: count }, (_, v) => point(positions, v));
  const before = Array.from({ length: count }, (_, v) => point(mesh.positions, v));
  const closed = isClosed(mesh.indices);
  return {
    mesh: { positions, indices: mesh.indices.slice() },
    movedVertices: moved,
    maxDisplacement,
    displacedVolume: closed ? signedVolume(after, mesh.indices) - signedVolume(before, mesh.indices) : heightFieldVolume(mesh, after),
    volumeBasis: closed ? 'closed-volume-difference' : 'height-field-sum',
    refinedEdges: splits,
  };
}
