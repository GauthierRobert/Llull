import { describe, expect, it } from 'vitest';
import { compareCodepoint, lodSwitchDistances, planRender, planScene, prototypeKeyOf } from '@core/geometry/renderPlan';
import { type PlanCamera, framedPlanCamera, planCameraProblem, viewpointPlanCamera } from '@core/geometry/renderPlanCamera';
import { createEmptyDocument, type Entity } from '@core/model/types';

const OPTIONS = { multiDraw: true, quality: 'high' } as const;

const hand = (id: string, size: [number, number, number], position: [number, number, number], materialId = 'steel'): Entity =>
  ({ id, kind: 'box', size, position, rotation: [0, 0, 0], layerId: '0', color: '#000', materialId }) as Entity;

const handScene = (entities: Entity[], classOf?: (entity: Entity) => string): ReturnType<typeof planScene> => {
  const doc = createEmptyDocument();
  return planScene({ ...doc, entities: Object.fromEntries(entities.map((e) => [e.id, e])), order: entities.map((e) => e.id) }, classOf);
};

const lookingAlongY = (distance: number): PlanCamera =>
  viewpointPlanCamera({ projection: 'perspective', eye: [0, -distance, 0], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45 }, 1920, 1080);

const boxes = (): ReturnType<typeof planScene> => handScene([hand('a', [10, 10, 10], [0, 0, 0]), hand('b', [10, 10, 10], [0, 0, 0])]);

describe('render plan review fixes', () => {
  it('holds LOD1 inside the hysteresis band while a fresh plan gives LOD0', () => {
    const scene = boxes();
    const { lod0to1, lod1HoldDownTo } = lodSwitchDistances(Math.hypot(10, 10, 10), 1080, 45);
    const inBand = lookingAlongY((lod0to1 + lod1HoldDownTo) / 2);
    expect([...planRender(scene, inBand, OPTIONS).levels]).toEqual([0, 0]);
    expect([...planRender(scene, inBand, { ...OPTIONS, previousLevels: new Uint8Array([1, 1]) }).levels]).toEqual([1, 1]);
    const below = planRender(scene, lookingAlongY(lod1HoldDownTo * 0.99), { ...OPTIONS, previousLevels: new Uint8Array([1, 1]) });
    expect([...below.levels]).toEqual([0, 0]);
  });

  it('reports the exact gpuBytesEstimate of a hand-built scene: 80 B per drawn instance + 72 B per triangle of each drawn geometry', () => {
    const plan = planRender(boxes(), lookingAlongY(100), OPTIONS);
    expect(plan.drawn).toBe(2);
    expect(plan.triangles).toBe(24);
    expect(plan.gpuBytesEstimate).toBe(2 * 80 + 12 * 72);
  });

  it('accepts a query returning unsorted, duplicated indices', () => {
    const scene = handScene([
      hand('a', [10, 10, 10], [0, 0, 0]),
      hand('b', [10, 10, 10], [50, 0, 0]),
      hand('c', [10, 10, 10], [100, 0, 0]),
    ]);
    const camera = lookingAlongY(100);
    const messy = planRender(scene, camera, { ...OPTIONS, query: () => [2, 0, 2, 1, 0] });
    const clean = planRender(scene, camera, { ...OPTIONS, query: () => [0, 1, 2] });
    expect(messy).toEqual(clean);
    expect(messy.culled.frustum).toBe(0);
  });

  it('refuses a non-finite or malformed camera', () => {
    const good = lookingAlongY(100);
    expect(planCameraProblem(good)).toBeNull();
    for (const bad of [
      { ...good, eye: [Number.NaN, 0, 0] },
      { ...good, direction: [0, 0, 0] },
      { ...good, fovDeg: Number.NaN },
      { ...good, projection: 'orthographic', viewHeight: 0 },
      { ...good, widthPx: 0 },
      { ...good, up: [1, 2] },
    ] as unknown as PlanCamera[]) {
      expect(planCameraProblem(bad)).not.toBeNull();
      expect(() => planRender(boxes(), bad, OPTIONS)).toThrow(RangeError);
    }
    const base = { projection: 'perspective', radius: 1, widthPx: 1, heightPx: 1 } as const;
    expect(framedPlanCamera({ ...base, view: 'custom', center: [0, 0, 0], direction: [1, 2] as never })).toMatch(/direction/);
    expect(framedPlanCamera({ ...base, view: 'iso', center: [1] as never })).toMatch(/target/);
  });

  it('orders by code unit, independent of locale', () => {
    expect(compareCodepoint('B', 'a')).toBe(-1);
    expect(compareCodepoint('a', 'a')).toBe(0);
    expect(compareCodepoint('b', 'a')).toBe(1);
  });

  it('keys object parameters independently of property order, and meshes by sha256', () => {
    const a = { ...hand('a', [1, 2, 3], [0, 0, 0]), extra: { x: 1, y: 2 } } as unknown as Entity;
    const b = { ...hand('a', [1, 2, 3], [0, 0, 0]), extra: { y: 2, x: 1 } } as unknown as Entity;
    expect(prototypeKeyOf(a)).toBe(prototypeKeyOf(b));
    const mesh = { ...hand('m', [1, 1, 1], [0, 0, 0]), kind: 'mesh', mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] } };
    expect(prototypeKeyOf(mesh as unknown as Entity)).toMatch(/^mesh\|[0-9a-f]{64}$/);
  });

  it('property: random scenes keep drawn + culled = N and both call bounds', () => {
    let seed = 20261103;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let round = 0; round < 40; round++) {
      const sizes = [5, 20, 80, 300, 1200].slice(0, 2 + Math.floor(random() * 4));
      const entities: Entity[] = [];
      for (let i = 0; i < 20 + Math.floor(random() * 200); i++) {
        const size = sizes[Math.floor(random() * sizes.length)] ?? 5;
        const materialClass = ['a', 'b', 'c'][Math.floor(random() * 3)] ?? 'a';
        entities.push(hand(`e${i}`, [size, size, size], [random() * 4000 - 2000, random() * 4000 - 2000, random() * 400], materialClass));
      }
      const camera = viewpointPlanCamera(
        {
          projection: 'perspective',
          eye: [random() * 6000 - 3000, -3000 - random() * 5000, 500],
          direction: [random() - 0.5, 1, random() - 0.5],
          up: [0, 0, 1],
          fovDeg: 30 + random() * 60,
        },
        1920,
        1080,
      );
      for (const multiDraw of [true, false]) {
        const general = handScene(entities);
        const plan = planRender(general, camera, { ...OPTIONS, multiDraw });
        expect(plan.drawn + plan.culled.frustum + plan.culled.pixel).toBe(entities.length);
        const pairs = new Set(plan.buckets.filter((b) => b.lod < 2).map((b) => `${b.prototypeKey}|${b.materialClass}`)).size;
        const uniqueDrawn = plan.uniqueBatches.reduce((sum, b) => sum + b.members.length, 0);
        const uniqueCalls = multiDraw ? plan.uniqueBatches.length : uniqueDrawn;
        expect(plan.opaqueModelCalls).toBeLessThanOrEqual(2 * pairs + general.materialClasses.length + uniqueCalls);
      }
      const byPrototype = handScene(entities, (entity) => `class-of-${prototypeKeyOf(entity)}`);
      const single = planRender(byPrototype, camera, OPTIONS);
      const repeated = byPrototype.prototypeCounts.filter((count) => count > 1).length;
      expect(single.opaqueModelCalls).toBeLessThanOrEqual(2 * repeated + byPrototype.materialClasses.length + single.uniqueBatches.length);
    }
  });
});
