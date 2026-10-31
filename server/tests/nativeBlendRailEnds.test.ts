/**
 * BLD M2 oblique ends of the rail builder on the native OCCT kernel (docs/design/06-variable-blends 13.35): a conic blend of a curved edge (a cylinder rim
 * ending on a plane that leaves the arc at an angle) or of a varying size builds with the skin cut by the end plane. The circular conic (rho = sqrt(2) - 1)
 * is OCCT's own fillet, check_blends reads the result, and a varying size that needs OCCT's constant extension past the edge is refused by name.
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

  it('refuses a varying size whose oblique end needs the constant extension OCCT gives past the edge, naming the chord', () => {
    const flared = made(createEmptyDocument(), 'extrude_profile', {
      profile: [
        [0, 0],
        [10, 0],
        [13, 6],
        [-3, 6],
      ],
      depth: 3,
    });
    const refused = execute(flared.doc, 'fillet_edge', {
      id: flared.id,
      edgesNear: [[5, 0, 3]],
      radius: 0.4,
      radiusEnd: 0.8,
      profile: { type: 'conic', rho: 0.5 },
    });
    expect(refused.error?.code).toBe('BLD_PROFILE_FAILED');
    expect(refused.summary).toContain('does not continue past the end of the edge');
    expect(refused.document).toBe(flared.doc);
  });
});
