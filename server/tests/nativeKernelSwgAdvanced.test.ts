/**
 * SWG M4-M8 on the native OCCT kernel (validation VC-SWG-16, 17, 19, 21, 22, 35, 36, 37, 38): rails, advanced lofts (end conditions, alignment,
 * centreline, arc-length coupling, closed, point ends), mitre corners and laws on closed paths are sewn from NURBS faces by `sheetSolid` and
 * measured at 1e-6. Skipped when the llull-kernel binary is not built (or lacks the capabilities).
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import type { CadDocument, Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { composeEulerXYZ } from '@lib/eulerRotation';
import { orientedFrames } from '@core/geometry/sweepEval/frames';
import { relError, runSwgPlan, swgCase, swgPlan, swgValue } from '../../tests/helpers/swgPack';
import { createNativeTestKernel, describeNativeWhen } from './kernelTestSupport';
import type { IsolatedKernel } from '../src/isolatedKernel';

describeNativeWhen({ capabilities: ['sheetSolid', 'pipeShell', 'massProperties'], label: 'native SWG advanced' })(
  'rails, advanced lofts, mitre and closed sweeps (native OCCT kernel)',
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

    const volumeOfEntity = (entity: Entity): number => {
      const shape = kernel.evaluate(recipeOf(entity));
      expect(shape, `${entity.id} builds`).not.toBeNull();
      return kernel.massProperties?.(shape as NonNullable<typeof shape>)?.volume ?? Number.NaN;
    };
    const planVolume = (plan: ReturnType<typeof runSwgPlan>, actions: ReturnType<typeof swgPlan>, alias: string): number => {
      const at = actions.findIndex((a) => a.as === alias);
      return volumeOfEntity(plan.document.entities[plan.steps[at]?.affected[0] as string] as Entity);
    };
    const created = (doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; entity: Entity } => {
      const result = execute(doc, command, params);
      expect(result.affected, result.summary).toHaveLength(1);
      return { doc: result.document, entity: result.document.entities[result.affected[0] as string] as Entity };
    };

    it('rails: two rails scale (VC-16), maintainHeight (VC-17) and one rail (VC-35) at 1e-6', () => {
      const actions = swgPlan('target_rails_and_surface_mode').filter(
        (a) => a.command !== 'sweep_surface' && a.command !== 'check_sweep_loft' && a.command !== 'measure_area',
      );
      const plan = runSwgPlan(actions);
      expect(relError(planVolume(plan, actions, 'twoRail'), swgValue('VC-SWG-16', 'two_rails_uniform_scale'))).toBeLessThan(1e-6);
      expect(relError(planVolume(plan, actions, 'twoRailHeight'), swgValue('VC-SWG-17', 'two_rails_maintain_height'))).toBeLessThan(1e-6);
      expect(relError(planVolume(plan, actions, 'oneRail'), swgValue('VC-SWG-35', 'linear_1_to_0.5_straight'))).toBeLessThan(1e-6);
    });

    it('lofts of the pack plan: normal ends (VC-21, m = 1 and 2), seam alignment (VC-19) and the centreline elbow (VC-22)', () => {
      const actions = swgPlan('target_loft_conditions_alignment').filter((a) => a.command !== 'check_sweep_loft');
      const plan = runSwgPlan(actions);
      expect(relError(planVolume(plan, actions, 'bottle'), swgValue('VC-SWG-21', 'normal_both_ends_m1'))).toBeLessThan(1e-6);
      expect(relError(planVolume(plan, actions, 'bottle2'), swgValue('VC-SWG-22', 'normal_both_ends_m2'))).toBeLessThan(1e-6);
      const twisted = swgCase('VC-SWG-19').values as Record<string, number>;
      expect(relError(planVolume(plan, actions, 'hyperboloid90'), twisted['ruled_circles_twist_90deg'] as number)).toBeLessThan(1e-6);
      expect(relError(planVolume(plan, actions, 'cylinderAligned'), twisted['ruled_circles_twist_0deg'] as number)).toBeLessThan(1e-6);
      expect(relError(planVolume(plan, actions, 'elbowLoft'), swgValue('VC-SWG-22', 'centreline_quarter_arc'))).toBeLessThan(1e-4);
    });

    it('arc-length coupling of a square to a circle (VC-37, 4 faces) and squares one corner apart (VC-36)', () => {
      const square = created(createEmptyDocument(), 'create_nurbs_curve', {
        degree: 1,
        poles: [
          [10, -10, 0],
          [10, 10, 0],
          [-10, 10, 0],
          [-10, -10, 0],
          [10, -10, 0],
        ],
      });
      const r = 10;
      const circle = created(square.doc, 'create_nurbs_curve', {
        degree: 2,
        poles: [
          [r, 0, 50],
          [r, r, 50],
          [0, r, 50],
          [-r, r, 50],
          [-r, 0, 50],
          [-r, -r, 50],
          [0, -r, 50],
          [r, -r, 50],
          [r, 0, 50],
        ],
        weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
        knots: [0, 0.25, 0.5, 0.75, 1],
        multiplicities: [3, 2, 2, 2, 3],
      });
      const coupled = created(circle.doc, 'loft_sections', {
        sectionIds: [square.entity.id, circle.entity.id],
        ruled: true,
        alignment: 'auto',
        coupling: 'arc_length',
      });
      expect(relError(volumeOfEntity(coupled.entity), swgValue('VC-SWG-37', 'ruled_square20_to_circle10_arc_length'))).toBeLessThan(1e-5);
      const corners = [
        [5, -5],
        [5, 5],
        [-5, 5],
        [-5, -5],
      ];
      const at = (z: number, start: number): Record<string, unknown> => ({
        section: corners.map((_, i) => corners[(i + start) % 4]),
        center: [0, 0, z],
      });
      const none = created(createEmptyDocument(), 'loft_sections', { sections: [at(0, 0), at(50, 1)], ruled: true, alignment: 'none' });
      expect(relError(volumeOfEntity(none.entity), swgValue('VC-SWG-36', 'square_seam_off_by_one_corner'))).toBeLessThan(1e-6);
      const auto = created(createEmptyDocument(), 'loft_sections', { sections: [at(0, 0), at(50, 1)], ruled: true, alignment: 'auto' });
      expect(relError(volumeOfEntity(auto.entity), 5000)).toBeLessThan(1e-6);
    });

    it('a loft closed to a point at one end is one cap, a closed loft none: both are valid solids', () => {
      const circle = (z: number, r: number): Record<string, unknown> => ({ center: [0, 0, z], radius: r });
      const tip = created(createEmptyDocument(), 'loft_sections', {
        sections: [circle(0, 10), circle(30, 6)],
        endCondition: { type: 'point', at: [0, 0, 60] },
      });
      const tipVolume = volumeOfEntity(tip.entity);
      expect(tipVolume).toBeGreaterThan(0);
      expect(tipVolume).toBeLessThan(Math.PI * 100 * 60);
      const duct = created(createEmptyDocument(), 'loft_sections', {
        sections: Array.from({ length: 8 }, (_, k) => ({
          center: [60 * Math.cos((k * Math.PI) / 4), 60 * Math.sin((k * Math.PI) / 4), 0],
          rotation: composeEulerXYZ([0, 0, (k * Math.PI) / 4], [Math.PI / 2, 0, 0]),
          radius: 8,
        })),
        closed: true,
      });
      expect(volumeOfEntity(duct.entity)).not.toBeNaN();
    });

    it('mitre corners: the round section keeps A (L1 + L2) (VC-SWG-38)', () => {
      const mitred = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [100, 0, 0],
          [100, 100, 0],
        ],
        radius: 5,
        corners: 'miter',
      });
      expect(relError(volumeOfEntity(mitred.entity), 15707.9632679)).toBeLessThan(1e-6);
    });

    it('laws round a closed path are sewn without caps: a torus with a wobbling radius', () => {
      const ring = created(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 50 });
      const swept = created(ring.doc, 'sweep_profile', {
        pathId: ring.entity.id,
        radius: 5,
        scale: { type: 'expression', expression: '1 + 0.25*sin(2*pi*t)' },
      });
      const expected = 2 * Math.PI * 50 * Math.PI * 25 * (1 + 0.25 ** 2 / 2);
      expect(relError(volumeOfEntity(swept.entity), expected)).toBeLessThan(1e-5);
    });

    it('a scale law along line - arc - line (a pipe elbow) is fitted run by run: volume A L (s0^2 + s0 s1 + s1^2) / 3 to 1e-6', () => {
      const elbow = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [100, 0, 0],
          [100, 100, 0],
        ],
        bendRadius: 20,
        radius: 5,
        scale: { type: 'linear', start: 1, end: 0.8 },
      });
      const length = 160 + (Math.PI * 20) / 2;
      expect(relError(volumeOfEntity(elbow.entity), (Math.PI * 25 * length * (1 + 0.8 + 0.64)) / 3)).toBeLessThan(1e-6);
    });

    it('a 2:1 taper along line - arc - line is not fat in the middle: volume A L (s0^2 + s0 s1 + s1^2) / 3 to 1e-6 (pipe shell or fitted faces)', () => {
      const taper = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [100, 0, 0],
          [100, 100, 0],
        ],
        bendRadius: 20,
        radius: 5,
        scale: { type: 'linear', start: 1, end: 0.5 },
      });
      const length = 160 + (Math.PI * 20) / 2;
      expect(relError(volumeOfEntity(taper.entity), (Math.PI * 25 * length * (1 + 0.5 + 0.25)) / 3)).toBeLessThan(1e-6);
    });

    /**
     * Largest misfit, relative to the rectangle half sizes, between the kernel solid's vertices and the evaluator's rectangle. Each vertex is seen in
     * the evaluator frame interpolated at its foot point on the spine (the point of the nearest frame segment with zero offset along the tangent).
     */
    const boundaryMisfit = (sweep: Extract<Entity, { kind: 'sweep' }>, halfX: number, halfY: number): number => {
      const shape = kernel.evaluate(recipeOf(sweep));
      expect(shape).not.toBeNull();
      const mesh = kernel.tessellate(shape as NonNullable<typeof shape>);
      const frames = orientedFrames(sweep.path, sweep.orientation, 64);
      expect(mesh !== null && Array.isArray(frames)).toBe(true);
      if (mesh === null || !Array.isArray(frames)) return Number.NaN;
      type Triple = readonly [number, number, number];
      const dot = (p: Triple, q: Triple): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
      const minus = (p: Triple, q: Triple): Triple => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
      const mix = (p: Triple, q: Triple, t: number): Triple => [
        p[0] + (q[0] - p[0]) * t,
        p[1] + (q[1] - p[1]) * t,
        p[2] + (q[2] - p[2]) * t,
      ];
      let worst = 0;
      for (let k = 0; k < mesh.positions.length; k += 3) {
        const v: Triple = [mesh.positions[k] as number, mesh.positions[k + 1] as number, mesh.positions[k + 2] as number];
        let best: { off: number; t: number; i: number } | null = null;
        for (let i = 0; i + 1 < frames.length; i++) {
          const [p, q] = [frames[i]!.point, frames[i + 1]!.point];
          const d = minus(q, p);
          const t = Math.min(1, Math.max(0, dot(minus(v, p), d) / dot(d, d)));
          const off = Math.hypot(...minus(v, mix(p, q, t)));
          if (best === null || off < best.off) best = { off, t, i };
        }
        if (best === null || best.off > Math.hypot(halfX, halfY) * 1.01) continue;
        const [f, g] = [frames[best.i]!, frames[best.i + 1]!];
        const r = minus(v, mix(f.point, g.point, best.t));
        const [x, y] = [dot(r, mix(f.normal, g.normal, best.t)), dot(r, mix(f.binormal, g.binormal, best.t))];
        const boundary = Math.max(Math.abs(x) / halfX, Math.abs(y) / halfY);
        if (boundary > 0.7) worst = Math.max(worst, Math.abs(boundary - 1));
      }
      return worst;
    };

    it('VC-SWG-25b: a rectangle along a 3D spline is built in the evaluator frames', () => {
      const rect = [
        [-5, -1],
        [5, -1],
        [5, 1],
        [-5, 1],
      ];
      const spline = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [60, 0, 30],
          [100, 50, 10],
          [150, 60, 60],
        ],
        smooth: true,
        section: rect,
      }).entity as Extract<Entity, { kind: 'sweep' }>;
      expect(boundaryMisfit(spline, 5, 1)).toBeLessThan(1e-4);
    });

    it('a homothetic scale law runs through MakePipeShell or the fitted faces: the cone volume is exact either way', () => {
      const cone = created(createEmptyDocument(), 'sweep_profile', {
        path: [
          [0, 0, 0],
          [0, 0, 100],
        ],
        radius: 10,
        scale: { type: 'linear', start: 1, end: 0.5 },
      });
      expect(relError(volumeOfEntity(cone.entity), swgValue('VC-SWG-05', 'linear_1_to_0.5_straight'))).toBeLessThan(1e-6);
    });
  },
);
