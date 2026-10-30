/**
 * 03 WRP M5: the closed-form silhouettes of `silhouette.ts` against a stub exact-face port (the native kernel runs the same code in server/tests/nativeSilhouette.test.ts): a cylinder
 * seen side-on gives two generatrices of the cylinder's height, a cone two through its apex, a sphere a great circle; faces parallel to the direction are edge-on, a silhouette on
 * the seam is already an edge, torus and sphere patches are refused by name.
 */

import { describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '@core/model/vectors';
import type { FaceQueryPort, SurfaceParams } from '@core/geometry/kernelPorts';
import type { SolidSession } from '@core/commands/wrap/faceSession';
import { silhouettes } from '@core/commands/wrap/silhouette';

interface Geometry {
  readonly surface: SurfaceParams;
  readonly uvBounds: readonly [Vec2, Vec2];
}

const [X, Y, Z]: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** (point, outward normal) of (u, v) on the stub surfaces, in the OCC conventions the command relies on. */
function evaluate(surface: SurfaceParams, [u, v]: Vec2): { point: Vec3; normal: Vec3 } {
  if (surface.type === 'cylinder') {
    const radial = add(mul(X, Math.cos(u)), mul(Y, Math.sin(u)));
    return { point: add(add(surface.origin, mul(radial, surface.radius)), mul(Z, v)), normal: radial };
  }
  if (surface.type === 'cone') {
    const radial = add(mul(X, Math.cos(u)), mul(Y, Math.sin(u)));
    const generator = add(mul(Z, Math.cos(surface.semiAngle)), mul(radial, Math.sin(surface.semiAngle)));
    const normal = add(mul(radial, Math.cos(surface.semiAngle)), mul(Z, -Math.sin(surface.semiAngle)));
    return { point: add(surface.apex, mul(generator, v)), normal };
  }
  if (surface.type === 'sphere') {
    const normal: Vec3 = [Math.cos(v) * Math.cos(u), Math.cos(v) * Math.sin(u), Math.sin(v)];
    return { point: add(surface.center, mul(normal, surface.radius)), normal };
  }
  return { point: [0, 0, 0], normal: Z };
}

function session(
  faces: readonly Geometry[],
  options: { onlyAzimuth?: [number, number]; patch?: boolean; maxZ?: number } = {},
): SolidSession {
  const query = {
    faceGeometry: (_shape: unknown, face: number) => faces[face] ?? null,
    evaluateFace: (_shape: unknown, face: number, uv: readonly Vec2[]) => uv.map((p) => evaluate((faces[face] as Geometry).surface, p)),
    faceContains: (_shape: unknown, face: number, point: Vec3) => {
      const surface = (faces[face] as Geometry).surface;
      if (surface.type === 'sphere') return options.patch !== true || point[2] >= 0;
      if (options.maxZ !== undefined && point[2] > options.maxZ) return false;
      const azimuth = (((Math.atan2(point[1], point[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) as number;
      const [low, high] = options.onlyAzimuth ?? [0, 2 * Math.PI];
      return azimuth >= low - 1e-9 && azimuth <= high + 1e-9;
    },
    projectOnFace: (_shape: unknown, face: number, points: readonly Vec3[]) =>
      points.map((point) => ({ point, normal: Z, uv: [Math.atan2(point[1], point[0]), point[2]] as Vec2, distance: 0, face })),
  } as unknown as FaceQueryPort;
  return { query, shape: {}, diagonal: 80, topology: { faces: faces.map((_, index) => ({ index, area: 1 })) } } as unknown as SolidSession;
}

const cylinder: Geometry = {
  surface: { type: 'cylinder', origin: [0, 0, -20], axis: Z, xDir: X, radius: 20 },
  uvBounds: [
    [0, 0],
    [2 * Math.PI, 40],
  ],
};
const lengthOf = (curve: { poles: readonly Vec3[] }): number => {
  const [a, b] = [curve.poles[0] as Vec3, curve.poles[curve.poles.length - 1] as Vec3];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

describe('silhouettes', () => {
  it('a cylinder r 20 h 40 seen along x: two generatrices at y = +-20 of length 40, strictly inside the face', () => {
    const found = silhouettes(session([cylinder]), [3, 0, 0]);
    expect(found.curves).toHaveLength(2);
    expect(found.curves.map((c) => c.kind)).toEqual(['line', 'line']);
    for (const curve of found.curves) {
      expect(curve.length).toBeCloseTo(40, 9);
      expect(lengthOf(curve.curve)).toBeCloseTo(40, 9);
      expect(Math.abs((curve.curve.poles[0] as Vec3)[1])).toBeCloseTo(20, 9);
      expect(curve.pcurve.poles).toHaveLength(2);
    }
    expect(found.onEdge).toEqual([]);
  });

  it('seen along the axis the lateral face is edge-on; a plane parallel to the direction is edge-on and one facing it has none', () => {
    const plane = (normal: Vec3): Geometry => ({
      surface: { type: 'plane', origin: [0, 0, 0], normal, xDir: X },
      uvBounds: [
        [0, 0],
        [1, 1],
      ],
    });
    const found = silhouettes(session([cylinder, plane(X), plane(Z)]), [0, 0, 1]);
    expect(found.curves).toEqual([]);
    expect(found.edgeOn).toEqual([0, 1]);
  });

  it('a silhouette on the seam of the azimuth range is already an edge (seen along y: the line at azimuth 0 is the seam)', () => {
    const found = silhouettes(session([cylinder]), [0, 1, 0]);
    expect(found.curves).toHaveLength(1);
    expect(found.onEdge).toEqual([0]);
  });

  it('a silhouette on one side of a patch that is not inside the face is dropped, and one on its boundary is an edge', () => {
    const half = session([cylinder], { onlyAzimuth: [0, Math.PI] });
    const found = silhouettes(half, [1, 0, 0]);
    expect(found.curves).toHaveLength(1);
    expect((found.curves[0]?.curve.poles[0] as Vec3)[1]).toBeCloseTo(20, 9);
  });

  it('a line on the boundary of the face (inside by the kernel test, the probes beside it outside) is an edge even when the u bounds do not say so', () => {
    const found = silhouettes(session([cylinder], { onlyAzimuth: [0, Math.PI / 2] }), [1, 0, 0]);
    expect(found.curves).toEqual([]);
    expect(found.onEdge).toEqual([0]);
  });

  it('a generatrix is cut short where the face ends (a tilted top: the line is clipped at z = 10), and its pcurve azimuth lies in the face u range', () => {
    const found = silhouettes(session([cylinder], { maxZ: 10 }), [1, 0, 0]);
    expect(found.curves).toHaveLength(2);
    for (const curve of found.curves) {
      const [a, b] = [curve.curve.poles[0] as Vec3, curve.curve.poles[1] as Vec3];
      expect(Math.max(a[2], b[2])).toBeCloseTo(10, 6);
      expect(Math.min(a[2], b[2])).toBeCloseTo(-20, 9);
      expect(curve.length).toBeCloseTo(30, 6);
      for (const [u] of curve.pcurve.poles) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThan(2 * Math.PI);
      }
    }
    expect(found.curves.map((c) => (c.pcurve.poles[0] as Vec2)[0].toFixed(6))).toEqual([
      (Math.PI / 2).toFixed(6),
      ((3 * Math.PI) / 2).toFixed(6),
    ]);
  });

  it('a great circle through the poles (seen along x or y with the sphere axis z) is refused with the reason; its pcurve for an oblique direction is continuous in the u range', () => {
    const sphere: Geometry = {
      surface: { type: 'sphere', center: [0, 0, 0], radius: 25 },
      uvBounds: [
        [0, -Math.PI / 2],
        [2 * Math.PI, Math.PI / 2],
      ],
    };
    for (const direction of [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ] as Vec3[]) {
      const found = silhouettes(session([sphere]), direction);
      expect(found.curves).toEqual([]);
      expect(found.unsupported[0]?.reason).toContain('passes through the poles');
    }
    const oblique = silhouettes(session([sphere]), [1, 2, 2]);
    expect(oblique.curves).toHaveLength(1);
    const us = (oblique.curves[0]?.pcurve.poles ?? []).map((p) => p[0]);
    expect(us[0]).toBeGreaterThanOrEqual(0);
    expect(us[0]).toBeLessThan(2 * Math.PI);
    for (let k = 1; k < us.length; k++) expect(Math.abs((us[k] as number) - (us[k - 1] as number))).toBeLessThan(Math.PI);
  });

  it('a cone seen along x: two generatrices through the apex (slant length minus the face start), seen along its axis none', () => {
    const slant = Math.hypot(20, 40);
    const cone: Geometry = {
      surface: { type: 'cone', apex: [0, 0, 0], axis: Z, xDir: X, semiAngle: Math.atan2(20, 40) },
      uvBounds: [
        [0, 5],
        [2 * Math.PI, slant],
      ],
    };
    const found = silhouettes(session([cone]), [1, 0, 0]);
    expect(found.curves).toHaveLength(2);
    for (const curve of found.curves) expect(curve.length).toBeCloseTo(slant - 5, 9);
    expect(found.curves.map((c) => Math.sign((c.curve.poles[1] as Vec3)[1]))).toEqual([1, -1]);
    expect(silhouettes(session([cone]), [0, 0, 1]).curves).toEqual([]);
    expect(silhouettes(session([cone]), [0.1, 0, 1]).curves).toEqual([]);
  });

  it('a sphere gives the great circle (2 pi r), a sphere patch the circle leaves and a torus are refused by reason', () => {
    const sphere: Geometry = {
      surface: { type: 'sphere', center: [0, 0, 0], radius: 25 },
      uvBounds: [
        [0, -Math.PI / 2],
        [2 * Math.PI, Math.PI / 2],
      ],
    };
    const whole = silhouettes(session([sphere]), [0, 0, 1]);
    expect(whole.curves.map((c) => c.kind)).toEqual(['circle']);
    expect(whole.curves[0]?.length).toBeCloseTo(2 * Math.PI * 25, 9);
    expect(whole.curves[0]?.pcurve.poles.length).toBe(25);
    const patch = silhouettes(session([sphere], { patch: true }), [1, 2, 2]);
    expect(patch.curves).toEqual([]);
    expect(patch.unsupported[0]?.reason).toContain('leaves this sphere patch');
    const torus: Geometry = {
      surface: { type: 'torus', center: [0, 0, 0], axis: Z, major: 30, minor: 8 },
      uvBounds: [
        [0, 0],
        [1, 1],
      ],
    };
    expect(silhouettes(session([torus]), [0, 0, 1]).unsupported).toEqual([
      { face: 0, surface: 'torus', reason: 'only plane, cylinder, cone and sphere faces have a closed-form silhouette' },
    ]);
  });

  it('refuses a face the kernel cannot describe and an azimuth convention that disagrees with the kernel', () => {
    const missing = silhouettes(session([cylinder]), [1, 0, 0]);
    expect(missing.unsupported).toEqual([]);
    const none = { ...session([cylinder]), query: { ...session([cylinder]).query, faceGeometry: () => null } } as SolidSession;
    expect(silhouettes(none, [1, 0, 0]).unsupported[0]?.reason).toContain('no exact geometry');
    const flipped: Geometry = { ...cylinder, surface: { ...(cylinder.surface as object), xDir: Y } as SurfaceParams };
    const mismatch = silhouettes(session([flipped]), [1, 0, 0]);
    expect(mismatch.unsupported[0]?.reason).toContain('azimuth convention');
  });
});
