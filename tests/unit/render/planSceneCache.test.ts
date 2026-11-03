import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { planSceneOf } from '@core/geometry/planSceneCache';
import { planRender, planScene } from '@core/geometry/renderPlan';
import { framedPlanCamera, viewpointPlanCamera } from '@core/geometry/renderPlanCamera';
import { createEmptyDocument } from '@core/model/types';
import { SYN_RACK_BAYS, synRackDocument } from '../../helpers/synRack';

const OPTIONS = { multiDraw: true, quality: 'high' } as const;
const doc = synRackDocument(SYN_RACK_BAYS[1] as number);
const parameters = { view: 'iso', width: 1920, height: 1080, projection: 'perspective' } as const;

describe('planSceneOf (VIS-M7)', () => {
  it('memoizes the scene per document object and equals planScene', () => {
    const first = planSceneOf(doc);
    expect(planSceneOf(doc).scene).toBe(first.scene);
    expect(first.scene).toEqual(planScene(doc));
    expect(planSceneOf({ ...doc }).scene).not.toBe(first.scene);
  });

  it('builds the BVH query on the second call only, and only from the threshold', () => {
    const fresh = { ...doc };
    expect(planSceneOf(fresh, 0).query).toBeUndefined();
    expect(planSceneOf(fresh, 0).query).toBeTypeOf('function');
    const small = { ...doc };
    planSceneOf(small);
    expect(planSceneOf(small).query).toBeUndefined();
  });

  it('plans identically through the BVH query and the brute-force scan (all cameras)', () => {
    const fresh = { ...doc };
    planSceneOf(fresh, 0);
    const { scene, query } = planSceneOf(fresh, 0);
    expect(query).toBeDefined();
    const cameras = [
      framedPlanCamera({ view: 'iso', projection: 'perspective', center: [0, 0, 0], radius: 5000, widthPx: 1920, heightPx: 1080 }),
      viewpointPlanCamera(
        { projection: 'perspective', eye: [300, -4000, 6411], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45 },
        1920,
        1080,
      ),
      viewpointPlanCamera(
        { projection: 'orthographic', eye: [0, -9000, 3000], direction: [0, 1, 0], up: [0, 0, 1], viewHeight: 2500 },
        800,
        600,
      ),
    ];
    for (const camera of cameras) {
      if (typeof camera === 'string') throw new Error(camera);
      const brute = planRender(scene, camera, OPTIONS);
      const viaBvh = planRender(scene, camera, { ...OPTIONS, ...(query ? { query } : {}) });
      expect(viaBvh).toEqual(brute);
    }
  });

  it('render_stats answers the same on a repeated call and does not change the document', () => {
    const fresh = { ...doc };
    const before = JSON.stringify(fresh.order);
    const a = execute(fresh, 'render_stats', parameters);
    const b = execute(fresh, 'render_stats', parameters);
    expect(b.summary).toBe(a.summary);
    expect(b.document).toBe(fresh);
    expect(JSON.stringify(fresh.order)).toBe(before);
  });

  it('an empty document has an empty scene and no BVH query below the threshold', () => {
    const empty = createEmptyDocument();
    expect(planSceneOf(empty).scene.instances).toEqual([]);
    expect(planSceneOf(empty).query).toBeUndefined();
    expect(planSceneOf(empty, 0).query).toBeTypeOf('function');
  });
});
