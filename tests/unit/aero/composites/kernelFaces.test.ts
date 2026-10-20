import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort, SurfaceParams } from '@core/geometry/kernelPorts';
import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import { polygonArea } from '@lib/polygon';
import { apply, ok } from '../../../helpers/commandAssertions';
import { ROSETTE, withMaterials } from './fixtures';

interface Stub {
  surface: SurfaceParams | null;
  uv?: readonly [Vec2, Vec2];
  distance?: { distance: number; face: number } | null;
  normal?: Vec3;
  ends?: readonly Vec3[] | null;
  cone?: (uv: Vec2) => Vec3;
  noPort?: boolean;
  noShape?: boolean;
}

function kernelWith(stub: Stub): GeometryKernel {
  const nothing = (): null => null;
  const faceQuery = {
    faceDetails: (): readonly FaceDetail[] => [
      {
        index: 3,
        surface: 'plane',
        area: 1,
        centroid: [0, 0, 0],
        samples: [],
        ...(stub.normal === undefined ? {} : { normal: stub.normal }),
      },
    ],
    faceContains: nothing,
    faceGraph: nothing,
    faceGeometry: () =>
      stub.surface === null
        ? null
        : {
            surface: stub.surface,
            uvBounds: stub.uv ?? [
              [0, 0],
              [1, 1],
            ],
          },
    projectOnFace: nothing,
    evaluateFace: (_shape: unknown, _face: unknown, uv: readonly Vec2[]) =>
      stub.cone !== undefined
        ? uv.map((p) => ({ point: (stub.cone as (uv: Vec2) => Vec3)(p), normal: [0, 0, 1] as Vec3 }))
        : stub.ends === null || stub.ends === undefined
          ? null
          : [...stub.ends, stub.ends[1] as Vec3].map((point) => ({ point, normal: [0, 0, 1] as Vec3 })),
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: () =>
      stub.distance === null ? null : [{ distance: stub.distance?.distance ?? 0, signed: 0, face: stub.distance?.face ?? 3 }],
    bspline: nothing,
  } as unknown as FaceQueryPort;
  return {
    supports: () => true,
    evaluate: () => (stub.noShape === true ? null : ({} as ShapeHandle)),
    tessellate: () => null,
    topology: () => null,
    exportStep: () => null,
    ...(stub.noPort === true ? {} : { faceQuery }),
  };
}

const ctx = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });

function setup(): { doc: CadDocument; solid: string } {
  const base = apply(withMaterials(), 'define_rosette', ROSETTE);
  const sphere = ok(base, 'add_torus', { ringRadius: 10, tubeRadius: 3 });
  return { doc: sphere.document, solid: sphere.affected[0] as string };
}

function part(stub: Stub, near: Vec3 = [0, 0, 10]): ReturnType<typeof execute> {
  const { doc, solid } = setup();
  return execute(
    doc,
    'create_composite_part',
    { name: 'K', rosette: 'R0', toolSurface: { entityId: solid, faceNear: near } },
    ctx(kernelWith(stub)),
  );
}

describe('create_composite_part on kernel faces (OCC face-query port)', () => {
  it('uses the face frame of a plane face and records the face index', () => {
    const result = part({
      surface: { type: 'plane', origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      uv: [
        [-5, -3],
        [5, 3],
      ],
      normal: [0, 0, 1],
    });
    expect(result.rejected).toBeUndefined();
    const created = result.document.composites?.parts[result.affected[0] as string];
    expect(created?.toolFaces[0]?.faceIndex).toBe(3);
    expect(created?.outline).toEqual([
      [-5, -3],
      [5, -3],
      [5, 3],
      [-5, 3],
    ]);
  });

  it('flips a plane whose outward normal opposes the surface normal', () => {
    const result = part({
      surface: { type: 'plane', origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      uv: [
        [0, 0],
        [4, 2],
      ],
      normal: [0, 0, -1],
    });
    const created = result.document.composites?.parts[result.affected[0] as string];
    expect(created?.surface.type === 'plane' ? created.surface.normal.map((c) => c + 0) : null).toEqual([0, 0, -1]);
    expect(polygonArea(created?.outline ?? [])).toBeCloseTo(8, 9);
  });

  it('develops a cylinder face from its parameter box', () => {
    const result = part({
      surface: { type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0], radius: 50 },
      uv: [
        [0, 20],
        [2 * Math.PI, 220],
      ],
    });
    const created = result.document.composites?.parts[result.affected[0] as string];
    expect(created?.surface.type).toBe('cylinder');
    expect(polygonArea(created?.outline ?? [])).toBeCloseTo(2 * Math.PI * 50 * 200, 6);
    expect(created?.surface.type === 'cylinder' ? created.surface.origin : null).toEqual([0, 0, 20]);
  });

  it('develops the frustum of VC-CMP-15: sector 113.842 degrees, area pi (r1 + r2) s', () => {
    const apexHeight = 300;
    const semiAngle = Math.atan2(100, apexHeight);
    const slantAt = (radius: number): number => Math.hypot(radius, (radius / 100) * apexHeight);
    const point = (rho: number): Vec3 => [rho * Math.sin(semiAngle), 0, apexHeight - rho * Math.cos(semiAngle)];
    const result = part({
      surface: { type: 'cone', apex: [0, 0, apexHeight], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle },
      uv: [
        [0, 0],
        [2 * Math.PI, 1],
      ],
      ends: [point(slantAt(50)), point(slantAt(100))],
    });
    const created = result.document.composites?.parts[result.affected[0] as string];
    expect(created?.surface.type).toBe('cone');
    const area = polygonArea(created?.outline ?? []);
    expect(Math.abs(area / 74509.412 - 1)).toBeLessThan(2e-3);
    const outline = created?.outline ?? [];
    const sector = Math.max(...outline.map((p) => (Math.atan2(p[1], p[0]) * 180) / Math.PI));
    expect(sector).toBeCloseTo(113.841996, 4);
    expect(Math.min(...outline.map((p) => Math.hypot(p[0], p[1])))).toBeCloseTo(158.113883, 5);
    expect(Math.max(...outline.map((p) => Math.hypot(p[0], p[1])))).toBeCloseTo(316.227766, 5);
  });

  it('refuses what the kernel cannot answer', () => {
    const plane: SurfaceParams = { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
    const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
    expect(code(part({ surface: plane, noPort: true }))).toBe('CMP_FACE_UNSUPPORTED');
    expect(code(part({ surface: plane, noShape: true }))).toBe('CMP_FACE_UNSUPPORTED');
    expect(code(part({ surface: plane, distance: null }))).toBe('CMP_FACE_NOT_FOUND');
    expect(code(part({ surface: plane, distance: { distance: 50, face: 1 } }))).toBe('CMP_FACE_NOT_FOUND');
    expect(code(part({ surface: null }))).toBe('CMP_FACE_UNSUPPORTED');
    expect(code(part({ surface: { type: 'sphere', center: [0, 0, 0], radius: 10 } }))).toBe('CMP_FACE_UNSUPPORTED');
    expect(code(part({ surface: { type: 'cone', apex: [0, 0, 5], axis: [0, 0, -1], xDir: [1, 0, 0], semiAngle: 0.5 }, ends: null }))).toBe(
      'CMP_FACE_UNSUPPORTED',
    );
    const { doc, solid } = setup();
    const noKernel = execute(
      doc,
      'create_composite_part',
      { name: 'K', rosette: 'R0', toolSurface: { entityId: solid, faceNear: [0, 0, 10] } },
      ctx(null),
    );
    expect(code(noKernel)).toBe('CMP_FACE_UNSUPPORTED');
  });
});
