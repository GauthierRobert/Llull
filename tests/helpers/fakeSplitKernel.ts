/**
 * A fake exact kernel with SPLIT analytic solids for the chain tests of 03 WRP (spec §14.13), no OCCT: `add_cone` (r 20, h 40, apex up) is one cone side face cut into two halves along its
 * two rulings (x > 0 and x < 0), `add_sphere` (r 25) into two hemispheres by the plane x = 0, `add_torus` (R 10, r 3) into two halves by the meridian planes at azimuth 0.5 and pi + 0.5.
 * Face queries are analytic (projection, containment, edge samples, adjacency); `emboss` only adds the closed-form volume. The exact geometry is proved on the native kernel in
 * server/tests/nativeWrapChain2.test.ts.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import type { FaceGraph, FaceProjection, SurfaceParams } from '@core/geometry/kernelPorts';
import { embossClosedForm } from '@core/geometry/embossVolume';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { Vec2, Vec3 } from '@core/model/types';
import { TETRA } from './fakeKernel';

interface SplitFace {
  readonly surface: SurfaceParams;
  /** Whether the point is on the face, within `tolerance` (document units) of its edges. */
  readonly contains: (p: Vec3, tolerance?: number) => boolean;
  readonly sample: Vec3;
}

interface SplitShape {
  readonly id: string;
  readonly volume: number;
  readonly faces: readonly SplitFace[];
  /** Per edge the two faces it joins and `count` points along it. */
  readonly edges: ReadonlyArray<{
    readonly faces: readonly [number, number];
    readonly points: (count: number) => Vec3[];
    readonly convexity?: 'convex' | 'concave' | 'unknown';
  }>;
}

const azimuth = (p: Vec3): number => ((Math.atan2(p[1], p[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const ALPHA = Math.atan2(20, 40);
const APEX: Vec3 = [0, 0, 40];

function projectCone(p: Vec3): { point: Vec3; normal: Vec3; distance: number } {
  const phi = Math.atan2(p[1], p[0]);
  const t = APEX[2] - p[2];
  const s = Math.hypot(p[0], p[1]);
  const rho = Math.max(0, t * Math.cos(ALPHA) + s * Math.sin(ALPHA));
  const g: Vec3 = [Math.sin(ALPHA) * Math.cos(phi), Math.sin(ALPHA) * Math.sin(phi), -Math.cos(ALPHA)];
  const point: Vec3 = [APEX[0] + rho * g[0], APEX[1] + rho * g[1], APEX[2] + rho * g[2]];
  return {
    point,
    normal: [Math.cos(ALPHA) * Math.cos(phi), Math.cos(ALPHA) * Math.sin(phi), Math.sin(ALPHA)],
    distance: Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]),
  };
}

function projectSphere(p: Vec3, radius: number): { point: Vec3; normal: Vec3; distance: number } {
  const length = Math.hypot(...p) || 1;
  const normal: Vec3 = [p[0] / length, p[1] / length, p[2] / length];
  return { point: [normal[0] * radius, normal[1] * radius, normal[2] * radius], normal, distance: Math.abs(length - radius) };
}

function projectTorus(p: Vec3, major: number, minor: number): { point: Vec3; normal: Vec3; distance: number } {
  const rho = Math.hypot(p[0], p[1]) || 1;
  const ring: Vec3 = [p[0] / rho, p[1] / rho, 0];
  const tube = Math.hypot(rho - major, p[2]) || 1;
  const normal: Vec3 = [(ring[0] * (rho - major)) / tube, (ring[1] * (rho - major)) / tube, p[2] / tube];
  return {
    point: [ring[0] * major + normal[0] * minor, ring[1] * major + normal[1] * minor, normal[2] * minor],
    normal,
    distance: Math.abs(tube - minor),
  };
}

function coneShape(id: string): SplitShape {
  const surface: SurfaceParams = { type: 'cone', apex: APEX, axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: ALPHA };
  const ruling =
    (phi: number) =>
    (count: number): Vec3[] =>
      Array.from({ length: count }, (_, k): Vec3 => {
        const rho = 6 + (38 * k) / (count - 1);
        return [rho * Math.sin(ALPHA) * Math.cos(phi), rho * Math.sin(ALPHA) * Math.sin(phi), 40 - rho * Math.cos(ALPHA)];
      });
  return {
    id,
    volume: (Math.PI * 400 * 40) / 3,
    faces: [
      { surface, contains: (p) => Math.cos(Math.atan2(p[1], p[0])) >= -1e-9, sample: [10, 0, 20] },
      { surface, contains: (p) => Math.cos(Math.atan2(p[1], p[0])) <= 1e-9, sample: [-10, 0, 20] },
    ],
    edges: [
      { faces: [0, 1], points: ruling(Math.PI / 2) },
      { faces: [0, 1], points: ruling(-Math.PI / 2) },
    ],
  };
}

function sphereShape(id: string, radius: number): SplitShape {
  const surface: SurfaceParams = { type: 'sphere', center: [0, 0, 0], radius };
  return {
    id,
    volume: (4 / 3) * Math.PI * radius ** 3,
    faces: [
      { surface, contains: (p) => p[0] >= -1e-9, sample: [radius, 0, 0] },
      { surface, contains: (p) => p[0] <= 1e-9, sample: [-radius, 0, 0] },
    ],
    edges: [
      {
        faces: [0, 1],
        points: (count) =>
          Array.from(
            { length: count },
            (_, k): Vec3 => [0, radius * Math.cos((2 * Math.PI * k) / (count - 1)), radius * Math.sin((2 * Math.PI * k) / (count - 1))],
          ),
      },
    ],
  };
}

const CUTS = [0.5, Math.PI + 0.5] as const;

function torusShape(id: string, major: number, minor: number, options: FakeSplitOptions): SplitShape {
  const surface: SurfaceParams = { type: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major, minor };
  const inFirst = (p: Vec3, tolerance = 0): boolean => {
    const a = azimuth(p);
    const slack = 1e-9 + tolerance / Math.max(1e-9, Math.hypot(p[0], p[1]));
    return a >= CUTS[0] - slack && a <= CUTS[1] + slack;
  };
  const meridian =
    (u: number) =>
    (count: number): Vec3[] =>
      Array.from({ length: count }, (_, k): Vec3 => {
        const v = (2 * Math.PI * k) / (count - 1);
        const noise = options.closedNoise === true && k === count - 1 ? 5e-9 : 0;
        return [(major + minor * Math.cos(v)) * Math.cos(u), (major + minor * Math.cos(v)) * Math.sin(u), minor * Math.sin(v) + noise];
      });
  return {
    id,
    volume: 2 * Math.PI ** 2 * major * minor * minor,
    faces: [
      {
        surface,
        contains: (p, tolerance = 0) =>
          inFirst(p, tolerance) &&
          (options.trim === undefined || Math.abs(Math.atan2(p[2], Math.hypot(p[0], p[1]) - major)) <= options.trim + tolerance / minor),
        sample: [(major + minor) * Math.cos(1.5), (major + minor) * Math.sin(1.5), 0],
      },
      {
        surface,
        contains: (p, tolerance = 0) => {
          const a = azimuth(p);
          const slack = 1e-9 + tolerance / Math.max(1e-9, Math.hypot(p[0], p[1]));
          return !(a > CUTS[0] + slack && a < CUTS[1] - slack);
        },
        sample: [(major + minor) * Math.cos(4.5), (major + minor) * Math.sin(4.5), 0],
      },
    ],
    edges: [
      { faces: [0, 1], points: meridian(CUTS[0]) },
      { faces: [0, 1], points: meridian(CUTS[1]) },
    ],
  };
}

/**
 * Two plane faces meeting along the y axis at (x, z) = (0, 0): face 0 is z = 0 with outward normal +z, face 1 has the normal (cos theta, 0, sin theta) (theta = 0: the plane x = 0), both 40 long in y.
 * Convex: the faces run to -x and along the tangent (sin theta, 0, -cos theta) (a box corner); concave: to +x and to the opposite tangent (the inside corner of an L).
 */
function cornerShape(id: string, convexity: 'convex' | 'concave' | 'unknown', theta: number): SplitShape {
  const nB: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];
  const reverse = convexity === 'concave' ? -1 : 1;
  const tA: Vec3 = [-reverse, 0, 0];
  const tB: Vec3 = [reverse * Math.sin(theta), 0, -reverse * Math.cos(theta)];
  const along = (p: Vec3, t: Vec3): number => p[0] * t[0] + p[1] * t[1] + p[2] * t[2];
  const planeA: SurfaceParams = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
  const planeB: SurfaceParams = { type: 'plane', origin: [0, 0, 0], normal: nB, xDir: [0, 1, 0] };
  return {
    id,
    volume: 1e5,
    faces: [
      {
        surface: planeA,
        contains: (p, tol = 0) => Math.abs(p[2]) <= 1e-6 + tol && along(p, tA) >= -tol && Math.abs(p[1]) <= 20 + tol,
        sample: scaleVec(tA, 5),
      },
      {
        surface: planeB,
        contains: (p, tol = 0) => Math.abs(along(p, nB)) <= 1e-6 + tol && along(p, tB) >= -tol && Math.abs(p[1]) <= 20 + tol,
        sample: scaleVec(tB, 5),
      },
    ],
    edges: [
      { faces: [0, 1], convexity, points: (count) => Array.from({ length: count }, (_, k): Vec3 => [0, -20 + (40 * k) / (count - 1), 0]) },
    ],
  };
}

const scaleVec = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

function projectPlane(surface: Extract<SurfaceParams, { type: 'plane' }>, p: Vec3): { point: Vec3; normal: Vec3; distance: number } {
  const n = surface.normal;
  const d = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
  return { point: [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]], normal: n, distance: Math.abs(d) };
}

const project = (surface: SurfaceParams, p: Vec3): { point: Vec3; normal: Vec3; distance: number } =>
  surface.type === 'plane'
    ? projectPlane(surface, p)
    : surface.type === 'cone'
      ? projectCone(p)
      : surface.type === 'sphere'
        ? projectSphere(p, surface.radius)
        : projectTorus(p, (surface as { major: number }).major, (surface as { minor: number }).minor);

export interface FakeSplitOptions {
  /** `faceContains` answers true everywhere for this face (the kernel cannot tell which side of an edge it lies on). */
  readonly blindFace?: number;
  /** The second ruling of the cone runs through the apex (its points have no chart coordinates). */
  readonly apexEdge?: boolean;
  /** The torus half 0 is trimmed to |v| <= trim (the tube angle from the outer equator): a boundary that is not a join. */
  readonly trim?: number;
  /** The last sample of a closed edge differs from its first by 5e-9 (a kernel's rounding), which decides which of the two is the nearer to a point. */
  readonly closedNoise?: boolean;
  /** `add_box` is a pair of plane faces meeting in a sharp edge of this kind (face 1 turned by `theta` radians from the plane x = 0). */
  readonly corner?: { readonly convexity: 'convex' | 'concave' | 'unknown'; readonly theta?: number };
}

export function fakeSplitKernel(options: FakeSplitOptions = {}): GeometryKernel {
  const projectOn = (shape: SplitShape, face: number, p: Vec3): FaceProjection => {
    const f = shape.faces[face] as SplitFace;
    const hit = project(f.surface, p);
    return { point: hit.point, normal: hit.normal, uv: [Math.atan2(p[1], p[0]), 0] as Vec2, distance: hit.distance };
  };
  return kernelFromOps<SplitShape>({
    name: 'fake-split',
    solid: (entity) => {
      if (entity.kind === 'cone') {
        const shape = coneShape(entity.id);
        return options.apexEdge === true
          ? {
              ...shape,
              edges: [
                shape.edges[0] as SplitShape['edges'][number],
                { faces: [0, 1], points: (count) => Array.from({ length: count }, (): Vec3 => [0, 0, 40]) },
              ],
            }
          : shape;
      }
      if (entity.kind === 'sphere') return sphereShape(entity.id, entity.radius);
      if (entity.kind === 'torus') return torusShape(entity.id, entity.ringRadius, entity.tubeRadius, options);
      if (entity.kind === 'box' && options.corner !== undefined)
        return cornerShape(entity.id, options.corner.convexity, options.corner.theta ?? 0);
      if (entity.kind === 'extrusion') {
        const profile = entity.profile;
        const shoelace =
          profile.reduce(
            (sum, p, k) =>
              sum +
              p[0] * (profile[(k + 1) % profile.length] as readonly [number, number])[1] -
              (profile[(k + 1) % profile.length] as readonly [number, number])[0] * p[1],
            0,
          ) / 2;
        return { id: entity.id, volume: Math.abs(shoelace) * entity.depth, faces: [], edges: [] };
      }
      return null;
    },
    boolean: (op, a, b) => (op === 'intersect' ? null : { ...a, volume: op === 'union' ? a.volume + b.volume : a.volume - b.volume }),
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    tessellate: () => TETRA,
    topology: (shape) => ({
      solids: 1,
      vertices: 0,
      volume: shape.volume,
      edges: [],
      faces: shape.faces.map((face, index) => ({
        index,
        name: `${shape.id}:f${index}`,
        surface: face.surface.type === 'other' ? 'other' : face.surface.type,
        area: 100,
      })),
    }),
    exportStep: () => null,
    release: () => undefined,
    emboss: (source, params) => {
      const closed = embossClosedForm(params);
      return closed === null ? null : { ...source, volume: source.volume + closed.delta };
    },
    massProperties: (shape) => ({
      volume: shape.volume,
      area: 1,
      centroid: [0, 0, 0],
      inertiaAtCentroid: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 } as never,
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    }),
    faceQuery: {
      faceDetails: (shape) =>
        shape.faces.map((face, index) => ({
          index,
          surface: face.surface.type === 'other' ? 'other' : face.surface.type,
          area: 100,
          centroid: face.sample,
          samples: [face.sample],
        })),
      faceContains: (shape, face, point, tolerance) =>
        options.blindFace === face || (shape.faces[face] as SplitFace).contains(point, tolerance ?? 0),
      faceGraph: (shape) =>
        ({
          faces: shape.faces.map((face, index) => ({
            index,
            surface: face.surface,
            reversed: false,
            area: 100,
            loops: [],
            uvBounds: [0, 1, 0, 1],
          })),
          edgeFaces: shape.edges.map((edge) => [...edge.faces]),
          edgeConvexity: shape.edges.map((edge) => edge.convexity ?? ('smooth' as const)),
        }) as unknown as FaceGraph,
      faceGeometry: (shape, face) => ({
        surface: (shape.faces[face] as SplitFace).surface,
        uvBounds: [
          [-Math.PI, 0],
          [Math.PI, 50],
        ],
      }),
      projectOnFace: (shape, face, points) => points.map((point) => projectOn(shape, face, point)),
      evaluateFace: () => null,
      tessellateFace: () => null,
      faceSamples: () => null,
      edgeSamples: (shape, edge, count) =>
        (shape.edges[edge]?.points(count) ?? []).map((point, k) => ({
          t: k / (count - 1),
          s: k / (count - 1),
          point,
          tangent: [0, 0, 1] as Vec3,
          curvature: 0,
          dCurvatureDs: 0,
          torsion: 0,
          normal: [1, 0, 0] as Vec3,
        })),
      edgeContinuity: () => null,
      distance: (shape, points) =>
        points.map((point) => {
          const hits = shape.faces.map((face, index) => {
            const hit = project(face.surface, point);
            return { index, distance: face.contains(hit.point) ? hit.distance : Infinity };
          });
          const best = hits.reduce((a, b) => (b.distance < a.distance ? b : a));
          return { distance: best.distance, signed: best.distance, face: best.index };
        }),
      bspline: () => null,
      projectCurves: () => null,
    },
  });
}
