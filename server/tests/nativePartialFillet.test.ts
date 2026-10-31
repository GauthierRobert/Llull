/**
 * BLD M5, partial fillet (FR-BLD-11, TECHNICAL_SPEC 13.25): what the native kernel does with the nearest thing to a partial fillet, a radius law that falls to a small value at both ends of the edge. OCCT builds it down to
 * 1e-3 of the plateau radius, but the blend face then runs along the whole edge (a hairline round, seven faces instead of six): the edge outside the range is never sharp. That is why `fillet_edge` refuses `partial`
 * by name (BLD_PARTIAL_UNSUPPORTED) instead of building it. Skipped when the llull-kernel binary is not built.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument } from '@core/model/types';
import { createNativeTestKernel, describeNative } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

describeNative('BLD M5: a radius law that falls to a hairline is not a partial fillet (native OCCT kernel)', () => {
  let kernel: IsolatedKernel;
  beforeAll(() => {
    kernel = createNativeTestKernel();
    setGeometryKernel(kernel);
  }, 120_000);
  afterAll(() => {
    setGeometryKernel(null);
    kernel.dispose();
  });

  it.each([0.5, 0.1, 0.02, 0.005, 0.001])(
    'plateau radius 2 on the middle half of a 20 long edge, %s at both ends: it builds, valid, and the blend face runs along the whole edge (7 faces, area above the hairline floor)',
    (floor) => {
      const cube = execute(createEmptyDocument(), 'add_box', { size: [20, 20, 20], position: [10, 10, 10] });
      const id = cube.affected[0] as string;
      const done = execute(cube.document, 'fillet_edge', {
        id,
        edges: [
          {
            near: [10, 0, 0],
            size: floor,
            sizes: [
              { t: 0.25, size: 2 },
              { t: 0.75, size: 2 },
            ],
            sizeEnd: floor,
          },
        ],
      });
      expect(done.rejected, done.summary).toBeUndefined();
      const out = done.affected[0] as string;
      const topology = execute(done.document, 'inspect_topology', { id: out }).data as { faces: Array<{ name?: string; area: number }> };
      expect(topology.faces).toHaveLength(7);
      const blend = topology.faces.find((face) => face.name?.startsWith('blend('));
      expect(blend).toBeDefined();
      // the hairline round alone (radius `floor`, a quarter circle of length pi/2 x floor) over the 20 long edge is a floor of the face area
      expect(blend?.area as number).toBeGreaterThan(20 * (Math.PI / 2) * floor);
      const health = execute(done.document, 'mass_properties', { entityId: out }).data as { volume: number };
      expect(8000 - health.volume).toBeGreaterThan(0);
    },
  );
});
