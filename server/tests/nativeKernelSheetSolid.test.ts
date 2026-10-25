/**
 * DES-2c on the native OCCT kernel: the `sheetSolid` recipe node (sweeps with laws / frames, lofts with exact faces), a hollow round section with laws
 * (outer faces minus bore faces, exact volume against the closed form), and the volume-consistency check of `check_sweep_loft` on the pack's plans.
 * Skipped when the llull-kernel binary is not built (or lacks the capabilities).
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { sweepAnalyticVolume } from '@core/geometry/sweepEval/volume';
import { createEmptyDocument, type CadDocument, type SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { relError, runSwgPlan, swgPlan } from '../../tests/helpers/swgPack';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

describeNativeWhen({ capabilities: ['sheetSolid', 'pipeShell', 'massProperties'], label: 'native sheetSolid' })(
  'sheetSolid node, hollow round sections with laws, volume consistency (native OCCT kernel)',
  () => {
    let kernel: IsolatedKernel;
    beforeAll(() => {
      kernel = createNativeTestKernel();
      setGeometryKernel(kernel);
    }, 120_000);
    afterAll(() => {
      setGeometryKernel(null);
      kernel.dispose();
    });

    const exactVolume = (entity: SweepEntity): number => {
      const shape = kernel.evaluate(recipeOf(entity));
      expect(shape, `${entity.id} builds`).not.toBeNull();
      return kernel.massProperties?.(shape as NonNullable<typeof shape>)?.volume ?? Number.NaN;
    };

    function sweep(params: Record<string, unknown>, doc: CadDocument = createEmptyDocument()): { entity: SweepEntity; doc: CadDocument } {
      const made = execute(doc, 'sweep_profile', params);
      expect(made.affected, made.summary).toHaveLength(1);
      return { entity: made.document.entities[made.affected[0] as string] as SweepEntity, doc: made.document };
    }

    const bar = [
      [0, 0, 0],
      [0, 0, 100],
    ];

    it('a bored tube with a linear scale law: outer minus bore, V = pi (R^2 - r^2) L (1 + s + s^2) / 3 within 1e-6', () => {
      const { entity } = sweep({ path: bar, radius: 4, innerRadius: 2, scale: { type: 'linear', start: 1, end: 0.5 } });
      const expected = (Math.PI * 12 * 100 * (1 + 0.5 + 0.25)) / 3;
      expect(relError(exactVolume(entity), expected)).toBeLessThan(1e-6);
      expect(relError(sweepAnalyticVolume(entity) as number, expected)).toBeLessThan(1e-9);
    });

    it('a bored tube with an area law shares one scale between wall and bore (the annulus area follows the law)', () => {
      const { entity } = sweep({ path: bar, radius: 4, innerRadius: 2, area: { type: 'linear', start: 12 * Math.PI, end: 3 * Math.PI } });
      const expected = (100 * (12 * Math.PI + 3 * Math.PI)) / 2;
      expect(relError(exactVolume(entity), expected)).toBeLessThan(1e-6);
    });

    it('a bored tube on a quarter bend and on a helix, with a law: the exact volume equals the closed form', () => {
      const bend = sweep({
        path: [
          [0, 0, 0],
          [60, 0, 0],
          [60, 60, 0],
        ],
        bendRadius: 20,
        radius: 5,
        innerRadius: 3,
        scale: { type: 's_curve', start: 1, end: 0.6 },
      });
      expect(relError(exactVolume(bend.entity), sweepAnalyticVolume(bend.entity) as number)).toBeLessThan(1e-5);
      const helix = execute(createEmptyDocument(), 'add_helix', { radius: 20, pitch: 10, turns: 3 });
      const coil = sweep(
        { pathId: helix.affected[0], radius: 2, innerRadius: 1, scale: { type: 'linear', start: 1, end: 0.5 } },
        helix.document,
      );
      expect(relError(exactVolume(coil.entity), sweepAnalyticVolume(coil.entity) as number)).toBeLessThan(1e-5);
    }, 120_000);

    it('a bored tube in a frame mode (binormal on a bend) is a sheetSolid too', () => {
      const { entity } = sweep({
        path: [
          [0, 0, 0],
          [60, 0, 0],
          [60, 60, 0],
        ],
        bendRadius: 20,
        radius: 5,
        innerRadius: 3,
        orientation: { mode: 'binormal', direction: [0, 0, 1] },
      });
      expect(relError(exactVolume(entity), sweepAnalyticVolume(entity) as number)).toBeLessThan(1e-5);
    });

    it('check_sweep_loft measures the exact volume against the integral of the section area on the pack plans (volumeConsistencyRel 1e-4)', () => {
      const context = { ...defaultContext(), kernel };
      const worst: number[] = [];
      for (const name of ['target_twist_scale_orientation', 'target_helix_spring_thread', 'target_rails_and_surface_mode']) {
        const plan = runSwgPlan(swgPlan(name));
        const result = execute(plan.document, 'check_sweep_loft', {}, context);
        const data = result.data as {
          findings: Array<{ code: string; entityId: string }>;
          volumeChecks: Array<{ entityId: string; relativeDeviation: number }>;
        };
        expect(
          data.findings.filter((finding) => finding.code === 'SWG_CHECK_VOLUME_MISMATCH'),
          name,
        ).toEqual([]);
        worst.push(...data.volumeChecks.map((check) => Math.abs(check.relativeDeviation)));
      }
      expect(worst.length).toBeGreaterThan(3);
      expect(Math.max(...worst)).toBeLessThan(1e-4);
    }, 120_000);
  },
);
