/**
 * 01 DEF §17.4 on the native kernel: `deform_lattice` with a B-spline basis (`splineDegrees`) and an oriented box (`orientation`) is built by the exact warp
 * (capability `deform-lattice-spline`) and agrees with the mesh path and the closed forms. Skipped without the binary / the capability.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { nativeSupportsDeform } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';

const WORLD = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
const lattice = { kind: 'lattice', box: { min: [0, 0, 0], max: [1, 1, 1] }, degrees: [2, 2, 2], offsets: [] } as never;

it('a spline or oriented lattice needs the sidecar capability deform-lattice-spline', () => {
  const spline = { ...(lattice as object), splineDegrees: [2, 2, 2] } as never;
  const oriented = {
    ...(lattice as object),
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  } as never;
  for (const law of [spline, oriented]) {
    expect(nativeSupportsDeform(['deform'], law)).toBe(false);
    expect(nativeSupportsDeform(['deform', 'deform-lattice-spline'], law)).toBe(true);
  }
  expect(nativeSupportsDeform(['deform'], lattice)).toBe(true);
});

describeNativeWhen({ capabilities: ['deform', 'deform-lattice-spline'], label: 'nativeKernelLattice' })(
  'deform_lattice spline / oriented on the native kernel',
  () => {
    let kernel: IsolatedKernel;
    beforeAll(() => {
      kernel = createNativeTestKernel();
      setGeometryKernel(kernel);
    }, 120_000);
    afterAll(() => {
      kernel.dispose();
      setGeometryKernel(null);
    });

    const volumeOf = (doc: CadDocument, id: string): number => {
      const mass = execute(doc, 'mass_properties', { entityId: id }).data as { volume: number; method: string };
      expect(mass.method).toBe('exact');
      return mass.volume;
    };
    const xRange = (doc: CadDocument, id: string): [number, number] => {
      const { positions } = (doc.entities[id] as unknown as { mesh: { positions: number[] } }).mesh;
      const xs = positions.filter((_, i) => i % 3 === 0);
      return [xs.reduce((a, b) => Math.min(a, b), Infinity), xs.reduce((a, b) => Math.max(a, b), -Infinity)];
    };
    const bar = (): { doc: CadDocument; id: string } => {
      const made = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 100], anchor: 'base-center' });
      return { doc: made.document, id: made.affected[0] as string };
    };

    it('an oriented lattice moved by an affine map is that map: exact = mesh = 1.2 x the volume, x range +-6', () => {
      const { doc, id } = bar();
      const axes = [
        [Math.SQRT1_2, Math.SQRT1_2, 0],
        [0, 0, 1],
        [Math.SQRT1_2, -Math.SQRT1_2, 0],
      ];
      const box = { min: [-8, -1, -8], max: [8, 101, 8] };
      const moves: Array<{ index: number[]; delta: number[] }> = [];
      for (let i = 0; i <= 2; i++)
        for (let j = 0; j <= 2; j++)
          for (let k = 0; k <= 2; k++) {
            const c = [box.min[0]! + (i / 2) * 16, box.min[1]! + (j / 2) * 102, box.min[2]! + (k / 2) * 16];
            const x = axes[0]![0]! * c[0]! + axes[1]![0]! * c[1]! + axes[2]![0]! * c[2]!;
            moves.push({ index: [i, j, k], delta: [0.2 * x, 0, 0] });
          }
      const call = (mode: string): ReturnType<typeof execute> =>
        execute(doc, 'deform_lattice', {
          id,
          degrees: [2, 2, 2],
          box,
          orientation: { uAxis: [1, 1, 0], vAxis: [0, 0, 1] },
          frame: WORLD,
          moves,
          fixedLayers: 0,
          output: { mode, tolerance: 1e-3 },
        });
      const [exact, meshed] = [call('exact'), call('mesh')];
      expect(exact.error, exact.summary).toBeUndefined();
      expect((exact.data as { path: string }).path).toBe('exact');
      expect(Math.abs(volumeOf(exact.document, exact.affected[0] as string) - 12000) / 12000).toBeLessThan(1e-4);
      expect(Math.abs((meshed.data as { volume: { value: number } }).volume.value - 12000) / 12000).toBeLessThan(1e-6);
      const [lo, hi] = xRange(exact.document, exact.affected[0] as string);
      expect(lo).toBeCloseTo(-6, 2);
      expect(hi).toBeCloseTo(6, 2);
    }, 300_000);

    it('a B-spline lattice with a moved control point: the exact result has the volume of the mesh path and stays valid', () => {
      const { doc, id } = bar();
      const call = (mode: string): ReturnType<typeof execute> =>
        execute(doc, 'deform_lattice', {
          id,
          degrees: [2, 2, 6],
          splineDegrees: [2, 2, 2],
          box: { min: [-5, -5, 0], max: [5, 5, 100] },
          frame: WORLD,
          moves: [{ index: [1, 1, 3], delta: [2, 0, 0] }],
          output: { mode, tolerance: 1e-3 },
        });
      const [exact, meshed] = [call('exact'), call('mesh')];
      expect(exact.error, exact.summary).toBeUndefined();
      const exactVolume = volumeOf(exact.document, exact.affected[0] as string);
      const meshVolume = (meshed.data as { volume: { value: number } }).volume.value;
      expect(Math.abs(exactVolume - meshVolume) / meshVolume).toBeLessThan(2e-3);
      const check = execute(exact.document, 'check_deformation', {});
      expect((check.data as { status: string }).status).not.toBe('fail');
    }, 300_000);

    it('a fold is refused on both paths', () => {
      const { doc, id } = bar();
      for (const mode of ['exact', 'mesh']) {
        const result = execute(doc, 'deform_lattice', {
          id,
          degrees: [2, 2, 6],
          splineDegrees: [2, 2, 2],
          box: { min: [-5, -5, 0], max: [5, 5, 100] },
          frame: WORLD,
          moves: [{ index: [1, 1, 3], delta: [-60, 0, 0] }],
          output: { mode },
        });
        expect(result.error?.code).toBe('DEF_FOLDOVER');
      }
    });
  },
);
