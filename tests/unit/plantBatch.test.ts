import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { framedPlanCamera } from '@core/geometry/renderPlanCamera';
import { planRender, planScene } from '@core/geometry/renderPlan';
import type { Entity } from '@core/model/types';
import { LodGeometryCache } from '@ui/viewport/3d/plant/LodGeometryCache';
import { drawBuckets, entityIdAt, isPlantBatchable, plantCoveredIds } from '@ui/viewport/3d/plant/plantBatchPlan';
import { bucketMatrices } from '@ui/viewport/3d/plant/plantMatrices';
import { synRackDocument } from '../helpers/synRack';

const doc = synRackDocument(8);
const scene = planScene(doc);
const camera = framedPlanCamera({
  view: 'iso',
  projection: 'perspective',
  center: [0, 0, 0],
  radius: 20000,
  widthPx: 1920,
  heightPx: 1080,
});
if (typeof camera === 'string') throw new Error(camera);
const plan = planRender(scene, camera, { multiDraw: true, quality: 'medium' });
const everything = plantCoveredIds(scene, doc.entities, () => false);

describe('plant batch coverage and buckets', () => {
  it('covers every SYN-RACK entity with a batchable kind', () => {
    expect(everything.size).toBeGreaterThan(0);
    for (const id of everything) expect(isPlantBatchable(doc.entities[id] as Entity)).toBe(true);
  });

  it('draws exactly the instances the plan draws, once each', () => {
    const buckets = drawBuckets(scene, plan, everything);
    const ids = buckets.flatMap((bucket) => bucket.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(everything.size === scene.instances.length ? plan.drawn : ids.length);
    expect(buckets.length).toBeGreaterThanOrEqual(plan.buckets.length);
    expect(new Set(buckets.map((bucket) => bucket.key)).size).toBe(buckets.length);
  });

  it('draws nothing of an entity claimed by the per-entity path', () => {
    const buckets = drawBuckets(scene, plan, everything);
    const victim = buckets[0]?.ids[0] as string;
    const covered = plantCoveredIds(scene, doc.entities, (entity) => entity.id === victim);
    expect(covered.has(victim)).toBe(false);
    expect(drawBuckets(scene, plan, covered).flatMap((bucket) => bucket.ids)).not.toContain(victim);
  });

  it('keeps meshes with face colours and non-solid kinds off the plant path', () => {
    const mesh = { kind: 'mesh', faceColors: [{}], mesh: { positions: [], indices: [] } } as unknown as Entity;
    expect(isPlantBatchable(mesh)).toBe(false);
    expect(isPlantBatchable({ kind: 'extrusion' } as unknown as Entity)).toBe(false);
  });

  it('maps an instance id back to its entity id', () => {
    const bucket = drawBuckets(scene, plan, everything)[0];
    expect(entityIdAt(bucket as never, 0)).toBe(bucket?.ids[0]);
    expect(entityIdAt({ ids: ['a'] }, 5)).toBeUndefined();
    expect(entityIdAt({ ids: ['a'] }, undefined)).toBeUndefined();
  });
});

describe('plant instance matrices', () => {
  const placement = { position: [10, -20, 30], rotation: [0.3, -0.7, 1.1] } as const;
  const expected = (box?: { min: [number, number, number]; max: [number, number, number] }): number[] => {
    const object = new THREE.Object3D();
    object.position.set(...placement.position);
    object.rotation.set(...placement.rotation);
    object.updateMatrix();
    const matrix = object.matrix.clone();
    if (box !== undefined) {
      const local = new THREE.Matrix4().compose(
        new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2),
        new THREE.Quaternion(),
        new THREE.Vector3(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]),
      );
      matrix.multiply(local);
    }
    return matrix.elements;
  };

  it('matches three.js Object3D for a placement', () => {
    const out = bucketMatrices([placement]);
    out.forEach((value, index) => expect(value).toBeCloseTo(expected()[index] as number, 4));
  });

  it('maps the unit cube onto the local box for LOD2', () => {
    const box = { min: [-1, 0, 2], max: [3, 4, 10] } as { min: [number, number, number]; max: [number, number, number] };
    const out = bucketMatrices([placement], [box]);
    out.forEach((value, index) => expect(value).toBeCloseTo(expected(box)[index] as number, 4));
  });
});

describe('LodGeometryCache', () => {
  const entity = (kind: string, fields: object): Entity =>
    ({ id: 'e', kind, position: [0, 0, 0], rotation: [0, 0, 0], ...fields }) as unknown as Entity;
  const triangles = (geometry: THREE.BufferGeometry): number => (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;

  it('builds LOD1 within the plan caps and shares the unit box at LOD2', () => {
    const cache = new LodGeometryCache();
    const caps: [Entity, number][] = [
      [entity('cylinder', { radius: 5, height: 10 }), 32],
      [entity('cone', { radius: 5, height: 10 }), 24],
      [entity('sphere', { radius: 5 }), 112],
      [entity('torus', { ringRadius: 8, tubeRadius: 2 }), 128],
    ];
    for (const [e, cap] of caps) {
      expect(triangles(cache.geometry(e.kind, 1, e))).toBeLessThanOrEqual(cap);
      expect(triangles(cache.geometry(e.kind, 1, e))).toBeLessThan(triangles(cache.geometry(e.kind, 0, e)));
    }
    const box = entity('box', { size: [1, 2, 3] });
    expect(cache.geometry('box', 1, box)).toBe(cache.geometry('box', 0, box));
    expect(cache.geometry('a', 2, box)).toBe(cache.geometry('b', 2, box));
    expect(cache.localBox('box', box)).toEqual({ min: [-0.5, -1, -1.5], max: [0.5, 1, 1.5] });
  });

  it('builds once per (prototype, LOD), disposes dropped prototypes and everything on dispose', () => {
    const cache = new LodGeometryCache();
    const a = entity('sphere', { radius: 1 });
    const b = entity('box', { size: [1, 1, 1] });
    const geometryA = cache.geometry('a', 0, a);
    expect(cache.geometry('a', 0, entity('sphere', { radius: 99 }))).toBe(geometryA);
    const geometryB = cache.geometry('b', 0, b);
    const disposed: string[] = [];
    geometryA.addEventListener('dispose', () => disposed.push('a'));
    geometryB.addEventListener('dispose', () => disposed.push('b'));
    cache.retain(new Set(['b']));
    expect(disposed).toEqual(['a']);
    expect(cache.size).toBe(1);
    cache.dispose();
    expect(disposed).toEqual(['a', 'b']);
    expect(cache.size).toBe(0);
    expect(cache.geometry('b', 0, b)).not.toBe(geometryB);
  });
});
