import { describe, expect, it } from 'vitest';
import {
  LEVEL_CULLED,
  LEVEL_OUTSIDE,
  boxInsideAllPlanes,
  bruteForceQuery,
  lodLevel,
  lodSwitchDistances,
  planRender,
  planScene,
  projectedPixels,
  prototypeKeyOf,
} from '@core/geometry/renderPlan';
import { type PlanCamera, frustumPlanes, framedPlanCamera, viewpointPlanCamera } from '@core/geometry/renderPlanCamera';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { SYN_RACK_BAYS, synRackCount, synRackDocument } from '../../helpers/synRack';

const OPTIONS = { multiDraw: true, quality: 'high' } as const;

function isoCamera(doc: CadDocument, projection: 'perspective' | 'orthographic' = 'perspective'): PlanCamera {
  const scene = planScene(doc);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { aabb } of scene.instances)
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], aabb.min[axis]);
      max[axis] = Math.max(max[axis], aabb.max[axis]);
    }
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  const camera = framedPlanCamera({ view: 'iso', projection, center, radius, widthPx: 1920, heightPx: 1080 });
  if (typeof camera === 'string') throw new Error(camera);
  return camera;
}

/** A camera 2 m from the first bay's flange joint of the DN100 pipe at y = -2100, looking along +Y. */
const closeUp = (): PlanCamera =>
  viewpointPlanCamera({ projection: 'perspective', eye: [300, -4000, 6411], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45 }, 1920, 1080);

describe('SYN-RACK-v1 (VC-VIS-20..21)', () => {
  it.each(SYN_RACK_BAYS)(
    'has N(n) components and at most 30 opaque model calls at n = %i',
    (bays) => {
      const doc = synRackDocument(bays);
      const scene = planScene(doc);
      expect(scene.instances.length).toBe(synRackCount(bays));
      expect(scene.prototypeKeys.length).toBe(13);
      expect(scene.materialClasses.length).toBe(4);
      for (const camera of [isoCamera(doc), isoCamera(doc, 'orthographic'), closeUp()]) {
        const plan = planRender(scene, camera, OPTIONS);
        expect(plan.componentCount).toBe(synRackCount(bays));
        expect(plan.opaqueModelCalls).toBeLessThanOrEqual(30);
        expect(plan.edgeCalls).toBeLessThanOrEqual(13);
        expect(plan.drawn + plan.culled.frustum + plan.culled.pixel).toBe(plan.componentCount);
      }
    },
    120_000,
  );

  it('does not depend on the per-instance colour (service colours never split a batch)', () => {
    const plain = synRackDocument(8);
    const coloured = synRackDocument(8, (pipe) => `#0${pipe}0${pipe}0${pipe}`);
    for (const camera of [isoCamera(plain), closeUp()]) {
      const a = planRender(planScene(plain), camera, OPTIONS);
      const b = planRender(planScene(coloured), camera, OPTIONS);
      expect(b.buckets.map(({ members: _members, ...rest }) => rest)).toEqual(a.buckets.map(({ members: _members, ...rest }) => rest));
      expect(b.opaqueModelCalls).toBe(a.opaqueModelCalls);
    }
  });

  it('draws the close-up of the first flange joint at LOD0 and merges far parts into per-class boxes', () => {
    const plan = planRender(planScene(synRackDocument(8)), closeUp(), OPTIONS);
    expect(plan.culled.frustum).toBeGreaterThan(0);
    expect(plan.buckets.some((bucket) => bucket.lod === 0)).toBe(true);
    const boxes = plan.buckets.filter((bucket) => bucket.lod === 2);
    expect(new Set(boxes.map((bucket) => bucket.materialClass)).size).toBe(boxes.length);
    expect(boxes.every((bucket) => bucket.prototypeKey === '$box')).toBe(true);
  });

  it('is deterministic and does not mutate the scene', () => {
    const doc = synRackDocument(8);
    const scene = planScene(doc);
    const before = JSON.stringify(scene.instances);
    const camera = isoCamera(doc);
    const a = planRender(scene, camera, OPTIONS);
    const b = planRender(scene, camera, OPTIONS);
    expect(b).toEqual(a);
    expect(JSON.stringify(scene.instances)).toBe(before);
  });
});

describe('LOD thresholds and hysteresis (VC-VIS-22)', () => {
  const diagonal = Math.hypot(90, 16, 16);

  it('reproduces the stud M16 switch distances of the benchmark', () => {
    expect(diagonal).toBeCloseTo(92.8009, 3);
    const d = lodSwitchDistances(92.8009, 1080, 45);
    expect(d.lod0to1 / 2520.462372717879).toBeCloseTo(1, 6);
    expect(d.lod1to2 / 15122.774236307274).toBeCloseTo(1, 6);
    expect(d.cull / 120982.19389045819).toBeCloseTo(1, 6);
    expect(d.lod1HoldDownTo / 2268.416135446091).toBeCloseTo(1, 6);
  });

  it('assigns the level from the projected size at the thresholds', () => {
    expect(lodLevel(48)).toBe(0);
    expect(lodLevel(47.999)).toBe(1);
    expect(lodLevel(8)).toBe(1);
    expect(lodLevel(7.999)).toBe(2);
    expect(lodLevel(1)).toBe(2);
    expect(lodLevel(0.999)).toBe(LEVEL_CULLED);
  });

  it('projects with the pinhole formula and the orthographic view height', () => {
    const camera = closeUp();
    const d = lodSwitchDistances(92.8009, 1080, 45);
    expect(projectedPixels(92.8009, d.lod0to1, camera)).toBeCloseTo(48, 6);
    const ortho: PlanCamera = { ...camera, projection: 'orthographic', viewHeight: 1080 };
    expect(projectedPixels(10, 12345, ortho)).toBeCloseTo(10, 9);
  });

  it('holds a level until d < d_i (1 - h) when approaching and switches coarser at the nominal distance', () => {
    const camera = closeUp();
    const { lod0to1, lod1to2, lod1HoldDownTo } = lodSwitchDistances(92.8009, 1080, 45);
    const at = (distance: number): number => projectedPixels(92.8009, distance, camera);
    expect(lodLevel(at(lod0to1 * 0.95), 1)).toBe(1);
    expect(lodLevel(at(lod1HoldDownTo * 1.0001), 1)).toBe(1);
    expect(lodLevel(at(lod1HoldDownTo * 0.9999), 1)).toBe(0);
    expect(lodLevel(at(lod0to1 * 0.95))).toBe(0);
    expect(lodLevel(at(lod0to1 * 1.001), 0)).toBe(1);
    expect(lodLevel(at(lod1to2 * 1.001), 1)).toBe(2);
    expect(lodLevel(at(lod1to2 * 0.95), 2)).toBe(2);
    expect(lodLevel(10, LEVEL_OUTSIDE)).toBe(1);
  });

  it('keeps the previous level inside the hysteresis band of a plan', () => {
    const doc = synRackDocument(8);
    const scene = planScene(doc);
    const camera = closeUp();
    const first = planRender(scene, camera, OPTIONS);
    const second = planRender(scene, camera, { ...OPTIONS, previousLevels: first.levels });
    expect(second.levels).toEqual(first.levels);
  });
});

describe('drawn + culled = N (VC-VIS-23)', () => {
  it('culls instances behind the camera and below one pixel, and counts them all', () => {
    const doc = synRackDocument(8);
    const scene = planScene(doc);
    const looksAway = viewpointPlanCamera(
      { projection: 'perspective', eye: [0, 0, 20000], direction: [0, 0, 1], up: [0, 1, 0], fovDeg: 45 },
      1920,
      1080,
    );
    const away = planRender(scene, looksAway, OPTIONS);
    expect(away.culled.frustum).toBe(scene.instances.length);
    expect(away.drawn).toBe(0);
    expect(away.opaqueModelCalls).toBe(0);
    const farAway = viewpointPlanCamera(
      { projection: 'perspective', eye: [0, 0, 9e7], direction: [0, 0, -1], up: [0, 1, 0], fovDeg: 45 },
      1920,
      1080,
    );
    const tiny = planRender(scene, farAway, OPTIONS);
    expect(tiny.culled.pixel).toBeGreaterThan(0);
    expect(tiny.drawn + tiny.culled.frustum + tiny.culled.pixel).toBe(scene.instances.length);
    expect([...tiny.levels].every((level) => level <= LEVEL_OUTSIDE)).toBe(true);
  });

  it('reports 80 bytes per drawn instance (76 + 4 state) plus geometry', () => {
    const plan = planRender(planScene(synRackDocument(8)), closeUp(), OPTIONS);
    expect(plan.gpuBytesEstimate).toBeGreaterThanOrEqual(plan.drawn * 80);
  });
});

describe('frustum query', () => {
  it('equals a plane-by-plane test of every AABB on random boxes (the BVH reference)', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const doc = createEmptyDocument();
    const entities: Record<string, Entity> = {};
    const order: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const id = `b${i}`;
      order.push(id);
      entities[id] = {
        id,
        kind: 'box',
        size: [1 + random() * 50, 1 + random() * 50, 1 + random() * 50],
        position: [random() * 4000 - 2000, random() * 4000 - 2000, random() * 4000 - 2000],
        rotation: [0, 0, 0],
        layerId: '0',
        color: '#fff',
      };
    }
    const scene = planScene({ ...doc, entities, order });
    const camera = viewpointPlanCamera(
      { projection: 'perspective', eye: [-3000, 0, 0], direction: [1, 0, 0], up: [0, 0, 1], fovDeg: 60 },
      800,
      600,
    );
    const planes = frustumPlanes(camera);
    const expected = scene.instances.flatMap((instance, index) => (boxInsideAllPlanes(instance.aabb, planes) ? [index] : []));
    expect(bruteForceQuery(scene.instances)(planes)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(100);
    expect(expected.length).toBeLessThan(10_000);
    const injected = planRender(scene, camera, { ...OPTIONS, query: () => expected.slice(0, 5) });
    expect(injected.culled.frustum).toBe(10_000 - 5);
  });

  it('orthographic planes bound the view rectangle', () => {
    const camera: PlanCamera = { ...closeUp(), projection: 'orthographic', viewHeight: 100, fovDeg: 0, widthPx: 200, heightPx: 100 };
    const planes = frustumPlanes(camera);
    const inside = { min: [290, -3990, 6400], max: [310, -3980, 6420] } as const;
    const outside = { min: [1000, -3990, 6400], max: [1010, -3980, 6420] } as const;
    expect(boxInsideAllPlanes({ min: [...inside.min], max: [...inside.max] }, planes)).toBe(true);
    expect(boxInsideAllPlanes({ min: [...outside.min], max: [...outside.max] }, planes)).toBe(false);
  });
});

describe('prototype keys and scene', () => {
  const box = (over: Partial<Entity> = {}): Entity =>
    ({ id: 'a', kind: 'box', size: [1, 2, 3], position: [0, 0, 0], rotation: [0, 0, 0], layerId: '0', color: '#000', ...over }) as Entity;

  it('ignores placement, colour, name and material; keeps shape parameters to 6 significant figures', () => {
    expect(prototypeKeyOf(box({ position: [5, 5, 5], color: '#fff', name: 'x', materialId: 'm' }))).toBe(prototypeKeyOf(box()));
    expect(prototypeKeyOf(box({ size: [1, 2, 3.00000001] } as Partial<Entity>))).toBe(prototypeKeyOf(box()));
    expect(prototypeKeyOf(box({ size: [1, 2, 3.1] } as Partial<Entity>))).not.toBe(prototypeKeyOf(box()));
  });

  it('keys meshes by their data and instances by component and scale', () => {
    const mesh = (positions: number[]): Entity =>
      ({ ...box(), kind: 'mesh', mesh: { positions, indices: [0, 1, 2] } }) as unknown as Entity;
    expect(prototypeKeyOf(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0]))).toBe(prototypeKeyOf(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0])));
    expect(prototypeKeyOf(mesh([0, 0, 0, 1, 0, 0, 0, 1, 0]))).not.toBe(prototypeKeyOf(mesh([0, 0, 0, 2, 0, 0, 0, 1, 0])));
    const instance = (scale?: [number, number, number]): Entity =>
      ({ ...box(), kind: 'instance', componentId: 'comp-1', ...(scale ? { scale } : {}) }) as unknown as Entity;
    expect(prototypeKeyOf(instance())).toBe('component:comp-1|[1,1,1]');
    expect(prototypeKeyOf(instance([2, 1, 1]))).not.toBe(prototypeKeyOf(instance()));
  });

  it('skips 2D shapes and entities on hidden layers, and batches a single-instance prototype per material class', () => {
    const doc = createEmptyDocument();
    const hiddenLayer = { id: 'h', name: 'H', visible: false, locked: false };
    const entities: Record<string, Entity> = {
      a: box({ id: 'a', materialId: 'steel' }),
      b: box({ id: 'b', materialId: 'steel' }),
      c: box({ id: 'c', size: [9, 9, 9], materialId: 'steel' } as Partial<Entity>),
      d: box({ id: 'd', layerId: 'h' }),
      e: {
        id: 'e',
        kind: 'line',
        start: [0, 0],
        end: [1, 1],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        layerId: '0',
        color: '#000',
      } as unknown as Entity,
    };
    const scene = planScene({ ...doc, entities, order: ['a', 'b', 'c', 'd', 'e'], layers: { ...doc.layers, h: hiddenLayer } });
    expect(scene.instances.map((instance) => instance.id)).toEqual(['a', 'b', 'c']);
    expect(scene.hiddenCount).toBe(1);
    const camera = viewpointPlanCamera(
      { projection: 'perspective', eye: [0, -10, 0], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45 },
      1920,
      1080,
    );
    const plan = planRender(scene, camera, OPTIONS);
    expect(plan.uniqueBatches).toEqual([{ materialClass: 'steel', members: [2] }]);
    expect(plan.buckets).toHaveLength(1);
    expect(plan.opaqueModelCalls).toBe(2);
    expect(planRender(scene, camera, { ...OPTIONS, multiDraw: false }).opaqueModelCalls).toBe(2);
    expect(planRender(scene, camera, { ...OPTIONS, quality: 'low' }).shadowCalls).toBe(0);
    expect(planRender(scene, camera, { ...OPTIONS, quality: 'medium' }).shadowCalls).toBe(4);
  });
});

describe('framed cameras', () => {
  const request = { view: 'iso', projection: 'perspective', center: [0, 0, 0], radius: 100, widthPx: 100, heightPx: 100 } as const;

  it('refuses a bad fov, radius or custom direction', () => {
    expect(framedPlanCamera({ ...request, fovDeg: 0 })).toMatch(/fovDeg/);
    expect(framedPlanCamera({ ...request, fovDeg: 180 })).toMatch(/fovDeg/);
    expect(framedPlanCamera({ ...request, radius: 0 })).toMatch(/radius/);
    expect(framedPlanCamera({ ...request, view: 'custom' })).toMatch(/direction/);
    expect(framedPlanCamera({ ...request, view: 'custom', direction: [0, 0, 0] })).toMatch(/direction/);
  });

  it('looks at the centre from every named view with a unit orthogonal basis', () => {
    for (const view of ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'] as const)
      for (const projection of ['perspective', 'orthographic'] as const) {
        const camera = framedPlanCamera({ ...request, view, projection });
        if (typeof camera === 'string') throw new Error(camera);
        const { direction: d, up: u } = camera;
        expect(Math.hypot(...d)).toBeCloseTo(1, 9);
        expect(Math.hypot(...u)).toBeCloseTo(1, 9);
        expect(d[0] * u[0] + d[1] * u[1] + d[2] * u[2]).toBeCloseTo(0, 9);
      }
    const custom = framedPlanCamera({ ...request, view: 'custom', direction: [0, 0, 5], projection: 'orthographic' });
    expect(typeof custom).toBe('object');
  });
});
