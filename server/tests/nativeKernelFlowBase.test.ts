/**
 * 01 DEF §17.2 on the native kernel: `flow_along_curve` with a `baseCurve` is built by the exact warp (capability `deform-base-curve`) and agrees with the
 * mesh path and with the closed forms; a straight rod bent on a quarter circle and flowed from its own centreline onto a line is straight again.
 * Skipped without the binary / the capabilities.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { nativeSupportsDeform } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';

const WORLD = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
const QUARTER = (50 * Math.PI) / 2;
const flowBase = { kind: 'flowCurve', z0: 0, ratio: 1, step: 1, stations: [], base: { step: 1, stations: [] } } as never;

it('a flow law with a base curve needs the sidecar capability deform-base-curve', () => {
  expect(nativeSupportsDeform(['deform'], flowBase)).toBe(false);
  expect(nativeSupportsDeform(['deform', 'deform-base-curve'], flowBase)).toBe(true);
  expect(nativeSupportsDeform(['deform'], { ...(flowBase as object), base: undefined } as never)).toBe(true);
});

describeNativeWhen({ capabilities: ['deform', 'deform-base-curve'], label: 'nativeKernelFlowBase' })(
  'flow_along_curve baseCurve on the native kernel',
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

    const volumeOfEntity = (doc: CadDocument, id: string): number => {
      const mass = execute(doc, 'mass_properties', { entityId: id }).data as { volume: number; method: string };
      expect(mass.method).toBe('exact');
      return mass.volume;
    };
    const zExtent = (doc: CadDocument, id: string): number => {
      const { positions } = (doc.entities[id] as unknown as { mesh: { positions: number[] } }).mesh;
      const heights = positions.filter((_, i) => i % 3 === 2);
      return heights.reduce((a, b) => Math.max(a, b), -Infinity) - heights.reduce((a, b) => Math.min(a, b), Infinity);
    };

    it('straightens a bent rod: exact path = mesh path = the closed form, and the exact result is a valid solid', () => {
      const rod = execute(createEmptyDocument(), 'add_cylinder', { radius: 5, height: QUARTER, anchor: 'base-center' });
      const bent = execute(rod.document, 'bend_body', {
        id: rod.affected[0],
        radius: 50,
        angleDeg: 90,
        frame: WORLD,
        output: { tolerance: 0.01 },
      });
      expect(bent.error, bent.summary).toBeUndefined();
      const base = execute(bent.document, 'create_conic', { start: [0, 0, 0], apex: [0, 0, 50], end: [50, 0, 50], rho: Math.SQRT2 - 1 });
      const line = execute(base.document, 'create_nurbs_curve', {
        degree: 1,
        poles: [
          [200, 0, 0],
          [200, 0, 100],
        ],
      });
      const flow = (mode: string): ReturnType<typeof execute> =>
        execute(line.document, 'flow_along_curve', {
          id: bent.affected[0],
          targetId: line.affected[0],
          baseCurve: base.affected[0],
          frame: WORLD,
          output: { mode, tolerance: 1e-3 },
        });
      const [exact, meshed] = [flow('exact'), flow('mesh')];
      expect(exact.error, exact.summary).toBeUndefined();
      expect((exact.data as { path: string }).path).toBe('exact');
      const straight = Math.PI * 25 * QUARTER;
      const next = exact.affected[0] as string;
      expect(Math.abs(volumeOfEntity(exact.document, next) - straight) / straight).toBeLessThan(5e-4);
      expect(Math.abs((meshed.data as { volume: { value: number } }).volume.value - straight) / straight).toBeLessThan(2e-2);
      expect(zExtent(exact.document, next)).toBeCloseTo(QUARTER, 1);
      expect(zExtent(meshed.document, meshed.affected[0] as string)).toBeCloseTo(QUARTER, 1);
      // the predicted volume integrates over the tessellation of the bent source, so it is only as exact as that mesh: 5e-4 here
      const check = execute(exact.document, 'check_deformation', { volumeDriftRel: 2e-3 });
      expect(
        (check.data as { status: string; findings: unknown }).status,
        JSON.stringify((check.data as { findings: unknown }).findings),
      ).not.toBe('fail');
    }, 300_000);
  },
);
