import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createSceneWalkWorld } from '@ui/viewport/3d/navigation/sceneWalkWorld';
import { setActiveClipPlanes } from '@ui/viewport/3d/review/activeClipPlanes';

/** A 2 x 2 x 1 block whose top is at z = 1 and whose -x face is at x = -1, in a group shifted by -origin (the floating origin). */
function scene(origin: [number, number, number] = [0, 0, 0]): { root: THREE.Group; block: THREE.Mesh } {
  const root = new THREE.Group();
  root.position.set(-origin[0], -origin[1], -origin[2]);
  const block = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1), new THREE.MeshStandardMaterial());
  block.position.set(origin[0], origin[1], origin[2] + 0.5);
  root.add(block);
  root.updateMatrixWorld(true);
  return { root, block };
}

describe('scene walk world', () => {
  it('finds the top of a block below the probe and none beside it', () => {
    const { root } = scene();
    const world = createSceneWalkWorld(root, () => [0, 0, 0]);
    expect(world.floorBelow(0, 0, 5)).toBeCloseTo(1);
    expect(world.floorBelow(9, 0, 5)).toBeNull();
    expect(world.floorBelow(0, 0, 0.5)).toBeNull();
  });

  it('reports the horizontal normal and distance of a wall, facing the walker', () => {
    const { root } = scene();
    const world = createSceneWalkWorld(root, () => [0, 0, 0]);
    const hit = world.wallAhead([-4, 0, 0.5], 1, 0, 10);
    expect(hit?.distance).toBeCloseTo(3);
    expect(hit?.normal[0]).toBeCloseTo(-1);
    expect(world.wallAhead([-4, 0, 0.5], 1, 0, 2)).toBeNull();
    expect(world.wallAhead([-4, 0, 3], 1, 0, 10)).toBeNull();
  });

  it('works in WORLD coordinates under a floating origin', () => {
    const { root } = scene([5000, 7000, 20]);
    const world = createSceneWalkWorld(root, () => [5000, 7000, 20]);
    expect(world.floorBelow(5000, 7000, 30)).toBeCloseTo(21);
    expect(world.wallAhead([4996, 7000, 20.5], 1, 0, 10)?.distance).toBeCloseTo(3);
  });

  it('ignores hidden meshes, lines and the part a section plane cuts away', () => {
    const { root, block } = scene();
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(5, -1, 2), new THREE.Vector3(5, 1, 2)]));
    root.add(line);
    const world = createSceneWalkWorld(root, () => [0, 0, 0]);
    expect(world.floorBelow(5, 0, 9)).toBeNull();
    block.visible = false;
    expect(world.floorBelow(0, 0, 5)).toBeNull();
    block.visible = true;
    setActiveClipPlanes([{ normal: [0, 0, -1], constant: 0.5 }]);
    expect(world.floorBelow(0, 0, 5)).toBeNull();
    setActiveClipPlanes([]);
    expect(world.floorBelow(0, 0, 5)).toBeCloseTo(1);
  });

  it('does not treat a flat surface as a wall and uses the instance transform of an InstancedMesh', () => {
    const root = new THREE.Group();
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 1);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(10, 0, 0.5));
    instanced.instanceMatrix.needsUpdate = true;
    root.add(instanced);
    root.updateMatrixWorld(true);
    const world = createSceneWalkWorld(root, () => [0, 0, 0]);
    expect(world.floorBelow(10, 0, 3)).toBeCloseTo(1);
    expect(world.wallAhead([10, 0, 5], 0, 0, 1)).toBeNull();
    const hit = world.wallAhead([6, 0, 0.5], 1, 0, 10);
    expect(hit?.distance).toBeCloseTo(3.5);
    expect(hit?.normal[0]).toBeCloseTo(-1);
  });
});
