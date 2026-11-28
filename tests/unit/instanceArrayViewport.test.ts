import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { PlanCamera } from '@core/geometry/renderPlanCamera';
import { INSTANCE_STRIDE } from '@core/model/instanceArray';
import { createEmptyDocument } from '@core/model/types';
import { writeMemberMatrices } from '@ui/viewport/3d/instanceArray/arrayMatrices';
import { memberRaycast } from '@ui/viewport/3d/instanceArray/arrayPick';
import { assignMemberTiers, groupTiers, memberShape, visibleInstanceArrays } from '@ui/viewport/3d/instanceArray/arrayVisibility';

const CAMERA: PlanCamera = {
  projection: 'perspective',
  eye: [0, -100, 0],
  direction: [0, 1, 0],
  up: [0, 0, 1],
  fovDeg: 50,
  viewHeight: 0,
  widthPx: 1000,
  heightPx: 1000,
};

function table(positions: [number, number, number][], rotation: [number, number, number] = [0, 0, 0]): Float64Array {
  const out = new Float64Array(positions.length * INSTANCE_STRIDE);
  positions.forEach((p, i) => out.set([...p, ...rotation], i * INSTANCE_STRIDE));
  return out;
}

const UNIT_CUBE: [number, number, number][] = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) => [-1, 1].map((z): [number, number, number] => [x, y, z])),
);

describe('instance array viewport planning', () => {
  it('shape: sphere about the origin and box diagonal, with the array scale', () => {
    expect(memberShape([])).toBeNull();
    const shape = memberShape(UNIT_CUBE, [2, 1, 1]);
    expect(shape?.radius).toBeCloseTo(Math.hypot(2, 1, 1));
    expect(shape?.diagonal).toBeCloseTo(Math.hypot(4, 2, 2));
  });

  it('culls members outside the frustum and under one pixel, and tiers the rest by projected size', () => {
    const shape = { radius: 1, diagonal: 2 };
    const positions: [number, number, number][] = [
      [0, 0, 0], // 100 away: ~ 2 / (2*100*tan25) * 1000 = 21 px -> coarse range
      [0, -90, 0], // 10 away: ~ 214 px -> full
      [0, 800, 0], // 900 away: ~ 2.4 px -> box
      [0, 100000, 0], // < 1 px -> culled
      [5000, 0, 0], // far outside the side planes -> culled
      [0, -200, 0], // behind the eye -> culled
    ];
    const tiers = assignMemberTiers(table(positions), positions.length, shape, CAMERA, { hasCoarse: true });
    expect([...tiers]).toEqual([1, 0, 2, 3, 3, 3]);
    const noCoarse = assignMemberTiers(table(positions), positions.length, shape, CAMERA, { hasCoarse: false });
    expect(noCoarse[0]).toBe(0);
  });

  it('holds a coarser tier through the hysteresis band', () => {
    const shape = { radius: 1, diagonal: 2 };
    // ~ 47 px at distance 45.5 + 100? tune: distance d gives 2*1000/(2*d*0.4663) = 2144/d px; 46 px at d = 46.6
    const near: [number, number, number][] = [[0, -53.4, 0]];
    const fresh = assignMemberTiers(table(near), 1, shape, CAMERA, { hasCoarse: true });
    expect(fresh[0]).toBe(1);
    const nearer: [number, number, number][] = [[0, -56, 0]]; // ~ 48.7 px: tier 0 fresh, held at 1 within 15 %
    expect(assignMemberTiers(table(nearer), 1, shape, CAMERA, { hasCoarse: true })[0]).toBe(0);
    expect(assignMemberTiers(table(nearer), 1, shape, CAMERA, { hasCoarse: true, held: new Uint8Array([1]) })[0]).toBe(1);
  });

  it('is cheap enough for a 4,000,000-member table (typed arrays, no per-member objects)', () => {
    const count = 4_000_000;
    const big = new Float64Array(count * INSTANCE_STRIDE);
    for (let i = 0; i < count; i++) big[i * INSTANCE_STRIDE] = (i % 2000) * 3;
    const started = performance.now();
    const tiers = assignMemberTiers(big, count, { radius: 1, diagonal: 2 }, CAMERA, { hasCoarse: false });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(tiers).toHaveLength(count);
  });

  it('groups members per tier ascending and drops past the cap, farthest tier first', () => {
    const tiers = new Uint8Array([0, 2, 3, 1, 0, 2]);
    const grouped = groupTiers(tiers);
    expect(grouped.members.map((m) => [...m])).toEqual([[0, 4], [3], [1, 5]]);
    expect(grouped.dropped).toBe(0);
    const capped = groupTiers(tiers, 3);
    expect(capped.members.map((m) => [...m])).toEqual([[0, 4], [3], []]);
    expect(capped.dropped).toBe(2);
  });

  it('writes the same matrix as an Object3D (T Rxyz S)', () => {
    const rotation: [number, number, number] = [0.3, -0.7, 1.1];
    const members = new Uint32Array([1]);
    const out = writeMemberMatrices(
      new Float32Array(32),
      table(
        [
          [0, 0, 0],
          [4, 5, 6],
        ],
        rotation,
      ),
      members,
      [2, 3, 4],
    );
    const object = new THREE.Object3D();
    object.position.set(4, 5, 6);
    object.rotation.set(...rotation);
    object.scale.set(2, 3, 4);
    object.updateMatrix();
    object.matrix.elements.forEach((value, i) => expect(out[i]).toBeCloseTo(value, 5));
  });

  it('ray pick tests only the members whose sphere the ray touches and reports the slot', () => {
    const positions: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 0, 0.5],
    ];
    const members = new Uint32Array([0, 1, 2]);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial(), 3);
    writeMemberMatrices(mesh.instanceMatrix.array as Float32Array, table(positions), members);
    mesh.updateMatrixWorld(true);
    const hits: THREE.Intersection[] = [];
    memberRaycast(table(positions), members, 2).call(
      mesh,
      new THREE.Raycaster(new THREE.Vector3(0, -50, 0), new THREE.Vector3(0, 1, 0)),
      hits,
    );
    expect(new Set(hits.map((hit) => hit.instanceId))).toEqual(new Set([0, 2]));
  });

  it('picks no member when too many are drawn for a ray to single one out', () => {
    const raycast = memberRaycast(table([[0, 0, 0]]), new Uint32Array(100_001), 1);
    const hits: THREE.Intersection[] = [];
    raycast.call(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 1), new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
  });

  it('draws only arrays on visible layers', () => {
    const doc = createEmptyDocument();
    const array = {
      id: 'a',
      name: 'a',
      componentId: 'c',
      layerId: 'L',
      color: '#fff',
      count: 1,
      encoding: 'f64le-base64' as const,
      transforms: '',
    };
    const layers = { L: { id: 'L', name: 'L', visible: true, locked: false, color: '#fff' } };
    expect(visibleInstanceArrays({ a: array }, layers, new Set())).toEqual([array]);
    expect(visibleInstanceArrays({ a: array }, { L: { ...layers.L, visible: false } }, new Set())).toEqual([]);
    expect(visibleInstanceArrays({ a: array }, layers, new Set(['L']))).toEqual([]);
    expect(visibleInstanceArrays(undefined, doc.layers, new Set())).toEqual([]);
  });
});
