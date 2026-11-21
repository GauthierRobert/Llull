/**
 * ASC M5 through the real sidecar: the tight box of a kernel-backed entity as placed (TR-ASC-15, VC-ASC-20) and the exact ruled polygon loft with planar
 * sides (TR-ASC-16, VC-ASC-21). Skipped without the binary / the capability `shapeBounds`.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { createEmptyDocument, type CadDocument, type LoftEntity } from '@core/model/types';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';

const RING_PROFILE = [
  [1058, -300],
  [1055, -550],
  [1042, -800],
  [1015, -1000],
  [980, -1105],
  [945, -1150],
  [905, -1165],
  [880, -1158],
  [862, -1135],
  [852, -1090],
  [851, -1000],
  [858, -800],
  [866, -550],
  [872, -300],
];

const pylonSection = (x: number, hx: number, hy: number): Record<string, unknown> => ({
  center: [x, 0, 960],
  rotation: [0, 1.5707963, 0],
  section: [
    [-hx, -hy],
    [0, -hy],
    [0, hy],
    [-hx, hy],
  ],
});

describeNativeWhen({ capabilities: ['shapeBounds'], label: 'nativeKernelFidelity' })('ASC M5 fidelity on the native kernel', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    kernel.dispose();
    setGeometryKernel(null);
  });

  it('VC-ASC-20: a rotated 270 degree revolve measures within 1060 in y and z, tighter than the corner estimate', () => {
    const made = execute(createEmptyDocument(), 'revolve_profile', {
      id: 'rotated_ring',
      profile: RING_PROFILE,
      axis: 'x',
      angle: (270 * Math.PI) / 180,
      rotation: [3.333579, 0, 0],
      segments: 128,
    });
    expect(made.affected, made.summary).toHaveLength(1);
    const ctx = { ...defaultContext(), kernel };
    const exact = execute(made.document, 'measure_bounding_box', { entityId: made.affected[0] }, ctx);
    const data = exact.data as { min: number[]; max: number[]; bounds: string };
    expect(data.bounds).toBe('exact');
    for (const axis of [1, 2]) {
      expect(Math.max(Math.abs(data.min[axis] as number), Math.abs(data.max[axis] as number))).toBeLessThanOrEqual(1060 + 1e-6);
    }
    const conservative = execute(made.document, 'measure_bounding_box', { entityId: made.affected[0] }, { ...ctx, kernel: null });
    const loose = conservative.data as { max: number[] };
    expect(loose.max[1]).toBeGreaterThan(1200);
    expect(kernel.info?.().capabilities).toContain('shapeBounds');
  });

  it('VC-ASC-21: the ruled pylon loft keeps its polygon sections and its side faces are planes', () => {
    const made = execute(createEmptyDocument(), 'loft_sections', {
      id: 'pylon_loft',
      sections: [pylonSection(300, 330, 130), pylonSection(1500, 520, 150), pylonSection(2600, 460, 140)],
      ruled: true,
    });
    expect(made.affected, made.summary).toEqual(['pylon_loft']);
    const loft = made.document.entities['pylon_loft'] as LoftEntity;
    expect(loft.polygon).toBe(true);
    const shape = kernel.evaluate(recipeOf(loft));
    expect(shape).not.toBeNull();
    const faces = kernel.topology(shape!)?.faces ?? [];
    expect(faces.filter((face) => face.surface === 'plane').length).toBeGreaterThanOrEqual(4 * 2 + 2);
    expect(faces.every((face) => face.surface === 'plane')).toBe(true);
    const box = kernel.shapeBounds!(shape!)!;
    expect(box.min[2]).toBeCloseTo(960, 6);
    expect(box.max[2]).toBeCloseTo(960 + 520, 6);
  });

  it('a ruled loft of different vertex counts is resampled with a LOFT_VERTEX_COUNT warning (replay of older files)', () => {
    const doc: CadDocument = createEmptyDocument();
    const resampled = execute(doc, 'loft_sections', {
      sections: [
        pylonSection(0, 10, 5),
        {
          ...pylonSection(50, 10, 5),
          section: [
            [0, 0],
            [5, 0],
            [0, 5],
          ],
        },
      ],
      ruled: true,
    });
    expect(resampled.error).toBeUndefined();
    expect(resampled.summary).toContain('warning LOFT_VERTEX_COUNT');
    const loft = resampled.document.entities[resampled.affected[0] as string] as LoftEntity;
    expect(loft.polygon).toBeUndefined();
    const shape = kernel.evaluate(recipeOf(loft));
    expect(shape).not.toBeNull();
  });
});
