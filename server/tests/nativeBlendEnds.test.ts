/**
 * BLD M2 ends on the native OCCT kernel (docs/design/06-variable-blends 13.30): a profile blend on a straight edge that ends on a flat face which is not
 * perpendicular to it runs past that face and is trimmed by it. Removed volume against the closed form of the spandrel (area d^2 / 6 and first moment
 * d^3 / 30 of the parabola with legs d), check_blends reading the result, and the refusals by name. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
const SCALES = [1, 10] as const;

/** Composite Simpson rule of `f` on [a, b]. */
const simpson = (f: (x: number) => number, a: number, b: number): number => {
  const n = 2000;
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let k = 1; k < n; k += 1) sum += f(a + k * h) * (k % 2 === 1 ? 4 : 2);
  return (sum * h) / 3;
};

describeNative('BLD oblique ends of profile blends (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const made = (
    doc: Doc,
    command: string,
    params: Record<string, unknown>,
  ): { doc: Doc; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  /** A prism 3 high over the polygon (x, y) scaled by `s`: the front edge (y = 0) of the top face is the one blended. */
  const prism = (points: ReadonlyArray<readonly [number, number]>, s: number): { doc: Doc; id: string } =>
    made(createEmptyDocument(), 'extrude_profile', { profile: points.map(([x, y]) => [x * s, y * s]), depth: 3 * s });
  const FLARED = [
    [0, 0],
    [10, 0],
    [13, 6],
    [-3, 6],
  ] as const;
  const NARROWED = [
    [0, 0],
    [10, 0],
    [7, 6],
    [3, 6],
  ] as const;

  it.each(SCALES)(
    'a conic (rho 0.5) blend of the top front edge with end walls tilted 0.5 outward / inward removes A L +- tan M at %d mm, and check_blends reads it as a square-ended conic',
    (s) => {
      const d = 2 * s;
      const area = (d * d) / 6;
      const moment = d ** 3 / 30;
      // the only finding a conic has on a square-ended block is the G1-only curvature jump at its two contact lines
      const square = made(createEmptyDocument(), 'add_box', { size: [20 * s, 10 * s, 5 * s] });
      const squareBlend = made(square.doc, 'fillet_edge', {
        id: square.id,
        edgesNear: [[0, 5 * s, 2.5 * s]],
        radius: d,
        profile: { type: 'conic', rho: 0.5 },
      });
      const squareFindings = (execute(squareBlend.doc, 'check_blends', {}).data as { findings: Array<{ code: string }> }).findings.map(
        (finding) => finding.code,
      );
      expect(squareFindings).toEqual(['BLD_CHECK_G2_JUMP', 'BLD_CHECK_G2_JUMP']);
      for (const [points, sign, base] of [
        [FLARED, 1, 234],
        [NARROWED, -1, 126],
      ] as const) {
        const { doc, id } = prism(points, s);
        expect(Math.abs(volume(doc, id) - base * s ** 3)).toBeLessThan(1e-9 * base * s ** 3);
        const done = made(doc, 'fillet_edge', { id, edgesNear: [[5 * s, 0, 3 * s]], radius: d, profile: { type: 'conic', rho: 0.5 } });
        expect(done.result.error, done.result.summary).toBeUndefined();
        const removed = volume(doc, id) - volume(done.doc, done.id);
        const expected = area * 10 * s + sign * moment;
        expect(Math.abs(removed - expected) / expected).toBeLessThan(1e-6);
        const check = execute(done.doc, 'check_blends', {}).data as { findings: Array<{ code: string }> };
        expect(check.findings.map((finding) => finding.code)).toEqual(squareFindings);
      }
    },
  );

  it('refuses an end face that is nearly parallel to the edge, and legs the end faces cut to nothing, by name', () => {
    const steep = prism(
      [
        [0, 0],
        [10, 0],
        [70, 6],
        [-60, 6],
      ],
      1,
    );
    const refused = execute(steep.doc, 'fillet_edge', {
      id: steep.id,
      edgesNear: [[5, 0, 3]],
      radius: 0.5,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(refused.error?.code).toBe('BLD_PROFILE_FAILED');
    expect(refused.summary).toContain('rad from square to the edge');
    expect(refused.document).toBe(steep.doc);
  });

  it('keeps the prism builder reason for a straight edge: a reflex end and a rib beyond the end plane', () => {
    const profile = { type: 'conic', rho: 0.5 };
    const reflex = prism(
      [
        [0, 0],
        [10, 0],
        [12, -3],
        [20, -3],
        [20, 6],
        [0, 6],
      ],
      1,
    );
    const noCorner = execute(reflex.doc, 'fillet_edge', { id: reflex.id, edgesNear: [[5, 0, 3]], radius: 0.5, profile });
    expect(noCorner.error?.code).toBe('BLD_PROFILE_FAILED');
    expect(noCorner.summary).toContain('is still inside the solid there');
    expect(noCorner.document).toBe(reflex.doc);
  });

  it('builds a straight edge that ends on a curved face through the rail builder (13.37) as the integral of the cut section', () => {
    const profile = { type: 'conic', rho: 0.5 };
    const box = made(createEmptyDocument(), 'add_box', { size: [10, 10, 5], position: [5, 5, 2.5] });
    const cylinder = made(box.doc, 'add_cylinder', { radius: 8, height: 5, position: [0, 0, 2.5] });
    const curved = made(cylinder.doc, 'boolean', { op: 'intersect', a: box.id, b: cylinder.id, engine: 'kernel' });
    // the prism builder refuses ("is on a curved face"); the rail builder cuts the blend by the cylinder, which leaves the section planes x = const at the depth
    // sqrt(64 - x^2): the parabola of legs d = 0.5 is whole up to x* = sqrt(64 - d^2) and cut after it (q = sqrt(depth), dx = -2 q^3 / x dq)
    const onCylinder = execute(curved.doc, 'fillet_edge', { id: curved.id, edgesNear: [[4, 0, 5]], radius: 0.5, profile });
    expect(onCylinder.error, onCylinder.summary).toBeUndefined();
    const d = 0.5;
    const star = Math.sqrt(64 - d * d);
    const cut = simpson(
      (q) => {
        const u2 = (q * q) / d;
        const u = Math.sqrt(u2);
        return (d * d * (u2 - (4 / 3) * u2 * u + 0.5 * u2 * u2) * 2 * q ** 3) / Math.sqrt(64 - q ** 4);
      },
      0,
      Math.sqrt(d),
    );
    const expected = (d * d * star) / 6 + cut;
    const removed = volume(curved.doc, curved.id) - volume(onCylinder.document, onCylinder.affected[0] as string);
    expect(Math.abs(removed - expected)).toBeLessThan(1e-5 * expected);
  });

  it('keeps the prism builder reason for a straight edge: a rib beyond the end plane', () => {
    const profile = { type: 'conic', rho: 0.5 };
    const flared = prism(FLARED, 1);
    const rib = made(flared.doc, 'add_box', { size: [0.8, 0.2, 3], position: [-0.5, 0.4, 1.5] });
    const ribbed = made(rib.doc, 'boolean', { op: 'union', a: flared.id, b: rib.id, engine: 'kernel' });
    const notched = execute(ribbed.doc, 'fillet_edge', { id: ribbed.id, edgesNear: [[5, 0, 3]], radius: 1, profile });
    expect(notched.error?.code).toBe('BLD_PROFILE_FAILED');
    expect(notched.summary).toContain('the solid stands in the way beyond an oblique end');
    expect(notched.document).toBe(ribbed.doc);
    expect(execute(flared.doc, 'fillet_edge', { id: flared.id, edgesNear: [[5, 0, 3]], radius: 1, profile }).error).toBeUndefined();
  });

  it.each(SCALES)(
    'legs d1 x d2 (size2) with oblique ends remove A(d1, d2) L +- M(d1, d2): the elliptic spandrel, from either side, at %d mm',
    (s) => {
      // circle -> ellipse with semi-axes d1 (across the top face) and d2 (down the front face): A = d1 d2 (1 - pi/4), M = d1^2 d2 (5/6 - pi/4)
      const area = (top: number, side: number): number => top * side * (1 - Math.PI / 4);
      const moment = (top: number, side: number): number => top * top * side * (5 / 6 - Math.PI / 4);
      for (const [points, sign] of [
        [FLARED, 1],
        [NARROWED, -1],
      ] as const) {
        for (const [top, side] of [
          [1 * s, 2 * s],
          [2 * s, 1 * s],
        ] as const) {
          const { doc, id } = prism(points, s);
          const firstOnTop = top === 1 * s;
          // size is the leg on side1: the top face (point on z = 3 s) or the front face (point on y = 0)
          const done = made(doc, 'fillet_edge', {
            id,
            edges: [
              {
                near: [5 * s, 0, 3 * s],
                size: firstOnTop ? top : side,
                size2: firstOnTop ? side : top,
                side1Near: firstOnTop ? [5 * s, 3 * s, 3 * s] : [5 * s, 0, 1.5 * s],
              },
            ],
          });
          expect(done.result.error, done.result.summary).toBeUndefined();
          const removed = volume(doc, id) - volume(done.doc, done.id);
          const expected = area(top, side) * 10 * s + sign * moment(top, side);
          expect(Math.abs(removed - expected) / expected).toBeLessThan(1e-5);
        }
      }
    },
  );

  it('a curvature profile with oblique ends: A = 0.1 d^2 (flared + narrowed cancel the moment), 0 < M < the circle moment, G2 at both contacts', () => {
    const d = 2;
    const removed = (points: typeof FLARED | typeof NARROWED): number => {
      const { doc, id } = prism(points, 1);
      const done = made(doc, 'fillet_edge', { id, edgesNear: [[5, 0, 3]], radius: d, profile: { type: 'curvature', shape: 0.5 } });
      expect(done.result.error, done.result.summary).toBeUndefined();
      const check = execute(done.doc, 'check_blends', { require: 'G2' }).data as {
        status: string;
        findings: Array<{ code: string }>;
        blends: Array<{ contacts: Array<{ g1AngleRad: number; g2Gap: number }> }>;
      };
      expect(check.status, JSON.stringify(check.findings)).toBe('pass');
      for (const contact of check.blends[0]?.contacts ?? []) expect(Math.max(contact.g1AngleRad, contact.g2Gap)).toBeLessThan(1e-6);
      return volume(doc, id) - volume(done.doc, done.id);
    };
    const flared = removed(FLARED);
    const narrowed = removed(NARROWED);
    expect(Math.abs(flared + narrowed - 2 * 0.1 * d * d * 10) / (2 * 0.1 * d * d * 10)).toBeLessThan(1e-5);
    const moment = (flared - narrowed) / 2;
    expect(moment).toBeGreaterThan(0);
    expect(moment).toBeLessThan(d ** 3 * (5 / 6 - Math.PI / 4));
  });
});
