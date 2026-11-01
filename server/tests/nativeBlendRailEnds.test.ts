/**
 * BLD M2 oblique ends of the rail builder on the native OCCT kernel (docs/design/06-variable-blends 13.35): a conic blend of a curved edge (a cylinder rim
 * ending on a plane that leaves the arc at an angle) or of a varying size builds with the skin cut by the end plane. The circular conic (rho = sqrt(2) - 1)
 * is OCCT's own fillet, check_blends reads the result, and a varying size that flares past the end of the edge is built from its size law continued by the end tangent (13.37).
 * Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

type Doc = CadDocument;
const CIRCLE_RHO = Math.SQRT2 - 1;

describeNative('BLD oblique ends of the rail builder (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  const made = (doc: Doc, command: string, params: Record<string, unknown>): { doc: Doc; id: string } => {
    const result = execute(doc, command, params);
    return { doc: result.document, id: result.affected[0] as string };
  };
  const volume = (doc: Doc, id: string): number => (execute(doc, 'mass_properties', { entityId: id }).data as { volume: number }).volume;
  /** A cylinder of radius 8 and height 3 on the z axis cut by the plane x = 3 (the rim arc leaves it at an angle). */
  const cutCylinder = (s: number): { doc: Doc; id: string } => {
    const cylinder = made(createEmptyDocument(), 'add_cylinder', { radius: 8 * s, height: 3 * s, position: [0, 0, 1.5 * s] });
    const slab = made(cylinder.doc, 'add_box', { size: [20 * s, 20 * s, 6 * s], position: [-7 * s, 0, 1.5 * s] });
    return made(slab.doc, 'boolean', { op: 'intersect', a: cylinder.id, b: slab.id, engine: 'kernel' });
  };

  it.each([1, 10])(
    'a circular conic on the rim arc that ends on a plane equals OCCT fillet and passes check_blends with only the conic G2 jumps at %d mm',
    (s) => {
      const part = cutCylinder(s);
      const conic = execute(part.doc, 'fillet_edge', {
        id: part.id,
        edgesNear: [[-8 * s, 0, 3 * s]],
        radius: s,
        profile: { type: 'conic', rho: CIRCLE_RHO },
      });
      expect(conic.error, conic.summary).toBeUndefined();
      const conicId = conic.affected[0] as string;
      const round = execute(part.doc, 'fillet_edge', { id: part.id, edgesNear: [[-8 * s, 0, 3 * s]], radius: s });
      expect(round.error, round.summary).toBeUndefined();
      const a = volume(conic.document, conicId);
      const b = volume(round.document, round.affected[0] as string);
      expect(Math.abs(a - b)).toBeLessThan(1e-6 * b);
      const checked = execute(conic.document, 'check_blends', {}).data as { findings: Array<{ code: string }> };
      expect(checked.findings.filter((finding) => finding.code !== 'BLD_CHECK_G2_JUMP')).toEqual([]);
    },
  );

  it('builds a varying size that flares past both ends as the integral of the continued size law, and check_blends reads it', () => {
    const flared = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10, 0],
        [13, 6],
        [-3, 6],
      ],
      depth: 3,
    });
    const built = execute(flared.doc, 'fillet_edge', {
      id: flared.id,
      edges: [{ near: [5, 0, 3], size: 0.4, sizeEnd: 0.8, interpolation: 'linear' }],
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(built.error, built.summary).toBeUndefined();
    // the section at x has the parabola of legs d(x) = 0.4 + 0.04 x (the law continued past both ends by its end tangent); the end walls x = -y / 2 and
    // x = 10 + y / 2 keep the part of the section deeper than 2 (the distance past the vertex)
    const slope = 0.04;
    const beyond = (d: number, depth: number): number => {
      if (depth >= d) return 0;
      const u2 = depth / d;
      const u = Math.sqrt(u2);
      return d * d * (1 / 6 - (u2 - (4 / 3) * u2 * u + 0.5 * u2 * u2));
    };
    const simpson = (f: (x: number) => number, a: number, b: number): number => {
      const n = 2000;
      const h = (b - a) / n;
      let sum = f(a) + f(b);
      for (let k = 1; k < n; k += 1) sum += f(a + k * h) * (k % 2 === 1 ? 4 : 2);
      return (sum * h) / 3;
    };
    const expected =
      simpson((x) => (0.4 + slope * x) ** 2 / 6, 0, 10) +
      simpson((w) => 2 * w * beyond(0.8 + slope * w * w, 2 * w * w), 0, Math.sqrt(0.8 / (2 - slope))) +
      simpson((w) => 2 * w * beyond(0.4 - slope * w * w, 2 * w * w), 0, Math.sqrt(0.4 / (2 + slope)));
    const removed = volume(flared.doc, flared.id) - volume(built.document, built.affected[0] as string);
    expect(Math.abs(removed - expected)).toBeLessThan(1e-5 * expected);
    const checked = execute(built.document, 'check_blends', {}).data as { findings: Array<{ code: string }> };
    expect(checked.findings.filter((finding) => finding.code !== 'BLD_CHECK_G2_JUMP')).toEqual([]);
  });

  it('builds the default smooth transition (zero end slopes: the size is held constant past the vertex) on the same flared prism', () => {
    const flared = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10, 0],
        [13, 6],
        [-3, 6],
      ],
      depth: 3,
    });
    const built = execute(flared.doc, 'fillet_edge', {
      id: flared.id,
      edgesNear: [[5, 0, 3]],
      radius: 0.4,
      radiusEnd: 0.8,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(built.error, built.summary).toBeUndefined();
    const checked = execute(built.document, 'check_blends', {}).data as { findings: Array<{ code: string }> };
    expect(checked.findings.filter((finding) => finding.code !== 'BLD_CHECK_G2_JUMP')).toEqual([]);
  });
});
