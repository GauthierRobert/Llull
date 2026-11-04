/** VIS-M8i: the optimised `planScene` equals the pre-optimisation implementation (tests/helpers/planSceneReference) bit for bit. */
import { describe, expect, it } from 'vitest';
import { planScene } from '@core/geometry/renderPlan';
import { type CadDocument, type Entity, type Vec3, DEFAULT_LAYER_ID, createEmptyDocument } from '@core/model/types';
import { referencePlanScene } from '../../helpers/planSceneReference';
import { synRackDocument } from '../../helpers/synRack';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const ROTATIONS: Vec3[] = [
  [0, 0, 0],
  [0, Math.PI / 2, 0],
  [Math.PI / 2, 0, 0],
  [0.3, -1.1, 2.2],
  [-0, 0, 0],
  [0, -0, 0.5],
];

/** A mixed document: every solid kind, near-equal parameters (one 6-significant-figure key, distinct boxes), signed zeros, hidden layer, classes. */
function randomDocument(seed: number, count: number): CadDocument {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const base = createEmptyDocument();
  const entities: Record<string, Entity> = {};
  const order: string[] = [];
  const near = (value: number): number => value + (random() < 0.5 ? 0 : value * 1e-9 * Math.floor(random() * 3));
  const radius = (): number => near(pick([10, 25.5, 100, 0]));
  const classOf: Record<string, string> = {};
  let rotation = pick(ROTATIONS);
  for (let index = 0; index < count; index++) {
    const id = `e${index}`;
    if (random() < 0.7) rotation = pick(ROTATIONS);
    const common = {
      id,
      position: [Math.floor(random() * 50) * 100, pick([0, -0, 7]), Math.floor(random() * 9)] as Vec3,
      rotation,
      layerId: random() < 0.1 ? 'hidden' : DEFAULT_LAYER_ID,
      color: '#808080',
      ...(random() < 0.7 ? { materialId: pick(['steel', 'pipe', 'concrete']) } : {}),
    };
    const shape = Math.floor(random() * 10);
    let entity: Entity;
    if (shape === 0) entity = { ...common, kind: 'box', size: [near(pick([1, 2, 3])), 2, near(pick([5, 6]))] };
    else if (shape === 1 || shape === 2) entity = { ...common, kind: 'cylinder', radius: radius(), height: near(pick([4, 40, 400])) };
    else if (shape === 3) entity = { ...common, kind: 'sphere', radius: radius() };
    else if (shape === 4) entity = { ...common, kind: 'cone', radius: radius(), height: near(pick([3, 30])) };
    else if (shape === 5) entity = { ...common, kind: 'torus', ringRadius: near(pick([20, 30])), tubeRadius: near(pick([2, 3])) };
    else if (shape === 6)
      entity = {
        ...common,
        kind: 'extrusion',
        profile: [
          [0, 0],
          [near(pick([4, 5])), 0],
          [0, 3],
        ],
        depth: pick([2, 3]),
      };
    else if (shape === 7)
      entity = {
        ...common,
        kind: 'revolution',
        profile: [
          [1, 0],
          [2, 3],
        ],
        axis: [0, 0, 1],
        angle: pick([Math.PI, 2 * Math.PI]),
        segments: 12,
      };
    else if (shape === 8)
      entity = { ...common, kind: 'mesh', mesh: { positions: [0, 0, 0, pick([1, 2]), 0, 0, 0, 1, 0], indices: [0, 1, 2] } };
    else entity = { ...common, kind: 'instance', componentId: 'comp', ...(random() < 0.5 ? { scale: [pick([1, 2]), 1, 1] as Vec3 } : {}) };
    entities[id] = entity;
    order.push(id);
    if (random() < 0.2) classOf[id] = pick(['galvanized_steel', 'concrete']);
  }
  const part: Entity = {
    id: 'p0',
    kind: 'box',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#fff',
    size: [1, 2, 3],
  };
  return {
    ...base,
    entities,
    order,
    layers: { ...base.layers, hidden: { id: 'hidden', name: 'Hidden', visible: false, locked: false } },
    components: { comp: { id: 'comp', name: 'Comp', entities: { p0: part }, order: ['p0'] } },
    display: { colourProfiles: {}, materialClassOf: classOf },
  };
}

describe('planScene equals the pre-VIS-M8i reference', () => {
  it.each([8, 44])('SYN-RACK-v1 with %i bays', (bays) => {
    const doc = synRackDocument(bays);
    expect(planScene(doc)).toEqual(referencePlanScene(doc));
  });

  it.each([1, 2, 3, 4])('random mixed scene, seed %i', (seed) => {
    const doc = randomDocument(seed, 700);
    const scene = planScene(doc);
    expect(scene).toEqual(referencePlanScene(doc));
    expect(scene.hiddenCount).toBeGreaterThan(0);
    expect(scene.prototypeKeys.length).toBeGreaterThan(10);
    expect(new Set(scene.instances.map((instance) => instance.diagonal)).size).toBeGreaterThan(20);
  });

  it('a document without class assignments takes the materialId path', () => {
    const { display: _display, ...rest } = randomDocument(9, 200);
    expect(planScene(rest)).toEqual(referencePlanScene(rest));
  });

  it('entities differing past the 6th significant figure share a prototype but keep their own box', () => {
    const cylinder = (id: string, radius: number): Entity => ({
      id,
      kind: 'cylinder',
      position: [0, 0, 0],
      rotation: [0, 0.4, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#fff',
      radius,
      height: 10,
    });
    const doc: CadDocument = {
      ...createEmptyDocument(),
      entities: { a: cylinder('a', 100.0000001), b: cylinder('b', 100.0000002) },
      order: ['a', 'b'],
    };
    const scene = planScene(doc);
    expect(scene.prototypeKeys).toHaveLength(1);
    expect(scene.instances[0]?.aabb).not.toEqual(scene.instances[1]?.aabb);
    expect(scene).toEqual(referencePlanScene(doc));
  });

  it('hostile entities: undefined params, signed zeros, NaN, reordered keys, 2D / curve / sheet, corrupt scale', () => {
    const base = { layerId: DEFAULT_LAYER_ID, color: '#fff' };
    const hostile = (entity: Record<string, unknown>): Entity => ({ ...base, ...entity }) as unknown as Entity;
    const entities: Entity[] = [
      hostile({ id: 'a', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], radius: 5, height: 9, extra: undefined }),
      hostile({ id: 'b', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], radius: 5, height: 9 }),
      hostile({ id: 'c', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], height: 9, radius: 5 }),
      hostile({ id: 'd', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], radius: -0, height: 9 }),
      hostile({ id: 'e', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], radius: 0, height: 9 }),
      hostile({ id: 'f', kind: 'cylinder', position: [1, 2, 3], rotation: [0, 0, 0], radius: NaN, height: 9 }),
      hostile({ id: 'g', kind: 'cylinder', position: [1, 2, 3], rotation: [0, 0, 0], radius: NaN, height: 9 }),
      hostile({ id: 'h', kind: 'cylinder', position: [0, 0, 0], rotation: [NaN, -0, 0], radius: 5, height: 9 }),
      hostile({ id: 'i', kind: 'cylinder', position: [0, 0, 0], rotation: [NaN, -0, 0], radius: 5, height: 9 }),
      hostile({ id: 'j', kind: 'box', position: [0, 0, 0], rotation: [0, -0, NaN], size: [1, 2, 3] }),
      hostile({ id: 'k', kind: 'line', position: [0, 0, 0], rotation: [0, 0, 0], start: [0, 0], end: [1, 1] }),
      hostile({ id: 'l', kind: 'nurbs_curve', position: [0, 0, 0], rotation: [0, 0, 0], curve: { degree: 1, poles: [], knots: [] } }),
      hostile({ id: 'm', kind: 'nurbs_surface', position: [0, 0, 0], rotation: [0, 0, 0], surface: {} }),
      hostile({ id: 'n', kind: 'instance', position: [0, 0, 0], rotation: [0, 0, 0], componentId: 'comp', scale: 'abc' }),
      hostile({ id: 'o', kind: 'instance', position: [0, 0, 0], rotation: [0, 0, 0], componentId: 'comp', scale: new Set([2, 1, 1]) }),
      hostile({ id: 'p', kind: 'instance', position: [0, 0, 0], rotation: [0, 0, 0], componentId: 'comp', scale: [1, 'x', 1] }),
    ];
    const source = randomDocument(11, 5);
    const doc: CadDocument = { ...source, entities: Object.fromEntries(entities.map((e) => [e.id, e])), order: entities.map((e) => e.id) };
    expect(planScene(doc)).toEqual(referencePlanScene(doc));
  });

  it('past the trie node cap (continuously varying parameters) keys and boxes still equal the reference', () => {
    const entities: Entity[] = Array.from({ length: 40_000 }, (_, index) => ({
      id: `v${index}`,
      kind: 'cylinder',
      position: [index, 0, 0],
      rotation: [0, 0.2, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#fff',
      radius: 10 + index * 0.001234,
      height: 5 + (index % 97) * 0.37,
    }));
    const doc: CadDocument = {
      ...createEmptyDocument(),
      entities: Object.fromEntries(entities.map((e) => [e.id, e])),
      order: entities.map((e) => e.id),
    };
    expect(planScene(doc)).toEqual(referencePlanScene(doc));
  });
});
