/**
 * VC-RTE-42 against the native OCCT kernel (plant 02 RTE V1c, SC-RTE-21, D24): `export_pipe_step` of the small line (DN100 CS150, +X 3000 then +Z 2000) writes
 * three exact solids; the same-kernel self-check passes; every product volume equals a hand-derived closed form. Skipped (with the reason logged) when the
 * llull-kernel binary is not built.
 *
 * Hand derivation (README D24): OD 114.3 so r = 57.15 mm. Pipe pieces are solid cylinders (display geometry): PIPE 1 from x 0 to 3000 - 152 = 2848,
 * PIPE 2 from z 152 to 2000 = 1848. V = pi r^2 L: 10260.82645 mm2 x 2848 = 29,222,833.73 mm3 and x 1848 = 18,962,007.28 mm3. The elbow is a true torus segment (R 152, r 57.15, the
 * section is a circle, not the 16-gon of the display mesh) swept pi/2: V = (pi/2) x 152 x pi r^2 = 2,449,885.61 mm3 (Pappus), area (pi/2) x 152 x 2 pi r +
 * 2 pi r^2. Total 50,634,726.63 mm3.
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
/** Elbow: volume and area of the torus segment (end discs included). */
const ELBOW_AREA = (Math.PI / 2) * BEND_RADIUS * 2 * Math.PI * RADIUS + 2 * Math.PI * RADIUS ** 2;
const ELBOW = (Math.PI / 2) * BEND_RADIUS * Math.PI * RADIUS ** 2;

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
      gvp: Array<{ product: string; volume: number; area: number }>;
    };
    expect(data.solidCount).toBe(3);
    expect(data.skipped).toEqual([]);
    expect(data.faceted).toEqual([]);
    expect(data.selfCheck).toMatchObject({ band: 'green', missing: [], products: 3 });
    expect(data.step).toContain('ISO-10303-21');
    expect(data.step).toContain('MANIFOLD_SOLID_BREP');
    // The elbow is a true torus segment (R 152, r 57.15), not a revolved polygon: its end circles are those of the pipe pieces (radius 57.15), and no
    // other circle than those and the torus seams (152 +- 57.15) exists, so the welds close (a 16-gon end face would not match a pipe's circle).
    expect(data.step).toMatch(/TOROIDAL_SURFACE\('',#\d+,152\.,57\.15\)/);
    const radii = [...data.step.matchAll(/CIRCLE\('',#\d+,([\d.]+)\)/g)].map((match) => Number(match[1]));
    expect(radii.filter((radius) => radius === RADIUS).length).toBeGreaterThanOrEqual(6);
    expect(
      radii.every((radius) => [RADIUS, BEND_RADIUS + RADIUS, BEND_RADIUS - RADIUS].some((wanted) => Math.abs(radius - wanted) < 1e-9)),
    ).toBe(true);
    const volumes = data.gvp.map((entry) => entry.volume).sort((a, b) => a - b);
    const expected = [ELBOW, PIPE_2, PIPE_1];
    expect(volumes).toHaveLength(3);
    volumes.forEach((volume, index) =>
      expect(Math.abs(volume - (expected[index] as number))).toBeLessThanOrEqual(1e-6 * (expected[index] as number)),
    );
    const elbowArea = data.gvp.find((entry) => Math.abs(entry.volume - ELBOW) < 1e-6 * ELBOW)?.area ?? 0;
    expect(Math.abs(elbowArea - ELBOW_AREA)).toBeLessThanOrEqual(1e-6 * ELBOW_AREA);
    const total = volumes.reduce((sum, volume) => sum + volume, 0);
    expect(Math.abs(total - 50634726.62934)).toBeLessThanOrEqual(1e-6 * 50634726.62934);
  }, 180_000);
});
