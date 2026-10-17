/**
 * Synthetic exact solids for convert_to_sheet_metal unit tests: a sheet-metal cross-section (straight runs and circular bends, in the XZ
 * plane) extruded along +Y, described as the face graph / topology an exact kernel would report, behind a minimal fake kernel.
 */
import type { GeometryKernel, ShapeEdge, ShapeHandle, ShapeTopology } from '@core/geometry/kernel';
import type { FaceGraph, FaceGraphFace, FaceQueryPort, SurfaceParams } from '@core/geometry/kernelPorts';
import { signedArea } from '@lib/polygon';
import type { ExecutionContext } from '@core/commands/types';
import { defaultContext } from '@core/commands/context';
import type { Vec2, Vec3 } from '@core/model/types';

export type Op = { readonly forward: number } | { readonly turn: 'left' | 'right'; readonly angleDeg: number; readonly radius: number };

interface Seg {
  readonly kind: 'line' | 'arc';
  readonly from: Vec2;
  readonly to: Vec2;
  readonly center?: Vec2;
  readonly radius?: number;
  readonly sweep?: number;
}

const rot = ([x, y]: Vec2, angle: number): Vec2 => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];

/** Closed counter-clockwise cross-section of a sheet of `thickness` whose bottom surface follows `ops` (material to the left). */
export function sheetProfile(thickness: number, ops: readonly Op[]): Seg[] {
  let pos: Vec2 = [0, 0];
  let dir: Vec2 = [1, 0];
  const bottom: Seg[] = [];
  const top: Seg[] = [];
  const left = (d: Vec2): Vec2 => [-d[1], d[0]];
  for (const op of ops) {
    const n = left(dir);
    if ('forward' in op) {
      const end = add(pos, mul(dir, op.forward));
      bottom.push({ kind: 'line', from: pos, to: end });
      top.push({ kind: 'line', from: add(pos, mul(n, thickness)), to: add(end, mul(n, thickness)) });
      pos = end;
      continue;
    }
    const sweep = (op.angleDeg * Math.PI) / 180;
    const sign = op.turn === 'left' ? 1 : -1;
    const center = op.turn === 'left' ? add(pos, mul(n, thickness + op.radius)) : sub(pos, mul(n, op.radius));
    const bottomRadius = op.turn === 'left' ? op.radius + thickness : op.radius;
    const topRadius = op.turn === 'left' ? op.radius : op.radius + thickness;
    const topStart = add(pos, mul(n, thickness));
    const turned = (p: Vec2): Vec2 => add(center, rot(sub(p, center), sign * sweep));
    bottom.push({ kind: 'arc', from: pos, to: turned(pos), center, radius: bottomRadius, sweep });
    top.push({ kind: 'arc', from: topStart, to: turned(topStart), center, radius: topRadius, sweep });
    pos = turned(pos);
    dir = rot(dir, sign * sweep);
  }
  const reverse = (seg: Seg): Seg => ({ ...seg, from: seg.to, to: seg.from });
  const loop: Seg[] = [
    ...bottom,
    { kind: 'line', from: bottom[bottom.length - 1]!.to, to: top[top.length - 1]!.to },
    ...[...top].reverse().map(reverse),
    { kind: 'line', from: top[0]!.from, to: bottom[0]!.from },
  ];
  const area = signedArea(loop.map((seg) => seg.from));
  return area >= 0 ? loop : [...loop].reverse().map(reverse);
}

export interface SyntheticSolid {
  readonly graph: FaceGraph;
  readonly topology: ShapeTopology;
  readonly kernel: GeometryKernel;
}

/** Exact area of a closed counter-clockwise loop of straight and circular segments (Green's theorem). */
function exactArea(profile: readonly Seg[]): number {
  return profile.reduce((sum, seg) => {
    if (seg.kind === 'line') return sum + (seg.from[0] * seg.to[1] - seg.to[0] * seg.from[1]) / 2;
    const [cx, cy] = seg.center as Vec2;
    const r = seg.radius as number;
    const a0 = Math.atan2(seg.from[1] - cy, seg.from[0] - cx);
    const a1 = Math.atan2(seg.to[1] - cy, seg.to[0] - cx);
    const delta = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
    return sum + (cx * r * (Math.sin(a0 + delta) - Math.sin(a0)) + cy * r * (Math.cos(a0) - Math.cos(a0 + delta)) + r * r * delta) / 2;
  }, 0);
}

const xyz = ([x, z]: Vec2, y: number): Vec3 => [x, y, z];

interface Tweakable {
  readonly faces: FaceGraphFace[];
  readonly edges: ShapeEdge[];
  readonly edgeFaces: number[][];
}

export interface SolidOptions {
  /** Mutates the generated faces / edges / adjacency to break one expectation of the conversion. */
  readonly tweak?: (parts: Tweakable) => void;
  /** A circular hole [x, y] centre and radius through the bottom face (face 0), as an inner loop. */
  readonly hole?: { readonly center: Vec2; readonly radius: number };
  /** Replace the area-based volume (a non-sheet solid). */
  readonly volume?: number;
  /** Face index every `distance` query answers (to pick a bend or an end wall); default the nearest straight face. */
  readonly pickFace?: number;
  /** The face query answers null (no face found). */
  readonly noFace?: boolean;
  /** Make the first seg face a cone-like unsupported surface. */
  readonly coneFace?: boolean;
}

export function syntheticSolid(profile: readonly Seg[], width: number, options: SolidOptions = {}): SyntheticSolid {
  const n = profile.length;
  const faces: FaceGraphFace[] = [];
  const edges: ShapeEdge[] = [];
  const edgeFaces: number[][] = [];
  const vertical = profile.map((seg, k) => {
    edges.push({
      index: edges.length,
      curve: 'line',
      length: width,
      start: xyz(seg.from, 0),
      end: xyz(seg.from, width),
      mid: xyz(seg.from, width / 2),
      seam: false,
      degenerate: false,
    });
    edgeFaces.push([(k + n - 1) % n, k]);
    return edges.length - 1;
  });
  const endEdges = [0, width].map((y, side) =>
    profile.map((seg, k) => {
      const samples =
        seg.kind === 'arc'
          ? Array.from({ length: 9 }, (_, i): Vec3 => {
              const center = seg.center as Vec2;
              const a0 = Math.atan2(seg.from[1] - center[1], seg.from[0] - center[0]);
              const a1 = Math.atan2(seg.to[1] - center[1], seg.to[0] - center[0]);
              const delta = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
              const angle = a0 + (delta * i) / 8;
              return xyz([center[0] + (seg.radius as number) * Math.cos(angle), center[1] + (seg.radius as number) * Math.sin(angle)], y);
            })
          : undefined;
      edges.push({
        index: edges.length,
        curve: seg.kind === 'arc' ? 'circle' : 'line',
        length: Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]),
        start: xyz(seg.from, y),
        end: xyz(seg.to, y),
        mid: xyz(seg.from, y),
        ...(samples !== undefined ? { samples } : {}),
        seam: false,
        degenerate: false,
      });
      edgeFaces.push([k, n + side]);
      return edges.length - 1;
    }),
  );
  profile.forEach((seg, k) => {
    const length = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
    const direction = mul(sub(seg.to, seg.from), 1 / length);
    const surface: SurfaceParams =
      seg.kind === 'line'
        ? { type: 'plane', origin: xyz(seg.from, 0), normal: [direction[1], 0, -direction[0]], xDir: [direction[0], 0, direction[1]] }
        : { type: 'cylinder', origin: xyz(seg.center as Vec2, 0), axis: [0, 1, 0], xDir: [1, 0, 0], radius: seg.radius as number };
    faces.push({
      index: k,
      surface:
        options.coneFace === true && k === 0
          ? { type: 'cone', apex: [0, 0, 0], axis: [0, 1, 0], xDir: [1, 0, 0], semiAngle: 0.5 }
          : surface,
      reversed: false,
      area: (seg.kind === 'arc' ? (seg.radius as number) * (seg.sweep as number) : length) * width,
      loops: [
        [
          vertical[k] as number,
          (endEdges[0] as number[])[k] as number,
          vertical[(k + 1) % n] as number,
          (endEdges[1] as number[])[k] as number,
        ],
      ],
      uvBounds: [0, seg.kind === 'arc' ? (seg.sweep as number) : length, 0, width],
    });
  });
  const sectionArea = exactArea(profile);
  [0, 1].forEach((side) =>
    faces.push({
      index: n + side,
      surface: { type: 'plane', origin: xyz([0, 0], side * width), normal: [0, side === 0 ? -1 : 1, 0], xDir: [1, 0, 0] },
      reversed: false,
      area: sectionArea,
      loops: [endEdges[side] as number[]],
      uvBounds: [0, 1, 0, 1],
    }),
  );
  if (options.hole !== undefined) {
    const { center, radius } = options.hole;
    const samples = Array.from(
      { length: 17 },
      (_, i): Vec3 => [center[0] + radius * Math.cos((2 * Math.PI * i) / 16), center[1] + radius * Math.sin((2 * Math.PI * i) / 16), 0],
    );
    edges.push({
      index: edges.length,
      curve: 'circle',
      length: 2 * Math.PI * radius,
      start: samples[0] as Vec3,
      end: samples[0] as Vec3,
      mid: samples[8] as Vec3,
      samples,
      seam: false,
      degenerate: false,
    });
    edgeFaces.push([0]);
    const face = faces[0] as FaceGraphFace;
    faces[0] = { ...face, loops: [...face.loops, [edges.length - 1]] };
  }
  options.tweak?.({ faces, edges, edgeFaces });
  const graph: FaceGraph = { faces, edgeFaces, edgeConvexity: edges.map(() => 'unknown') };
  const topology: ShapeTopology = {
    solids: 1,
    faces: faces.map((face) => ({
      index: face.index,
      surface: face.surface.type === 'plane' ? 'plane' : face.surface.type === 'cylinder' ? 'cylinder' : 'other',
      area: face.area,
    })),
    edges,
    vertices: 0,
    volume: options.volume ?? sectionArea * width,
  };
  const nearestFace = (point: Vec3): { face: number; distance: number } => {
    let best = { face: -1, distance: Infinity };
    profile.forEach((seg, k) => {
      if (seg.kind !== 'line') return;
      const d = mul(sub(seg.to, seg.from), 1 / Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]));
      const t = Math.min(
        Math.max((point[0] - seg.from[0]) * d[0] + (point[2] - seg.from[1]) * d[1], 0),
        Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]),
      );
      const foot = add(seg.from, mul(d, t));
      const distance = Math.hypot(point[0] - foot[0], point[2] - foot[1], Math.max(0, -point[1], point[1] - width));
      if (distance < best.distance - 1e-12) best = { face: k, distance };
    });
    return best;
  };
  const stub = (): null => null;
  const faceQuery = {
    faceDetails: stub,
    faceContains: stub,
    faceGraph: () => graph,
    faceGeometry: stub,
    projectOnFace: stub,
    evaluateFace: stub,
    tessellateFace: stub,
    faceSamples: stub,
    edgeSamples: stub,
    edgeContinuity: stub,
    distance: (_shape: ShapeHandle, points: readonly Vec3[]) =>
      options.noFace === true
        ? null
        : points.map((point) => ({
            ...nearestFace(point),
            ...(options.pickFace !== undefined ? { face: options.pickFace } : {}),
            signed: 0,
          })),
    bspline: stub,
  } as unknown as FaceQueryPort;
  const kernel: GeometryKernel = {
    supports: () => true,
    evaluate: () => ({}) as ShapeHandle,
    tessellate: () => null,
    topology: () => topology,
    exportStep: () => null,
    faceQuery,
  };
  return { graph, topology, kernel };
}

export const ctxWith = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
