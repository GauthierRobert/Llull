/**
 * A fake exact kernel for the freeform (B-spline) face commands of 03 WRP (no OCCT): `add_box` becomes a solid with ONE freeform face, the B-spline `patch`, in its own
 * (u, v) in [0, 1]^2. The recipe evaluator is the real one; booleans, `faceOp` offset and extrusions only track volumes (union adds, subtract subtracts, intersect takes the
 * smaller, an offset adds area x distance), enough to run the commands end to end. The exact geometry is proved on the native kernel in server/tests/nativeWrapFreeform.test.ts.
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { buildFreeformChart, surfaceOfPort } from '@core/geometry/freeformChart';
import type { FaceProjection } from '@core/geometry/kernelPorts';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { evaluateSurface } from '@core/lib/nurbs/surface';
import type { Vec3 } from '@core/model/types';
import { TETRA } from './fakeKernel';
import type { PortSurface } from './freeformSurfaces';

interface FreeformShape {
  readonly id: string;
  readonly volume: number;
}

export interface FakeFreeformOptions {
  /** `bspline` answers null. */
  readonly noBspline?: boolean;
  /** The face's own (u, v) differ from the B-spline's (u reversed). */
  readonly foreignParameters?: boolean;
  /** `faceContains` answers false everywhere. */
  readonly containsNothing?: boolean;
  /** Boolean operations refuse. */
  readonly refuseBoolean?: boolean;
  /** Reports the result as not a valid closed solid. */
  readonly invalidResult?: boolean;
  /** The solid lies on the Su x Sv side of the face (a bore): the outward normal of the solid is -(Su x Sv), and `bspline` says `reversed`. */
  readonly reversed?: boolean;
  /** Material thickness below the face, along the inward normal (default 10): the point deeper than this is outside the solid. */
  readonly thickness?: number;
  /** The face is trimmed: `faceContains` answers true only where this holds (and the point is on the surface). */
  readonly trim?: (point: Vec3) => boolean;
  /** Area of the freeform face (the fake does not integrate it). */
  readonly area?: number;
}

export function fakeFreeformKernel(patch: PortSurface, options: FakeFreeformOptions = {}): GeometryKernel {
  const surface = surfaceOfPort(patch);
  const area = options.area ?? 1000;
  const chart = (() => {
    const built = buildFreeformChart(
      patch,
      [0.5, 0.5],
      { anchorChart: [0, 0], anchorOn: evaluateSurface(surface, 0.5, 0.5), angleDeg: 0, mirror: false },
      'parametric',
    );
    if ('error' in built) throw new Error(built.error);
    return built;
  })();
  const flip = options.reversed === true ? -1 : 1;
  const outward = (n: Vec3): Vec3 => [flip * n[0], flip * n[1], flip * n[2]];
  const own = (u: number): number => (options.foreignParameters === true ? 1 - u : u);
  return kernelFromOps<FreeformShape>({
    name: 'fake-freeform',
    solid: (entity) => {
      if (entity.kind === 'box') return { id: entity.id, volume: 10_000 };
      if (entity.kind !== 'extrusion') return null;
      const profile = entity.profile;
      const profileArea =
        Math.abs(
          profile.reduce((sum, p, k) => {
            const next = profile[(k + 1) % profile.length] as readonly [number, number];
            return sum + p[0] * next[1] - next[0] * p[1];
          }, 0),
        ) / 2;
      return { id: entity.id, volume: profileArea * entity.depth };
    },
    boolean: (op, a, b) =>
      options.refuseBoolean === true
        ? null
        : {
            id: `${a.id}.${op}`,
            volume: op === 'union' ? a.volume + b.volume : op === 'subtract' ? a.volume - b.volume : Math.min(a.volume, b.volume),
          },
    faceOp: (source, params) =>
      params.kind === 'moveFaces' && params.move.type === 'offset'
        ? { id: `${source.id}.offset`, volume: source.volume + area * params.move.distance }
        : null,
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
      faces: [{ index: 0, name: `${shape.id}:patch`, surface: 'other', area }],
    }),
    exportStep: () => null,
    release: () => undefined,
    massProperties: (shape) => ({
      volume: shape.volume,
      area,
      centroid: [0, 0, 0],
      inertiaAtCentroid: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 } as never,
      bounds: { min: [-30, -30, -30], max: [30, 30, 30] },
    }),
    analyze: (shape) => ({
      valid: options.invalidResult !== true,
      status: options.invalidResult === true ? 'fake invalid' : 'ok',
      closed: options.invalidResult !== true,
      volume: shape.volume,
      area,
      freeFaces: 0,
      lumps: [],
    }),
    faceQuery: {
      faceDetails: () => [
        { index: 0, surface: 'other', area, centroid: evaluateSurface(surface, 0.5, 0.5), samples: [evaluateSurface(surface, 0.5, 0.5)] },
      ],
      faceContains: (_shape, _face, point) => {
        if (options.containsNothing === true) return false;
        if (options.trim !== undefined && !options.trim(point)) return false;
        const uv = chart.uvOfPoint(point);
        const at = chart.pointAt(uv);
        return Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]) < 1e-4;
      },
      faceGraph: () => null,
      faceGeometry: () => ({
        surface: { type: 'other', kind: 'bspline' },
        uvBounds: [
          [0, 0],
          [1, 1],
        ],
      }),
      projectOnFace: (_shape, _face, points) =>
        points.map((point): FaceProjection => {
          const uv = chart.uvOfPoint(point);
          const at = chart.pointAt(uv);
          return {
            point: at,
            normal: outward(chart.normalAt(uv)),
            uv: [own(uv[0]), uv[1]],
            distance: Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]),
          };
        }),
      evaluateFace: (_shape, _face, uv) => uv.map(([u, v]) => ({ point: chart.pointAt([u, v]), normal: outward(chart.normalAt([u, v])) })),
      tessellateFace: () => null,
      faceSamples: () => null,
      edgeSamples: () => null,
      edgeContinuity: () => null,
      distance: (_shape, points) =>
        points.map((point) => {
          const at = chart.pointAt(chart.uvOfPoint(point));
          const distance = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
          const n = outward(chart.normalAt(chart.uvOfPoint(point)));
          const above = (point[0] - at[0]) * n[0] + (point[1] - at[1]) * n[1] + (point[2] - at[2]) * n[2];
          const inside = above < 0 && distance <= (options.thickness ?? 10);
          return { distance, signed: inside ? -distance : distance, face: 0 };
        }),
      bspline: () => (options.noBspline === true ? null : options.reversed === true ? { ...patch, reversed: true } : patch),
      projectCurves: () => null,
    },
  });
}
