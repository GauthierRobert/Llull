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
import { evaluateCurve } from '@lib/nurbs/evaluate';

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
  if (surface.type === 'torus') {
    const radial = add(mul(X, Math.cos(u)), mul(Y, Math.sin(u)));
    const normal = add(mul(radial, Math.cos(v)), mul(Z, Math.sin(v)));
    return { point: add(surface.center, add(mul(radial, surface.major), mul(normal, surface.minor))), normal };
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

  it('a sphere gives the great circle (2 pi r), a sphere patch the circle leaves and a freeform face are refused by reason', () => {
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
      surface: { type: 'other', kind: 'bspline' },
      uvBounds: [
        [0, 0],
        [1, 1],
      ],
    };
    expect(silhouettes(session([torus]), [0, 0, 1]).unsupported).toEqual([
      { face: 0, surface: 'other', reason: 'only plane, cylinder, cone, sphere and torus faces have a closed-form silhouette' },
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

describe('torus contours (spec 14.11)', () => {
  const torus: Geometry = {
    surface: { type: 'torus', center: [0, 0, 0], axis: Z, major: 10, minor: 3 },
    uvBounds: [
      [0, 0],
      [2 * Math.PI, 2 * Math.PI],
    ],
  };
  const normalAt = ([x, y, z]: Vec3): Vec3 => {
    const rho = Math.hypot(x, y);
    const n: Vec3 = [((rho - 10) * x) / rho, ((rho - 10) * y) / rho, z];
    const length = Math.hypot(...n);
    return [n[0] / length, n[1] / length, n[2] / length];
  };
  const nodesOf = (curve: { poles: readonly Vec3[] }): number => curve.poles.length - 3;

  it('seen along (0.3, 0.2, 1): two fitted closed curves with n . d = 0 at the fit nodes to 1e-9, the deviation within the tolerance, the pcurve one turn of u', () => {
    const d: Vec3 = [0.3, 0.2, 1];
    const found = silhouettes(session([torus]), d, 1e-6);
    expect(found.unsupported).toEqual([]);
    expect(found.curves).toHaveLength(2);
    for (const piece of found.curves) {
      expect(piece.kind).toBe('fitted');
      expect(piece.deviation).toBeLessThanOrEqual(1e-6);
      const nodes = nodesOf(piece.curve);
      expect(nodes).toBeGreaterThanOrEqual(8);
      const exactAt = (k: number): Vec3 => evaluateCurve(piece.curve, k / nodes);
      for (let k = 0; k < nodes; k++) {
        const n = normalAt(exactAt(k));
        expect(Math.abs((n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / Math.hypot(...d))).toBeLessThan(1e-9);
      }
      const uv = piece.pcurve.poles as readonly Vec2[];
      expect(Math.abs((uv[uv.length - 1] as Vec2)[0] - (uv[0] as Vec2)[0])).toBeCloseTo(2 * Math.PI, 6);
      expect(piece.length).toBeGreaterThan(2 * Math.PI * 7);
    }
  });

  it('seen along the axis the outer equator is the seam of the face (already an edge) and the inner equator is a circle of length 2 pi (R - r)', () => {
    const found = silhouettes(session([torus]), [0, 0, 5], 1e-6);
    expect(found.onEdge).toEqual([0]);
    expect(found.curves).toHaveLength(1);
    expect(found.curves[0]?.length).toBeCloseTo(2 * Math.PI * 7, 5);
  });

  it('seen in the equatorial plane, with a convention the surface frame does not follow, or leaving a patch, the torus is refused by reason', () => {
    expect(silhouettes(session([torus]), [1, 0.5, 0]).unsupported[0]?.reason).toContain('equatorial plane');
    expect(silhouettes(session([torus], { maxZ: 1 }), [0.3, 0.2, 1]).unsupported[0]?.reason).toContain('leaves this torus patch');
    const wrong = session([torus]);
    const evaluateFace = (wrong.query as unknown as { evaluateFace: (...args: unknown[]) => Array<{ point: Vec3; normal: Vec3 }> })
      .evaluateFace;
    const broken = {
      ...wrong,
      query: {
        ...wrong.query,
        evaluateFace: (shape: unknown, face: number, uv: readonly Vec2[]) =>
          evaluateFace(shape, face, uv).map((hit, k) => (k > 2 ? { ...hit, normal: X } : hit)),
      },
    } as SolidSession;
    expect(silhouettes(broken, [0.3, 0.2, 1]).unsupported[0]?.reason).toContain('parameter convention');
    const failing = { ...wrong, query: { ...wrong.query, evaluateFace: () => null } } as unknown as SolidSession;
    expect(silhouettes(failing, [0.3, 0.2, 1]).unsupported[0]?.reason).toContain('could not evaluate');
  });
});
