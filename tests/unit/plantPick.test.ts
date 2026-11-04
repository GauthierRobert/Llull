import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { framedPlanCamera } from '@core/geometry/renderPlanCamera';
import { planRender, planScene } from '@core/geometry/renderPlan';
import type { Entity, Vec3 } from '@core/model/types';
import { LodGeometryCache } from '@ui/viewport/3d/plant/LodGeometryCache';
import { drawBuckets, plantCoveredIds } from '@ui/viewport/3d/plant/plantBatchPlan';
import { bucketMatrices, type LocalBox } from '@ui/viewport/3d/plant/plantMatrices';
import { bucketRaycast, memberPosition } from '@ui/viewport/3d/plant/plantPick';
import { prepareRayIndex, rayCandidates } from '@ui/viewport/3d/plant/plantRayIndex';
import { setActiveClipPlanes } from '@ui/viewport/3d/review/activeClipPlanes';
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
const buckets = drawBuckets(
  scene,
  plan,
  plantCoveredIds(scene, doc.entities, () => false),
);
const cache = new LodGeometryCache();
const material = new THREE.MeshBasicMaterial();

function meshOf(bucket: (typeof buckets)[number]): THREE.InstancedMesh {
  const placements = bucket.ids.map((id) => doc.entities[id] as Entity);
  const boxes = bucket.lod === 2 ? placements.map((e, i): LocalBox => cache.localBox(bucket.prototypes[i] ?? '', e)) : undefined;
  const first = placements[0] as Entity;
  const mesh = new THREE.InstancedMesh(cache.geometry(bucket.prototypeKey, bucket.lod, first), material, bucket.ids.length);
  mesh.instanceMatrix.array.set(bucketMatrices(placements, boxes));
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Deterministic LCG so the randomized rays are the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

function pickAll(raycast: (r: THREE.Raycaster, hits: THREE.Intersection[]) => void, raycaster: THREE.Raycaster): string[] {
  const hits: THREE.Intersection[] = [];
  raycast(raycaster, hits);
  return hits.sort((a, b) => a.distance - b.distance).map((hit) => `${hit.instanceId}@${hit.distance.toFixed(6)}`);
}

describe('plant picking through the instance BVH', () => {
  beforeEach(() => setActiveClipPlanes([]));

  it('memberPosition is a binary search on ascending members', () => {
    expect(memberPosition([1, 4, 9, 12], 9)).toBe(2);
    expect(memberPosition([1, 4, 9, 12], 5)).toBe(-1);
    expect(memberPosition([], 5)).toBe(-1);
  });

  it('gives exactly the hits of three.js InstancedMesh.raycast on randomized rays (every bucket)', () => {
    const next = lcg(7);
    const ids = scene.instances.map((i) => i.aabb);
    const lo: Vec3 = [Math.min(...ids.map((b) => b.min[0])), Math.min(...ids.map((b) => b.min[1])), Math.min(...ids.map((b) => b.min[2]))];
    const hi: Vec3 = [Math.max(...ids.map((b) => b.max[0])), Math.max(...ids.map((b) => b.max[1])), Math.max(...ids.map((b) => b.max[2]))];
    const at = (): THREE.Vector3 =>
      new THREE.Vector3(lo[0] + next() * (hi[0] - lo[0]), lo[1] + next() * (hi[1] - lo[1]), lo[2] + next() * (hi[2] - lo[2]));
    const meshes = buckets.map((bucket) => ({ bucket, mesh: meshOf(bucket) }));
    let hitRays = 0;
    for (let ray = 0; ray < 150; ray++) {
      // Rays aimed at a random instance centre (so many hit) and at a random point (so many miss).
      const target =
        ray % 2 === 0 ? at() : new THREE.Vector3(...(scene.instances[Math.floor(next() * scene.instances.length)]?.aabb.min as Vec3));
      const raycaster = new THREE.Raycaster(
        at(),
        target
          .clone()
          .sub(at())
          .normalize()
          .add(new THREE.Vector3(0, 0, 1e-3))
          .normalize(),
      );
      raycaster.far = Infinity;
      let total = 0;
      for (const { bucket, mesh } of meshes) {
        const reference = pickAll((r, h) => mesh.raycast(r, h), raycaster);
        const viaBvh = pickAll((r, h) => bucketRaycast(bucket, (o, d) => rayCandidates(scene, o, d)).call(mesh, r, h), raycaster);
        expect(viaBvh).toEqual(reference);
        total += reference.length;
      }
      if (total > 0) hitRays++;
    }
    expect(hitRays).toBeGreaterThan(5);
  });

  it('drops a hit on the clipped-away side of the section plane', () => {
    const { bucket, mesh } = (() => {
      const b = buckets.find((candidate) => candidate.ids.length > 1) ?? (buckets[0] as (typeof buckets)[number]);
      return { bucket: b, mesh: meshOf(b) };
    })();
    const box = scene.instances[bucket.members[0] as number]?.aabb as { min: Vec3; max: Vec3 };
    const centre = new THREE.Vector3(...(box.min.map((v, i) => (v + (box.max[i] as number)) / 2) as unknown as Vec3));
    const raycaster = new THREE.Raycaster(centre.clone().add(new THREE.Vector3(0, 0, 1e5)), new THREE.Vector3(0, 0, -1));
    raycaster.far = Infinity;
    const raycast = bucketRaycast(bucket, (o, d) => rayCandidates(scene, o, d));
    const open = pickAll((r, h) => raycast.call(mesh, r, h), raycaster);
    expect(open.length).toBeGreaterThan(0);
    // Keep only z <= -1e9: everything is clipped away.
    setActiveClipPlanes([{ normal: [0, 0, -1], constant: -1e9 }]);
    expect(pickAll((r, h) => raycast.call(mesh, r, h), raycaster)).toEqual([]);
  });

  it('builds the index later and cancels cleanly', () => {
    const cancel = prepareRayIndex(scene);
    cancel();
    expect(rayCandidates(scene, [0, 0, 1e9], [0, 0, 1])).toEqual([]);
  });
});
