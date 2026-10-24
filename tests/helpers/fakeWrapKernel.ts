/**
 * A fake exact kernel for the 03 WRP command tests (no OCCT): the real recipe evaluator over analytic cylinder / cone / box / sphere solids with the face-query
 * port, an `emboss` op whose volume is the closed form, and a canned `projectCurves`. It exercises the commands' own logic (face picks, charts, checks,
 * recipes, data); the exact geometry is proved on the native kernel in server/tests/nativeWrap*.test.ts.
 */

import type { GeometryKernel, ShapeFace, ShapeTopology } from '@core/geometry/kernel';
import type { CurveProjection, CurveProjectionRequest, FaceProjection, SurfaceParams } from '@core/geometry/kernelPorts';
import { embossClosedForm } from '@core/geometry/embossVolume';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { Entity, MeshData, Vec2, Vec3 } from '@core/model/types';
import type { EmbossParams } from '@core/model/wrap';
import { TETRA } from './fakeKernel';

interface FakeFace {
  readonly name: string;
  readonly surface: SurfaceParams;
  readonly area: number;
  /** A point on the face. */
  readonly sample: Vec3;
  readonly contains: (point: Vec3) => boolean;
}

interface FakeShape {
  readonly id: string;
  readonly volume: number;
  readonly faces: readonly FakeFace[];
}

export interface FakeWrapOptions {
  /** Points the kernel claims lie off the face (WRP_OUTSIDE_FACE tests). */
  readonly outside?: (point: Vec3) => boolean;
  /** Make `emboss` refuse (WRP_KERNEL_BUILD_FAILED). */
  readonly refuseEmboss?: boolean;
  /** Drop the face queries entirely (a Manifold-like kernel). */
  readonly noFaceQuery?: boolean;
  /** Make `projectCurves` answer null. */
  readonly noProjection?: boolean;
  /** `distance` answers face -1 (a point on an edge or a seam). */
  readonly edgePick?: boolean;
  /** `faceContains` answers false everywhere (the edge pick finds no face). */
  readonly containsNothing?: boolean;
  /** `evaluateFace` answers null. */
  readonly noEvaluate?: boolean;
  /** `faceGeometry` reports non-finite parameter bounds. */
  readonly infiniteBounds?: boolean;
  /** `faceGeometry` answers null. */
  readonly noGeometry?: boolean;
  /** `projectOnFace` answers null. */
  readonly noProjectOnFace?: boolean;
  /** No exact mass properties (the volume change is not measured). */
  readonly noMass?: boolean;
  /** Make `boolean` refuse (a kernel that cannot cut the grooves of a knurl). */
  readonly refuseBoolean?: boolean;
  /** Multiply the emboss volume change (an internal-consistency failure for check_wrap). */
  readonly embossSkew?: number;
  /** Multiply the volume a subtract removes (a tool that reaches beyond the face). */
  readonly subtractSkew?: number;
  /** A split that duplicates the face instead of dividing it (the summed face area grows). */
  readonly splitGrowsArea?: boolean;
  /** A split that divides nothing (the result has the faces of the source). */
  readonly noSplit?: boolean;
  /** Multiply the volume of a split result (a split that moves material). */
  readonly splitVolumeSkew?: number;
  /** `analyze` reports the result as not a valid closed solid. */
  readonly invalidResult?: boolean;
  /** `distance` answers null (the kernel cannot measure against the faces). */
  readonly noDistance?: boolean;
  /** `faceGeometry` reports every face as a freeform surface. */
  readonly freeform?: boolean;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

function cylinderShape(entity: Extract<Entity, { kind: 'cylinder' }>): FakeShape {
  const [px, py, pz] = entity.position;
  const { radius, height } = entity;
  const origin: Vec3 = [px, py, pz];
  const side: FakeFace = {
    name: `${entity.id}:side`,
    surface: { type: 'cylinder', origin, axis: [0, 0, 1], xDir: [1, 0, 0], radius },
    area: 2 * Math.PI * radius * height,
    sample: [px + radius, py, pz],
    contains: (p) => Math.abs(p[2] - pz) <= height / 2 + 1e-6,
  };
  const cap = (sign: 1 | -1): FakeFace => ({
    name: `${entity.id}:${sign > 0 ? 'top' : 'bottom'}`,
    surface: { type: 'plane', origin: [px, py, pz + (sign * height) / 2], normal: [0, 0, sign], xDir: [1, 0, 0] },
    area: Math.PI * radius * radius,
    sample: [px, py, pz + (sign * height) / 2],
    contains: (p) => Math.hypot(p[0] - px, p[1] - py) <= radius + 1e-6,
  });
  return { id: entity.id, volume: Math.PI * radius * radius * height, faces: [side, cap(1), cap(-1)] };
}

function coneShape(entity: Extract<Entity, { kind: 'cone' }>): FakeShape {
  const [px, py, pz] = entity.position;
  const { radius, height } = entity;
  const slant = Math.hypot(radius, height);
  const side: FakeFace = {
    name: `${entity.id}:side`,
    surface: { type: 'cone', apex: [px, py, pz + height], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: Math.atan2(radius, height) },
    area: Math.PI * radius * slant,
    sample: [px + radius / 2, py, pz + height / 2],
    contains: (p) => p[2] >= pz - 1e-6 && p[2] <= pz + height + 1e-6,
  };
  const bottom: FakeFace = {
    name: `${entity.id}:bottom`,
    surface: { type: 'plane', origin: [px, py, pz], normal: [0, 0, -1], xDir: [1, 0, 0] },
    area: Math.PI * radius * radius,
    sample: [px, py, pz],
    contains: (p) => Math.hypot(p[0] - px, p[1] - py) <= radius + 1e-6,
  };
  return { id: entity.id, volume: (Math.PI * radius * radius * height) / 3, faces: [side, bottom] };
}

function boxShape(entity: Extract<Entity, { kind: 'box' }>): FakeShape {
  const [px, py, pz] = entity.position;
  const half: [number, number, number] = [entity.size[0] / 2, entity.size[1] / 2, entity.size[2] / 2];
  const faces: FakeFace[] = [];
  for (const axis of [0, 1, 2] as const)
    for (const sign of [1, -1] as const) {
      const normal: [number, number, number] = [0, 0, 0];
      normal[axis] = sign;
      const centre: [number, number, number] = [px, py, pz];
      centre[axis] += sign * half[axis];
      const other = [0, 1, 2].filter((k) => k !== axis);
      faces.push({
        name: `${entity.id}:${'xyz'[axis]}${sign > 0 ? '+' : '-'}`,
        surface: { type: 'plane', origin: centre, normal, xDir: axis === 0 ? [0, 1, 0] : [1, 0, 0] },
        area: half[other[0] as 0 | 1 | 2] * half[other[1] as 0 | 1 | 2] * 4,
        sample: centre,
        contains: (p) => other.every((k) => Math.abs((p[k] as number) - (centre[k] as number)) <= (half[k] as number) + 1e-6),
      });
    }
  return { id: entity.id, volume: entity.size[0] * entity.size[1] * entity.size[2], faces };
}

function sphereShape(entity: Extract<Entity, { kind: 'sphere' }>): FakeShape {
  const [px, py, pz] = entity.position;
  const face: FakeFace = {
    name: `${entity.id}:surface`,
    surface: { type: 'sphere', center: [px, py, pz], radius: entity.radius },
    area: 4 * Math.PI * entity.radius ** 2,
    sample: [px, py, pz + entity.radius],
    contains: () => true,
  };
  return { id: entity.id, volume: (4 / 3) * Math.PI * entity.radius ** 3, faces: [face] };
}

function torusShape(entity: Extract<Entity, { kind: 'torus' }>): FakeShape {
  const [px, py, pz] = entity.position;
  const { ringRadius, tubeRadius } = entity;
  const face: FakeFace = {
    name: `${entity.id}:surface`,
    surface: { type: 'torus', center: [px, py, pz], axis: [0, 0, 1], major: ringRadius, minor: tubeRadius },
    area: 4 * Math.PI * Math.PI * ringRadius * tubeRadius,
    sample: [px + ringRadius + tubeRadius, py, pz],
    contains: () => true,
  };
  return { id: entity.id, volume: 2 * Math.PI * Math.PI * ringRadius * tubeRadius * tubeRadius, faces: [face] };
}

/** Closest point of the face's surface to `p` (analytic), its outward normal and (u, v) in the surface's own frame. */
function projectOnSurface(face: FakeFace, p: Vec3): FaceProjection {
  const s = face.surface;
  if (s.type === 'plane') {
    const d = (p[0] - s.origin[0]) * s.normal[0] + (p[1] - s.origin[1]) * s.normal[1] + (p[2] - s.origin[2]) * s.normal[2];
    const point: Vec3 = [p[0] - d * s.normal[0], p[1] - d * s.normal[1], p[2] - d * s.normal[2]];
    return { point, normal: s.normal, uv: [point[0] - s.origin[0], point[1] - s.origin[1]], distance: Math.abs(d) };
  }
  if (s.type === 'cylinder') {
    const rx = p[0] - s.origin[0];
    const ry = p[1] - s.origin[1];
    const length = Math.hypot(rx, ry) || 1;
    const point: Vec3 = [s.origin[0] + (rx / length) * s.radius, s.origin[1] + (ry / length) * s.radius, p[2]];
    return {
      point,
      normal: [rx / length, ry / length, 0],
      uv: [Math.atan2(ry, rx), p[2] - s.origin[2]],
      distance: Math.abs(length - s.radius),
    };
  }
  if (s.type === 'cone') {
    const rel: Vec3 = [p[0] - s.apex[0], p[1] - s.apex[1], p[2] - s.apex[2]];
    const azimuth = Math.atan2(rel[1], rel[0]);
    const generator: Vec3 = [Math.sin(s.semiAngle) * Math.cos(azimuth), Math.sin(s.semiAngle) * Math.sin(azimuth), -Math.cos(s.semiAngle)];
    const v = Math.max(rel[0] * generator[0] + rel[1] * generator[1] + rel[2] * generator[2], 0);
    const point: Vec3 = [s.apex[0] + v * generator[0], s.apex[1] + v * generator[1], s.apex[2] + v * generator[2]];
    const normal: Vec3 = [Math.cos(s.semiAngle) * Math.cos(azimuth), Math.cos(s.semiAngle) * Math.sin(azimuth), Math.sin(s.semiAngle)];
    return { point, normal, uv: [azimuth, v], distance: Math.hypot(point[0] - p[0], point[1] - p[1], point[2] - p[2]) };
  }
  if (s.type === 'sphere') {
    const rel: Vec3 = [p[0] - s.center[0], p[1] - s.center[1], p[2] - s.center[2]];
    const length = Math.hypot(...rel) || 1;
    const normal: Vec3 = [rel[0] / length, rel[1] / length, rel[2] / length];
    return {
      point: [s.center[0] + normal[0] * s.radius, s.center[1] + normal[1] * s.radius, s.center[2] + normal[2] * s.radius],
      normal,
      uv: [Math.atan2(normal[1], normal[0]), Math.asin(Math.max(-1, Math.min(1, normal[2])))],
      distance: Math.abs(length - s.radius),
    };
  }
  if (s.type === 'torus') {
    const rel: Vec3 = [p[0] - s.center[0], p[1] - s.center[1], p[2] - s.center[2]];
    const ring = Math.hypot(rel[0], rel[1]) || 1;
    const radial: Vec3 = [rel[0] / ring, rel[1] / ring, 0];
    const tube: Vec3 = [rel[0] - radial[0] * s.major, rel[1] - radial[1] * s.major, rel[2]];
    const length = Math.hypot(...tube) || 1;
    const normal: Vec3 = [tube[0] / length, tube[1] / length, tube[2] / length];
    return {
      point: [
        s.center[0] + radial[0] * s.major + normal[0] * s.minor,
        s.center[1] + radial[1] * s.major + normal[1] * s.minor,
        s.center[2] + normal[2] * s.minor,
      ],
      normal,
      uv: [Math.atan2(rel[1], rel[0]), Math.atan2(rel[2], ring - s.major)],
      distance: Math.abs(length - s.minor),
    };
  }
  return { point: p, normal: [0, 0, 1], uv: [0, 0], distance: 0 };
}

/** A canned projection: every source curve lands on the first requested face, point for point (a degree-1 polyline) when `inside` accepts it. */
function cannedProjection(shape: FakeShape, request: CurveProjectionRequest, options: FakeWrapOptions): CurveProjection {
  const face = shape.faces[request.faces[0] as number] as FakeFace;
  const curves: CurveProjection['curves'][number][] = [];
  const coverage: number[] = [];
  request.curves.forEach((curve, source) => {
    const poles = curve.poles.map((pole) => projectOnSurface(face, pole));
    const hit = poles.filter((p) => face.contains(p.point) && options.outside?.(p.point) !== true);
    coverage.push(poles.length === 0 ? 0 : hit.length / poles.length);
    if (hit.length < 2) return;
    curves.push({
      source,
      face: request.faces[0] as number,
      t0: 0,
      t1: 1,
      curve: {
        degree: 1,
        poles: hit.map((p) => p.point),
        knots: hit.map((_, k) => k / (hit.length - 1)),
        multiplicities: hit.map((_, k) => (k === 0 || k === hit.length - 1 ? 2 : 1)),
      },
      pcurve: {
        degree: 1,
        poles: hit.map((p) => p.uv),
        knots: hit.map((_, k) => k / (hit.length - 1)),
        multiplicities: hit.map((_, k) => (k === 0 || k === hit.length - 1 ? 2 : 1)),
      },
    });
  });
  return { curves, coverage };
}

/**
 * Volume of one V-groove tool of a knurl inside its cylinder (the tool is a triangular extrusion named '<id>.g<k>' that rises half its depth above the surface and runs half
 * its depth past both ends), by midpoint quadrature: independent of the closed form the command compares against.
 */
function grooveVolume(entity: { id: string; profile: readonly (readonly [number, number])[]; depth: number }): number | null {
  if (!entity.id.includes('.g') || entity.profile.length !== 3) return null;
  const [apexPoint, left, right] = entity.profile as [readonly [number, number], readonly [number, number], readonly [number, number]];
  const apex = Math.hypot(apexPoint[0], apexPoint[1]);
  const top = Math.hypot((left[0] + right[0]) / 2, (left[1] + right[1]) / 2);
  const toothDepth = (top - apex) / 1.5;
  const radius = apex + toothDepth;
  const half = Math.hypot(left[0] - right[0], left[1] - right[1]) / 2 / (top - apex);
  const steps = 20000;
  const limit = radius;
  let area = 0;
  for (let k = 0; k < steps; k++) {
    const x = -limit + ((k + 0.5) * 2 * limit) / steps;
    area += Math.max(0, Math.sqrt(Math.max(0, radius * radius - x * x)) - (apex + Math.abs(x) / half)) * ((2 * limit) / steps);
  }
  return area * (entity.depth - toothDepth);
}

export function fakeWrapKernel(options: FakeWrapOptions = {}): GeometryKernel {
  const mesh: MeshData = TETRA;
  const topologyOf = (shape: FakeShape): ShapeTopology => ({
    solids: 1,
    vertices: 0,
    volume: shape.volume,
    edges: [],
    faces: shape.faces.map(
      (face, index): ShapeFace => ({
        index,
        name: face.name,
        surface: face.surface.type === 'other' ? 'other' : face.surface.type,
        area: face.area,
      }),
    ),
  });
  return kernelFromOps<FakeShape>({
    name: 'fake-wrap',
    solid: (entity) => {
      switch (entity.kind) {
        case 'cylinder':
          return cylinderShape(entity);
        case 'cone':
          return coneShape(entity);
        case 'box':
          return boxShape(entity);
        case 'sphere':
          return sphereShape(entity);
        case 'torus':
          return torusShape(entity);
        case 'extrusion': {
          const groove = grooveVolume(entity);
          if (groove !== null) return { id: entity.id, volume: groove, faces: [] };
          const area =
            Math.abs(
              entity.profile.reduce(
                (sum, p, k) =>
                  sum +
                  p[0] * (entity.profile[(k + 1) % entity.profile.length] as [number, number])[1] -
                  (entity.profile[(k + 1) % entity.profile.length] as [number, number])[0] * p[1],
                0,
              ),
            ) / 2;
          return { id: entity.id, volume: area * entity.depth, faces: [] };
        }
        default:
          return null;
      }
    },
    boolean: (op, a, b) =>
      options.refuseBoolean === true
        ? null
        : op === 'union'
          ? { ...a, volume: a.volume + b.volume }
          : op === 'subtract'
            ? { ...a, volume: a.volume - b.volume * (options.subtractSkew ?? 1) }
            : null,
    fillet: () => null,
    blend: () => null,
    chamfer: () => null,
    shell: () => null,
    place: (shape) => shape,
    scale: (shape) => shape,
    tessellate: () => mesh,
    topology: topologyOf,
    exportStep: () => null,
    release: () => undefined,
    ...(options.invalidResult === true
      ? {
          analyze: (shape: FakeShape) => ({
            valid: false,
            status: 'fake invalid',
            closed: false,
            volume: shape.volume,
            area: 0,
            freeFaces: 0,
            lumps: [],
          }),
        }
      : {}),
    ...(options.noMass === true
      ? {}
      : {
          massProperties: (shape: FakeShape) => ({
            volume: shape.volume,
            area: shape.faces.reduce((sum, face) => sum + face.area, 0),
            centroid: [0, 0, 0],
            inertiaAtCentroid: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 } as never,
            bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
          }),
        }),
    ...(options.refuseEmboss === true
      ? {}
      : {
          emboss: (source: FakeShape, params: EmbossParams): FakeShape | null => {
            if (params.mode === 'split') {
              if (options.noSplit === true) return source;
              const whole = source.faces[params.face] as FakeFace;
              const pieces = (params.chains ?? []).length + 1;
              const share = { ...whole, area: options.splitGrowsArea === true ? whole.area : whole.area / pieces };
              return {
                ...source,
                volume: source.volume * (options.splitVolumeSkew ?? 1),
                faces: [
                  ...source.faces.map((face, index) => (index === params.face ? share : face)),
                  ...Array.from({ length: pieces - 1 }, (_, k) => ({ ...share, name: `${source.id}:split${source.faces.length}.${k}` })),
                ],
              };
            }
            const closed = embossClosedForm(params);
            return closed === null
              ? null
              : { ...source, volume: source.volume + closed.delta * (options.embossSkew ?? 1), faces: [...source.faces] };
          },
        }),
    ...(options.noFaceQuery === true
      ? {}
      : {
          faceQuery: {
            faceDetails: (shape) =>
              shape.faces.map((face, index) => ({
                index,
                surface: face.surface.type === 'other' ? 'other' : face.surface.type,
                area: face.area,
                centroid: face.sample,
                samples: [face.sample],
                ...(face.surface.type === 'plane' ? { normal: face.surface.normal } : {}),
                ...(face.surface.type === 'cylinder'
                  ? { axis: { origin: face.surface.origin, dir: face.surface.axis }, radius: face.surface.radius }
                  : {}),
                ...(face.surface.type === 'sphere'
                  ? { axis: { origin: face.surface.center, dir: [0, 0, 1] as Vec3 }, radius: face.surface.radius }
                  : {}),
              })),
            faceContains: (shape, face, point) => {
              const target = shape.faces[face];
              return (
                options.containsNothing !== true && target !== undefined && target.contains(point) && options.outside?.(point) !== true
              );
            },
            faceGraph: () => null,
            faceGeometry: (shape, face) => {
              const target = shape.faces[face];
              if (target === undefined || options.noGeometry === true) return null;
              const uvBounds: [Vec2, Vec2] =
                target.surface.type === 'cylinder'
                  ? [
                      [0, -20],
                      [2 * Math.PI, 20],
                    ]
                  : target.surface.type === 'cone'
                    ? [
                        [0, 0],
                        [2 * Math.PI, 44.72135955],
                      ]
                    : target.surface.type === 'sphere'
                      ? [
                          [0, -Math.PI / 2],
                          [2 * Math.PI, Math.PI / 2],
                        ]
                      : target.surface.type === 'torus'
                        ? [
                            [0, 0],
                            [2 * Math.PI, 2 * Math.PI],
                          ]
                        : [
                            [-30, -30],
                            [30, 30],
                          ];
              return {
                surface: options.freeform === true ? ({ type: 'other', kind: 'bspline' } as SurfaceParams) : target.surface,
                uvBounds:
                  options.infiniteBounds === true
                    ? [
                        [Number.NEGATIVE_INFINITY, 0],
                        [Number.POSITIVE_INFINITY, 1],
                      ]
                    : uvBounds,
              };
            },
            projectOnFace: (shape, face, points) => {
              const target = shape.faces[face];
              return target === undefined || options.noProjectOnFace === true
                ? null
                : points.map((point) => projectOnSurface(target, point));
            },
            evaluateFace: (shape, face, uv) => {
              const target = shape.faces[face];
              if (target === undefined || options.noEvaluate === true) return null;
              const s = target.surface;
              if (s.type === 'cone' && uv.some(([, v]) => near(v, 44.72135955))) return null; // the apex has no normal: the native kernel answers null for the whole list
              return uv.map(([u, v]) => {
                if (s.type === 'cylinder') {
                  const point: Vec3 = [s.origin[0] + s.radius * Math.cos(u), s.origin[1] + s.radius * Math.sin(u), s.origin[2] + v];
                  return { point, normal: [Math.cos(u), Math.sin(u), 0] as Vec3 };
                }
                if (s.type === 'cone') {
                  const g: Vec3 = [Math.sin(s.semiAngle) * Math.cos(u), Math.sin(s.semiAngle) * Math.sin(u), -Math.cos(s.semiAngle)];
                  const rho = 44.72135955 - v;
                  const point: Vec3 = [s.apex[0] + rho * g[0], s.apex[1] + rho * g[1], s.apex[2] + rho * g[2]];
                  return {
                    point,
                    normal: [Math.cos(s.semiAngle) * Math.cos(u), Math.cos(s.semiAngle) * Math.sin(u), Math.sin(s.semiAngle)] as Vec3,
                  };
                }
                if (s.type === 'sphere') {
                  const point: Vec3 = [
                    s.center[0] + s.radius * Math.cos(v) * Math.cos(u),
                    s.center[1] + s.radius * Math.cos(v) * Math.sin(u),
                    s.center[2] + s.radius * Math.sin(v),
                  ];
                  return { point, normal: [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)] as Vec3 };
                }
                if (s.type === 'torus') {
                  const ring = s.major + s.minor * Math.cos(v);
                  const point: Vec3 = [
                    s.center[0] + ring * Math.cos(u),
                    s.center[1] + ring * Math.sin(u),
                    s.center[2] + s.minor * Math.sin(v),
                  ];
                  return { point, normal: [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)] as Vec3 };
                }
                const origin = s.type === 'plane' ? s.origin : ([0, 0, 0] as Vec3);
                return {
                  point: [origin[0] + u, origin[1] + v, origin[2]] as Vec3,
                  normal: (s.type === 'plane' ? s.normal : [0, 0, 1]) as Vec3,
                };
              });
            },
            tessellateFace: () => null,
            faceSamples: () => null,
            edgeSamples: () => null,
            edgeContinuity: () => null,
            distance: (shape, points) =>
              options.noDistance === true
                ? null
                : points.map((point) => {
                    const hits = shape.faces.map((face, index) => ({ index, distance: projectOnSurface(face, point).distance }));
                    const best = hits.reduce((a, b) => (b.distance < a.distance ? b : a));
                    return { distance: best.distance, signed: best.distance, face: options.edgePick === true ? -1 : best.index };
                  }),
            bspline: () => null,
            projectCurves: (shape, request) => (options.noProjection === true ? null : cannedProjection(shape, request, options)),
          },
        }),
  });
}
