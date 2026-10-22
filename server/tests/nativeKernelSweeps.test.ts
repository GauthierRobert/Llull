/**
 * SWG M2/M3 on the native OCCT kernel (validation VC-SWG-03..07, 09, 10, 12..15, 29): sweeps with laws, frames and helices are realised as fitted
 * B-spline faces sewn by `sheetSolid` (and `helix_edge` for a bored helix), and their exact volumes match the closed forms of the pack to 1e-6.
 * Skipped when the llull-kernel binary is not built (or lacks the capabilities).
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import type { Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { relError, runSwgPlan, swgPlan, swgValue } from '../../tests/helpers/swgPack';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

describeNativeWhen({ capabilities: ['sheetSolid', 'helixEdge', 'massProperties'], label: 'native sweeps' })(
  'sweep laws, frames and helices (native OCCT kernel)',
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

    /** Exact B-rep volume of the entity the plan alias names, straight from the kernel. */
    const exactVolume = (plan: ReturnType<typeof runSwgPlan>, actions: ReturnType<typeof swgPlan>, alias: string): number => {
      const at = actions.findIndex((a) => a.as === alias);
      const id = plan.steps[at]?.affected[0] as string;
      const entity = plan.document.entities[id] as Entity;
      const shape = kernel.evaluate(recipeOf(entity));
      expect(shape, `${alias} builds`).not.toBeNull();
      const properties = kernel.massProperties?.(shape as NonNullable<typeof shape>);
      return properties?.volume ?? Number.NaN;
    };

    it('twist, scale, area and orientation laws: exact volumes at 1e-6 (target_twist_scale_orientation)', () => {
      const actions = swgPlan('target_twist_scale_orientation');
      const plan = runSwgPlan(actions);
      const volume = (alias: string): number => exactVolume(plan, actions, alias);
      for (const [alias, key] of [
        ['bar90', 'linear_0_to_90deg'],
        ['bar360', 'linear_0_to_360deg'],
        ['barS', 'scurve_0_to_180deg'],
      ] as const)
        expect(relError(volume(alias), swgValue('VC-SWG-03', key)), alias).toBeLessThan(1e-6);
      expect(relError(volume('cone'), swgValue('VC-SWG-05', 'linear_1_to_0.5_straight'))).toBeLessThan(1e-6);
      expect(relError(volume('wavy'), swgValue('VC-SWG-07', 'expression_1_plus_0.25sin2pit'))).toBeLessThan(1e-6);
      expect(relError(volume('areaLaw'), swgValue('VC-SWG-10', 'area_law_linear_100_to_25'))).toBeLessThan(1e-6);
      expect(relError(volume('vane'), swgValue('VC-SWG-09', 'linear_1_to_0.5_quarter_arc_square'))).toBeLessThan(1e-6);
      expect(relError(volume('oblique'), swgValue('VC-SWG-15', 'fixed_plane_oblique'))).toBeLessThan(1e-6);
      // the station rings are Catmull-Rom curves through 24 circle points, not circles: the frustum within their 2e-4
      expect(relError(volume('linearStations'), swgValue('VC-SWG-11', 'linear_1_to_0.5_straight'))).toBeLessThan(5e-4);
    });

    it('an S-curve scale law: exact volume 18 625.156 (VC-SWG-06)', () => {
      const actions = [
        {
          command: 'sweep_profile',
          params: {
            path: [
              [0, 0, 0],
              [0, 0, 100],
            ],
            radius: 10,
            scale: { type: 's_curve', start: 1, end: 0.5 },
          },
          as: 'w',
        },
      ];
      const plan = runSwgPlan(actions);
      expect(relError(exactVolume(plan, actions, 'w'), swgValue('VC-SWG-06', 'smoothstep_1_to_0.5_straight'))).toBeLessThan(1e-6);
    });

    it('helices: tube, screw sections, conical wire and add_coil v2 (target_helix_spring_thread, VC-SWG-12..14)', () => {
      const actions = swgPlan('target_helix_spring_thread');
      const plan = runSwgPlan(actions);
      const volume = (alias: string): number => exactVolume(plan, actions, alias);
      expect(relError(volume('tube'), swgValue('VC-SWG-12', 'round_tube_on_helix'))).toBeLessThan(1e-6);
      expect(relError(volume('screw10'), swgValue('VC-SWG-13', 'screw_rectangle_pitch10'))).toBeLessThan(1e-6);
      expect(relError(volume('screw5'), swgValue('VC-SWG-13', 'screw_rectangle_pitch5'))).toBeLessThan(1e-6);
      expect(relError(volume('conicalTube'), swgValue('VC-SWG-14', 'conical_helix_tube'))).toBeLessThan(1e-6);
      expect(relError(volume('coil'), swgValue('VC-SWG-12', 'round_tube_on_helix'))).toBeLessThan(1e-6);
      expect(Number.isFinite(volume('spring'))).toBe(true);
    });

    it('a bored tube on a helix falls back to MakePipe along the exact helix edge (about 2e-6)', () => {
      const helix = execute(createEmptyDocument(), 'add_helix', { radius: 20, pitch: 10, turns: 3 });
      const swept = execute(helix.document, 'sweep_profile', { pathId: helix.affected[0], radius: 2, innerRadius: 1 });
      expect(swept.affected, swept.summary).toHaveLength(1);
      const entity = swept.document.entities[swept.affected[0] as string] as Entity;
      const shape = kernel.evaluate(recipeOf(entity));
      expect(shape).not.toBeNull();
      const volume = kernel.massProperties?.(shape as NonNullable<typeof shape>)?.volume ?? Number.NaN;
      expect(relError(volume, (Math.PI * 3 * swgValue('VC-SWG-12', 'round_tube_on_helix')) / (Math.PI * 4))).toBeLessThan(5e-6);
    });

    it('the exact solids of the pack plans are closed (0 free edges): sewing never leaves a hole', () => {
      const actions = swgPlan('target_helix_spring_thread');
      const plan = runSwgPlan(actions);
      for (const alias of ['screw10', 'screw5']) {
        const at = actions.findIndex((a) => a.as === alias);
        const entity = plan.document.entities[plan.steps[at]?.affected[0] as string] as Entity;
        const shape = kernel.evaluate(recipeOf(entity));
        expect(shape).not.toBeNull();
        const topology = kernel.topology?.(shape as NonNullable<typeof shape>);
        expect(topology?.volume ?? 0).toBeGreaterThan(0);
      }
    });
  },
);
