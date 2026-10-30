/**
 * 01 DEF §17.5 on the native kernel: `flow_on_surface` with a curved base SHEET is built by the exact warp (capability `deform-base-sheet`) and agrees with the
 * mesh path and the closed form: a plate bent on a cylinder of radius 50 and unrolled onto a flat target. Skipped without the binary / the capability.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { focalCheck } from '@core/commands/deform/flowSheetBase';
import type { IsolatedKernel } from '../src/isolatedKernel';
import { nativeSupportsDeform } from '../src/isolatedKernel';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';

const WORLD = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [1, 0, 0] } as const;
const QUARTER = (50 * Math.PI) / 2;
const surface = { kind: 'flowSurface', x0: 0, y0: 0, hx: 1, hy: 1, nx: 2, ny: 2, nodes: [], baseNodes: [] } as never;

it('a flow with a base sheet table needs the sidecar capability deform-base-sheet', () => {
  expect(nativeSupportsDeform(['deform'], surface)).toBe(false);
  expect(nativeSupportsDeform(['deform', 'deform-base-sheet'], surface)).toBe(true);
  expect(nativeSupportsDeform(['deform'], { ...(surface as object), baseNodes: undefined } as never)).toBe(true);
});

describeNativeWhen({ capabilities: ['deform', 'deform-base-sheet'], label: 'nativeKernelFlowSheet' })(
  'flow_on_surface base sheet on the native kernel',
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

    const sheet = (doc: CadDocument, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
      const made = execute(doc, 'create_nurbs_surface', params);
      expect(made.error, made.summary).toBeUndefined();
      return { doc: made.document, id: made.affected[0] as string };
    };
    const extent = (doc: CadDocument, id: string, axis: number): [number, number] => {
      const { positions } = (doc.entities[id] as unknown as { mesh: { positions: number[] } }).mesh;
      const values = positions.filter((_, i) => i % 3 === axis);
      return [values.reduce((a, b) => Math.min(a, b), Infinity), values.reduce((a, b) => Math.max(a, b), -Infinity)];
    };

    it('unrolls a bent plate: exact = mesh = closed form (x in [0, 78.54], thickness +-1, volume 3141.6)', () => {
      const box = execute(createEmptyDocument(), 'add_box', { size: [2, 20, QUARTER], anchor: 'base-center' });
      const bent = execute(box.document, 'bend_body', {
        id: box.affected[0],
        radius: 50,
        angleDeg: 90,
        frame: WORLD,
        output: { tolerance: 1e-3 },
      });
      expect(bent.error, bent.summary).toBeUndefined();
      const w = Math.SQRT1_2;
      const base = sheet(bent.document, {
        degreeU: 2,
        degreeV: 1,
        poles: [
          [
            [0, -15, 0],
            [0, 15, 0],
          ],
          [
            [0, -15, 50],
            [0, 15, 50],
          ],
          [
            [50, -15, 50],
            [50, 15, 50],
          ],
        ],
        weights: [
          [1, 1],
          [w, w],
          [1, 1],
        ],
      });
      const target = sheet(base.doc, {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [
            [-10, -30, 0],
            [-10, 30, 0],
          ],
          [
            [100, -30, 0],
            [100, 30, 0],
          ],
        ],
      });
      const flow = (mode: string): ReturnType<typeof execute> =>
        execute(target.doc, 'flow_on_surface', {
          id: bent.affected[0],
          base: { sheetId: base.id, origin: [0, 0, 0], uDirection: [0, 0, 1] },
          target: { sheetId: target.id },
          targetOrigin: [0, 0, 0],
          targetUDirection: [1, 0, 0],
          output: { mode, tolerance: 1e-3 },
        });
      const [exact, meshed] = [flow('exact'), flow('mesh')];
      expect(exact.error, exact.summary).toBeUndefined();
      expect((exact.data as { path: string }).path).toBe('exact');
      const next = exact.affected[0] as string;
      const mass = execute(exact.document, 'mass_properties', { entityId: next }).data as { volume: number; method: string };
      expect(mass.method).toBe('exact');
      const closed = QUARTER * 20 * 2;
      expect(Math.abs(mass.volume - closed) / closed).toBeLessThan(2e-3);
      expect(Math.abs((meshed.data as { volume: { value: number } }).volume.value - closed) / closed).toBeLessThan(2e-2);
      for (const result of [exact, meshed]) {
        const id = result.affected[0] as string;
        const [lo, hi] = extent(result.document, id, 0);
        expect(lo).toBeCloseTo(0, 1);
        expect(hi).toBeCloseTo(QUARTER, 1);
        const [zLo, zHi] = extent(result.document, id, 2);
        // the mesh path moves the points of the kernel's tessellation of the bent plate, whose chords lie inside the cylinders (sagitta about 0.03 at the inner face)
        const bound = result === exact ? 0.005 : 0.1;
        expect(Math.abs(zLo + 1)).toBeLessThan(bound);
        expect(Math.abs(zHi - 1)).toBeLessThan(bound);
      }
      const check = execute(exact.document, 'check_deformation', { volumeDriftRel: 5e-3 });
      expect((check.data as { status: string }).status).not.toBe('fail');
    }, 300_000);

    it('the exact warp never hangs either: a body around the axis, the focal check bypassed, ends with a refusal within seconds', () => {
      const plate = execute(createEmptyDocument(), 'add_box', { size: [60, 20, 10], position: [20, -10, -5], anchor: 'min' });
      const w = Math.SQRT1_2;
      const ring = [
        [0, 0, 0],
        [0, 0, 50],
        [50, 0, 50],
        [100, 0, 50],
        [100, 0, 0],
        [100, 0, -50],
        [50, 0, -50],
        [0, 0, -50],
        [0, 0, 0],
      ];
      const base = sheet(plate.document, {
        degreeU: 2,
        degreeV: 1,
        poles: ring.map((pole) => [
          [pole[0]!, -15, pole[2]!],
          [pole[0]!, 15, pole[2]!],
        ]),
        weights: [1, w, 1, w, 1, w, 1, w, 1].map((weight) => [weight, weight]),
        knotsU: [0, 0.25, 0.5, 0.75, 1],
        multiplicitiesU: [3, 2, 2, 2, 3],
      });
      const target = sheet(base.doc, {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [
            [-10, -30, 0],
            [-10, 30, 0],
          ],
          [
            [400, -30, 0],
            [400, 30, 0],
          ],
        ],
      });
      focalCheck.enabled = false;
      const started = Date.now();
      try {
        const result = execute(target.doc, 'flow_on_surface', {
          id: plate.affected[0],
          base: { sheetId: base.id, origin: [0, 0, 0], uDirection: [0, 0, 1] },
          target: { sheetId: target.id },
          targetOrigin: [0, 0, 0],
          targetUDirection: [1, 0, 0],
          output: { mode: 'exact' },
        });
        expect(result.error, result.summary).toBeDefined();
        expect(['DEF_APPROX_TOLERANCE', 'DEF_BUDGET_EXCEEDED', 'DEF_FLOW_BASE_OUTSIDE', 'DEF_KERNEL_REFUSED', 'DEF_FOLDOVER']).toContain(
          result.error?.code,
        );
      } finally {
        focalCheck.enabled = true;
      }
      expect(Date.now() - started).toBeLessThan(120_000);
    }, 300_000);
  },
);
