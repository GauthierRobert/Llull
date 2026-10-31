/**
 * 03 WRP silhouette of freeform (B-spline) faces (spec §14.16) on the fake freeform kernel: the contour n . d = 0 of a patch whose closed form is known (a cylinder patch: one ruling at the azimuth where the
 * normal is perpendicular to the view; a saddle z = k (x^2 - y^2) seen along x: the parabola x = 0), a trimmed face, a closed contour on a bump, and every named refusal (cusp, branch point, tangential view, pole,
 * periodic, no B-spline). The exact results on the native kernel are in server/tests/nativeSilhouetteFreeform.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { currentContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import { surfaceOfPort } from '@core/geometry/freeformChart';
import { curveDomain, evaluateCurve } from '@core/lib/nurbs/evaluate';
import { surfaceDerivatives } from '@core/lib/nurbs/surface';
import { isRejection, openSolid } from '@core/commands/wrap/faceSession';
import { silhouettes, type SilhouetteReport } from '@core/commands/wrap/silhouette';
import type { Vec3 } from '@core/model/types';
import { fakeFreeformKernel, type FakeFreeformOptions } from '../../helpers/fakeFreeformKernel';
import { cylinderPatch, saddlePatch, type PortSurface } from '../../helpers/freeformSurfaces';
import { emptyDoc, make } from './support';

afterEach(() => setGeometryKernel(null));

const TOLERANCE = 1e-6;

function silhouetteOf(
  patch: PortSurface,
  direction: Vec3,
  options: FakeFreeformOptions = {},
  asked: PortSurface = patch,
): SilhouetteReport {
  const kernel = fakeFreeformKernel(patch, options);
  // `asked` is what faceQuery.bspline answers (a periodic flag the chart of the fake would refuse)
  setGeometryKernel(
    asked === patch
      ? kernel
      : { ...kernel, faceQuery: { ...(kernel.faceQuery as NonNullable<typeof kernel.faceQuery>), bspline: () => asked } },
  );
  const body = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
  const session = openSolid(body.doc, currentContext(), 'split_at_silhouette', body.id);
  if (isRejection(session)) throw new Error(session.summary);
  return silhouettes(session, direction, TOLERANCE);
}
const reasonOf = (report: SilhouetteReport): string => report.unsupported[0]?.reason ?? '';
const samples = (report: SilhouetteReport, count = 41): Vec3[] => {
  const curve = report.curves[0]?.curve;
  if (curve === undefined) return [];
  const [first, last] = curveDomain(curve);
  return Array.from({ length: count }, (_, k) => evaluateCurve(curve, first + ((last - first) * k) / (count - 1)));
};

/** Bernstein coefficients of the cubic through the values at 0, 1/3, 2/3, 1. */
const bernstein = ([f0, f1, f2, f3]: number[]): number[] => [
  f0 as number,
  (-5 * (f0 as number) + 18 * (f1 as number) - 9 * (f2 as number) + 2 * (f3 as number)) / 6,
  (2 * (f0 as number) - 9 * (f1 as number) + 18 * (f2 as number) - 5 * (f3 as number)) / 6,
  f3 as number,
];

/** Bicubic Bezier patch z = f(x, y) over [x0 - h, x0 + h] x [y0 - h, y0 + h]. */
function bezierOf(f: (x: number, y: number) => number, h: number, x0 = 0, y0 = 0): PortSurface {
  const at = (k: number): number => -h + (2 * h * k) / 3;
  const rows = [0, 1, 2, 3].map((i) => bernstein([0, 1, 2, 3].map((j) => f(x0 + at(i), y0 + at(j)))));
  const columns = [0, 1, 2, 3].map((j) => bernstein(rows.map((row) => row[j] as number)));
  return {
    degreeU: 3,
    degreeV: 3,
    poles: [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j): Vec3 => [x0 + at(i), y0 + at(j), (columns[j] as number[])[i] as number])),
    knotsU: [0, 1],
    multsU: [4, 4],
    knotsV: [0, 1],
    multsV: [4, 4],
    periodicU: false,
    periodicV: false,
  };
}

/** The normal-to-view value |n . d| / |n| of the exact surface at (u, v) of the patch. */
function normalDot(patch: PortSurface, u: number, v: number, d: Vec3): number {
  const ds = surfaceDerivatives(surfaceOfPort(patch), u, v, 1);
  const [su, sv] = [(ds[1] as Vec3[])[0] as Vec3, (ds[0] as Vec3[])[1] as Vec3];
  const n: Vec3 = [su[1] * sv[2] - su[2] * sv[1], su[2] * sv[0] - su[0] * sv[2], su[0] * sv[1] - su[1] * sv[0]];
  const length = Math.hypot(n[0], n[1], n[2]);
  return Math.abs(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]) / (length * Math.hypot(d[0], d[1], d[2]));
}

describe('silhouette of a freeform face', () => {
  it('a cylinder patch (R 20, height 40) seen along (0.2, 1, 0): one ruling at azimuth -atan(0.2), 40 long, on the exact cylinder', () => {
    const report = silhouetteOf(cylinderPatch(20, -Math.PI / 4, Math.PI / 4, 40), [0.2, 1, 0]);
    expect(report.unsupported).toEqual([]);
    expect(report.curves).toHaveLength(1);
    const curve = report.curves[0];
    expect(curve?.kind).toBe('fitted');
    expect(curve?.length).toBeCloseTo(40, 6);
    expect(curve?.deviation).toBeLessThan(TOLERANCE);
    const phi = -Math.atan(0.2);
    for (const point of samples(report)) {
      expect(point[0]).toBeCloseTo(20 * Math.cos(phi), 6);
      expect(point[1]).toBeCloseTo(20 * Math.sin(phi), 6);
      expect(point[2]).toBeGreaterThanOrEqual(-1e-9);
      expect(point[2]).toBeLessThanOrEqual(40 + 1e-9);
    }
    const ends = [samples(report)[0], samples(report).at(-1)] as Vec3[];
    expect(ends.map((p) => Math.round(p[2] * 1e6) / 1e6).sort((a, b) => a - b)).toEqual([0, 40]);
    // the pcurve is in the face's own (u, v): a line of constant u
    const pcurve = curve?.pcurve.poles ?? [];
    expect(Math.max(...pcurve.map((p) => p[0])) - Math.min(...pcurve.map((p) => p[0]))).toBeLessThan(1e-6);
  });

  it('a cylinder patch whose ruling falls outside it (the view turned) has no silhouette; one along the axis has none either', () => {
    expect(silhouetteOf(cylinderPatch(20, -Math.PI / 4, Math.PI / 4, 40), [1, -0.8, 0]).curves).toEqual([]);
    const along = silhouetteOf(cylinderPatch(20, -Math.PI / 4, Math.PI / 4, 40), [0, 0, 1]);
    expect(along.curves).toEqual([]);
    expect(along.edgeOn).toEqual([0]);
  });

  it('a saddle z = k (x^2 - y^2) seen along x: the parabola x = 0, 10.0xx long (closed form), within the fit tolerance', () => {
    const k = 0.05;
    const patch = saddlePatch(k, 5);
    const report = silhouetteOf(patch, [1, 0, 0]);
    expect(report.unsupported).toEqual([]);
    expect(report.curves).toHaveLength(1);
    const a = 2 * k;
    const half = (5 / 2) * Math.sqrt(1 + a * a * 25) + Math.asinh(a * 5) / (2 * a);
    expect(report.curves[0]?.length).toBeCloseTo(2 * half, 6);
    expect(report.curves[0]?.deviation).toBeLessThan(TOLERANCE);
    for (const point of samples(report)) {
      expect(Math.abs(point[0])).toBeLessThan(1e-6);
      expect(point[2]).toBeCloseTo(-k * point[1] * point[1], 6);
    }
    // a skew view (1, 0.3, 0): -2 k x + 0.3 (2 k y) = 0, the line x = 0.3 y on the surface
    const skew = silhouetteOf(patch, [1, 0.3, 0]);
    for (const point of samples(skew)) {
      expect(point[0]).toBeCloseTo(0.3 * point[1], 6);
      expect(point[2]).toBeCloseTo(k * (point[0] * point[0] - point[1] * point[1]), 6);
    }
  });

  it('rounding noise of 1e-14 in the poles (the zero line x = 0 runs through grid nodes with noisy signs) still gives one clean parabola', () => {
    const clean = bezierOf((x, y) => 0.05 * (x * x - y * y), 5);
    const noisy: PortSurface = {
      ...clean,
      poles: clean.poles.map((row, i) => row.map(([x, y, z], j): Vec3 => [x, y, z + ((i + j) % 2 === 0 ? 1 : -1) * 1e-14 * (1 + j)])),
    };
    const report = silhouetteOf(noisy, [1, 0, 0]);
    expect(report.unsupported).toEqual([]);
    expect(report.curves).toHaveLength(1);
    const a = 0.1;
    expect(report.curves[0]?.length).toBeCloseTo(2 * ((5 / 2) * Math.sqrt(1 + a * a * 25) + Math.asinh(a * 5) / (2 * a)), 6);
  });

  it('a trimmed face keeps the part of the contour inside it: the saddle parabola cut at y = 3 (the boundary found by bisection)', () => {
    const k = 0.05;
    const report = silhouetteOf(saddlePatch(k, 5), [1, 0, 0], { trim: (point) => point[1] <= 3 });
    expect(report.curves).toHaveLength(1);
    const a = 2 * k;
    const arc = (y: number): number => (y / 2) * Math.sqrt(1 + a * a * y * y) + Math.asinh(a * y) / (2 * a);
    expect(report.curves[0]?.length).toBeCloseTo(arc(3) + arc(5), 5);
    const ys = samples(report).map((point) => point[1]);
    expect(Math.max(...ys)).toBeCloseTo(3, 6);
    expect(Math.min(...ys)).toBeCloseTo(-5, 6);
    // a face trimmed to the other side of the contour has none
    expect(silhouetteOf(saddlePatch(k, 5), [1, 0, 0], { trim: (point) => point[0] > 1 }).curves).toEqual([]);
  });

  it('a bump seen from an oblique view has a closed contour inside the face: the same point twice, and n . d = 0 on the exact surface all along it', () => {
    const uniform = [0, 1 / 6, 0.5, 5 / 6, 1];
    const patch: PortSurface = {
      degreeU: 3,
      degreeV: 3,
      poles: uniform.map((u, i) => uniform.map((v, j): Vec3 => [-5 + 10 * u, -5 + 10 * v, i === 2 && j === 2 ? 20 : 0])),
      knotsU: [0, 0.5, 1],
      multsU: [4, 1, 4],
      knotsV: [0, 0.5, 1],
      multsV: [4, 1, 4],
      periodicU: false,
      periodicV: false,
    };
    const d: Vec3 = [1, 0, 0.5];
    const report = silhouetteOf(patch, d);
    expect(report.unsupported).toEqual([]);
    expect(report.curves).toHaveLength(1);
    const points = samples(report, 61);
    expect(Math.hypot(...((points[0] as Vec3).map((c, k) => c - ((points.at(-1) as Vec3)[k] as number)) as unknown as Vec3))).toBeLessThan(
      1e-6,
    );
    expect(report.curves[0]?.length).toBeGreaterThan(10);
    // each point is on the surface with the normal perpendicular to the view: the pcurve gives (u, v)
    const pcurve = report.curves[0]?.pcurve;
    expect(pcurve).toBeDefined();
    const [first, last] = [0, 1];
    for (let k = 0; k < 30; k++) {
      const s = first + ((last - first) * (k + 0.5)) / 30;
      const [u, v] = evaluateCurve(
        { ...(pcurve as NonNullable<typeof pcurve>), poles: (pcurve?.poles ?? []).map(([a, b]) => [a, b, 0] as Vec3) },
        s,
      );
      expect(normalDot(patch, u, v, d)).toBeLessThan(1e-7);
    }
  });

  it('a contour along the boundary of a trimmed face already is an edge (reported, not split); a closed contour cut by the trim becomes open pieces; one wholly outside gives none', () => {
    const saddle = saddlePatch(0.05, 5);
    const onBoundary = silhouetteOf(saddle, [1, 0, 0], { trim: (point) => point[0] <= 1e-9 });
    expect(onBoundary.curves).toEqual([]);
    expect(onBoundary.onEdge).toEqual([0]);
    const uniform = [0, 1 / 6, 0.5, 5 / 6, 1];
    const bump: PortSurface = {
      degreeU: 3,
      degreeV: 3,
      poles: uniform.map((u, i) => uniform.map((v, j): Vec3 => [-5 + 10 * u, -5 + 10 * v, i === 2 && j === 2 ? 20 : 0])),
      knotsU: [0, 0.5, 1],
      multsU: [4, 1, 4],
      knotsV: [0, 0.5, 1],
      multsV: [4, 1, 4],
      periodicU: false,
      periodicV: false,
    };
    const d: Vec3 = [1, 0, 0.5];
    const whole = silhouetteOf(bump, d);
    const cut = silhouetteOf(bump, d, { trim: (point) => point[1] <= 0.5 });
    expect(cut.curves).toHaveLength(1);
    expect((cut.curves[0]?.length ?? 0) < (whole.curves[0]?.length ?? 0)).toBe(true);
    for (const point of samples(cut)) expect(point[1]).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(silhouetteOf(bump, d, { containsNothing: true }).curves).toEqual([]);
    // a B-spline whose domain does not contain the parameter box of the face
    const shifted: PortSurface = { ...saddle, knotsU: [2, 3], knotsV: [2, 3] };
    expect(reasonOf(silhouetteOf(saddle, [1, 0, 0], {}, shifted))).toContain('outside its B-spline');
  });

  it('a face parallel to the view is edge-on, a face turned toward it has none, and a face seen almost tangentially is refused by name', () => {
    const flat = (tilt: number): PortSurface => bezierOf((x) => tilt * x, 5);
    expect(silhouetteOf(flat(0), [1, 0, 0]).edgeOn).toEqual([0]);
    const toward = silhouetteOf(flat(0), [0, 0, 1]);
    expect(toward.curves).toEqual([]);
    expect(toward.unsupported).toEqual([]);
    // a plane tilted by 5e-4 seen along x: |n . d| stays under 1e-3 everywhere without changing sign
    const tangential = silhouetteOf(flat(5e-4), [1, 0, 0]);
    expect(tangential.curves).toEqual([]);
    expect(reasonOf(tangential)).toContain('tangentially');
  });

  it('a branch point (a monkey saddle seen along x: the contour is the two lines x = +-y crossing) and a double root are refused, not rewired', () => {
    const monkey = (x0: number, y0: number): PortSurface => bezierOf((x, y) => 0.05 * (x * x * x - 3 * x * y * y), 5, x0, y0);
    const branch = silhouetteOf(monkey(0, 0), [1, 0, 0]);
    expect(branch.curves).toEqual([]);
    expect(reasonOf(branch)).toContain('cusp');
    const offset = silhouetteOf(monkey(0.37, 0.21), [1, 0, 0]);
    expect(offset.curves).toEqual([]);
    expect(reasonOf(offset)).toContain('cusp');
    // z = k x^2 y / 2 seen along x: the contour is the two axes crossing at the origin, which lies inside a cell of the grid
    const axes = silhouetteOf(
      bezierOf((x, y) => 0.05 * x * x * y, 5, 0.1, 0.1),
      [1, 0, 0],
    );
    expect(axes.curves).toEqual([]);
    expect(reasonOf(axes)).toContain('branch point');
    const touching = silhouetteOf(
      bezierOf((x) => 0.05 * x * x * x, 5, 0.013),
      [1, 0, 0],
    );
    expect(touching.curves).toEqual([]);
    expect(reasonOf(touching)).toMatch(/cusp|tangential/);
  });

  it('a pole (a collapsed edge), a periodic B-spline, a missing B-spline and a B-spline outside the box are refused with their reason', () => {
    const saddle = saddlePatch(0.05, 5);
    const collapsed: PortSurface = { ...saddle, poles: saddle.poles.map((row, i) => (i === 0 ? row.map(() => row[0] as Vec3) : row)) };
    expect(reasonOf(silhouetteOf(saddle, [1, 0, 0], {}, collapsed))).toContain('pole');
    expect(reasonOf(silhouetteOf(saddle, [1, 0, 0], {}, { ...saddle, periodicU: true }))).toContain('periodic');
    expect(reasonOf(silhouetteOf(saddle, [1, 0, 0], { noBspline: true }))).toContain('no exact B-spline');
  });

  it('split_at_silhouette names a freeform refusal as WRP_SILHOUETTE_UNSUPPORTED with the reason', () => {
    setGeometryKernel(fakeFreeformKernel(saddlePatch(0.05, 5), { noBspline: true }));
    const body = make(emptyDoc(), 'add_box', { size: [10, 10, 10] });
    const refused = execute(body.doc, 'split_at_silhouette', { id: body.id, direction: [1, 0, 0] });
    expect(refused.error?.code).toBe('WRP_SILHOUETTE_UNSUPPORTED');
    expect(refused.summary).toContain('B-spline');
  });
});
