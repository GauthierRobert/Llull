/**
 * BLD M2 ends on the native OCCT kernel (docs/design/06-variable-blends 13.29): a profile blend on a straight edge that ends on a flat face which is not
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
    expect(refused.summary).toContain('ends obliquely');
    expect(refused.document).toBe(steep.doc);
  });
});
