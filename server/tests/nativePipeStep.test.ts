/**
 * VC-RTE-42 against the native OCCT kernel (plant 02 RTE V1c, SC-RTE-21, D24): `export_pipe_step` of the small line (DN100 CS150, +X 3000 then +Z 2000) writes
 * three exact solids; the same-kernel self-check passes; every product volume equals a hand-derived closed form. Skipped (with the reason logged) when the
 * llull-kernel binary is not built.
 *
 * Hand derivation (README D24): OD 114.3 so r = 57.15 mm. Pipe pieces are solid cylinders (display geometry): PIPE 1 from x 0 to 3000 - 152 = 2848,
 * PIPE 2 from z 152 to 2000 = 1848. V = pi r^2 L: 10260.82645 mm2 x 2848 = 29,222,833.73 mm3 and x 1848 = 18,962,007.28 mm3. The elbow section is the
 * 16-point polygon inscribed in the pipe circle (area 8 r^2 sin(pi/8) = 9999.12775 mm2, centre at the bend radius 152 from the bend axis), revolved
 * pi/2 about the axis: Pappus V = (pi/2) x 152 x 9999.12775 = 2,387,402.16 mm3. Total 50,572,243.17 mm3.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { addTie, cs150Line } from '../../tests/unit/plant/piping/rteFixtures';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';

const RADIUS = 57.15;
const BEND_RADIUS = 152;
const PIPE_1 = Math.PI * RADIUS ** 2 * 2848;
const PIPE_2 = Math.PI * RADIUS ** 2 * 1848;
const ELBOW = (Math.PI / 2) * BEND_RADIUS * 8 * RADIUS ** 2 * Math.sin(Math.PI / 8);

function smallLine(): CadDocument {
  const line = cs150Line(100, '6001');
  const a = addTie(line.doc, 'STEP-A', [0, 0, 0], [1, 0, 0]);
  const routed = execute(a.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Z', length: 2000 },
    ],
  });
  expect(routed.rejected, routed.summary).toBeUndefined();
  return routed.document;
}

describeNative('export_pipe_step on the native OCCT kernel (VC-RTE-42)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  it('writes 3 exact solids, the self-check is green and the volumes are the closed forms (rel 1e-6)', () => {
    const doc = smallLine();
    const result = execute(doc, 'export_pipe_step', { timestamp: '2026-10-24T00:00:00' }, { ...defaultContext(), kernel });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.document).toBe(doc);
    const data = result.data as {
      step: string;
      solidCount: number;
      faceted: string[];
      skipped: string[];
      selfCheck: { band: string; missing: string[]; products: number };
      gvp: Array<{ product: string; volume: number }>;
    };
    expect(data.solidCount).toBe(3);
    expect(data.skipped).toEqual([]);
    expect(data.faceted).toEqual([]);
    expect(data.selfCheck).toMatchObject({ band: 'green', missing: [], products: 3 });
    expect(data.step).toContain('ISO-10303-21');
    expect(data.step).toContain('MANIFOLD_SOLID_BREP');
    const volumes = data.gvp.map((entry) => entry.volume).sort((a, b) => a - b);
    const expected = [ELBOW, PIPE_2, PIPE_1];
    expect(volumes).toHaveLength(3);
    volumes.forEach((volume, index) =>
      expect(Math.abs(volume - (expected[index] as number))).toBeLessThanOrEqual(1e-6 * (expected[index] as number)),
    );
    const total = volumes.reduce((sum, volume) => sum + volume, 0);
    expect(Math.abs(total - 50572243.17485)).toBeLessThanOrEqual(1e-6 * 50572243.17485);
  }, 180_000);
});
