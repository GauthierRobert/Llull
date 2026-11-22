import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ensureBvhSetup } from '@ui/viewport/3d/bvhSetup';
import { bucketRaycast } from '@ui/viewport/3d/plant/plantPick';
import { buildPickIndex, localBoxOf, worldBoxes } from '@ui/viewport/3d/componentBatch/componentPick';

/** mulberry32: deterministic. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNT = 2450;

interface Scene {
  matrices: Float32Array;
  brute: THREE.InstancedMesh;
  fast: THREE.InstancedMesh;
  candidates: (origin: readonly number[], direction: readonly number[]) => number[];
}

/** A 2,450-instance synthetic turbofan-like scene: random positions and rotations of one 960-triangle sphere. */
function buildScene(random: () => number): Scene {
  const geometry = new THREE.SphereGeometry(0.5, 24, 20);
  geometry.computeBoundsTree();
  const matrices = new Float32Array(COUNT * 16);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < COUNT; i++) {
    const position = new THREE.Vector3((random() - 0.5) * 60, (random() - 0.5) * 60, (random() - 0.5) * 60);
    const rotation = new THREE.Euler(random() * 6, random() * 6, random() * 6);
    matrix.compose(position, new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(1, 1, 1));
    matrix.toArray(matrices, i * 16);
  }
  const make = (): THREE.InstancedMesh => {
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), COUNT);
    for (let i = 0; i < COUNT; i++) mesh.setMatrixAt(i, matrix.fromArray(matrices, i * 16));
    mesh.updateMatrixWorld(true);
    return mesh;
  };
  const brute = make();
  const fast = make();
  const index = buildPickIndex(worldBoxes(matrices, localBoxOf(geometry)));
  const members = Array.from({ length: COUNT }, (_, i) => i);
  fast.raycast = bucketRaycast({ members }, (origin, direction) => index.rayQuery(origin, direction));
  return {
    matrices,
    brute,
    fast,
    candidates: (o, d) => index.rayQuery([o[0] ?? 0, o[1] ?? 0, o[2] ?? 0], [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0]),
  };
}

function firstHit(mesh: THREE.InstancedMesh, ray: THREE.Ray): THREE.Intersection | undefined {
  const raycaster = new THREE.Raycaster(ray.origin, ray.direction);
  const hits: THREE.Intersection[] = [];
  mesh.raycast(raycaster, hits);
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0];
}

describe('component batch BVH picking', () => {
  beforeAll(() => ensureBvhSetup());

  it('agrees with the brute-force InstancedMesh.raycast on 300 seeded random rays (2,450 instances)', () => {
    const random = seeded(20261122);
    const scene = buildScene(random);
    let hitRays = 0;
    for (let i = 0; i < 300; i++) {
      const origin = new THREE.Vector3((random() - 0.5) * 80, (random() - 0.5) * 80, (random() - 0.5) * 80);
      const target = new THREE.Vector3((random() - 0.5) * 60, (random() - 0.5) * 60, (random() - 0.5) * 60);
      const ray = new THREE.Ray(origin, target.sub(origin).normalize());
      const expected = firstHit(scene.brute, ray);
      const actual = firstHit(scene.fast, ray);
      expect(actual?.instanceId).toBe(expected?.instanceId);
      if (expected !== undefined && actual !== undefined) {
        hitRays++;
        expect(actual.distance).toBeCloseTo(expected.distance, 6);
      }
    }
    expect(hitRays).toBeGreaterThan(20);
  });

  it('the broad phase leaves a small fraction of the instances to the exact test', () => {
    const scene = buildScene(seeded(7));
    const candidates = scene.candidates([-50, 0.3, 0.2], [1, 0, 0]);
    expect(candidates.length).toBeLessThan(COUNT / 10);
  });
});
