import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ShadowCasterSnapshot } from '../../src/ui/viewport/3d/shadowCasterSnapshot';

function sceneWithCaster(): { scene: THREE.Scene; mesh: THREE.Mesh } {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.castShadow = true;
  scene.add(mesh);
  scene.updateMatrixWorld();
  return { scene, mesh };
}

describe('ShadowCasterSnapshot', () => {
  it('reports a change on the first frame, then none while nothing moves (pure camera frames)', () => {
    const { scene } = sceneWithCaster();
    const snapshot = new ShadowCasterSnapshot();
    expect(snapshot.update(scene)).toBe(true);
    expect(snapshot.update(scene)).toBe(false);
    expect(snapshot.update(scene)).toBe(false);
  });

  it('detects a caster moved imperatively by any writer', () => {
    const { scene, mesh } = sceneWithCaster();
    const snapshot = new ShadowCasterSnapshot();
    snapshot.update(scene);
    mesh.position.x = 2;
    scene.updateMatrixWorld();
    expect(snapshot.update(scene)).toBe(true);
    expect(snapshot.update(scene)).toBe(false);
  });

  it('detects a parent group move, an added or hidden caster, and an in-place geometry edit', () => {
    const { scene, mesh } = sceneWithCaster();
    const group = new THREE.Group();
    scene.add(group);
    group.add(mesh);
    const snapshot = new ShadowCasterSnapshot();
    snapshot.update(scene);

    group.rotation.z = 0.5;
    scene.updateMatrixWorld();
    expect(snapshot.update(scene)).toBe(true);

    const extra = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial());
    extra.castShadow = true;
    scene.add(extra);
    scene.updateMatrixWorld();
    expect(snapshot.update(scene)).toBe(true);

    extra.visible = false;
    expect(snapshot.update(scene)).toBe(true);

    const position = mesh.geometry.getAttribute('position');
    position.needsUpdate = true;
    expect(snapshot.update(scene)).toBe(true);
    expect(snapshot.update(scene)).toBe(false);
  });

  it('ignores meshes that cast no shadow', () => {
    const { scene } = sceneWithCaster();
    const snapshot = new ShadowCasterSnapshot();
    snapshot.update(scene);
    const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
    scene.add(overlay);
    overlay.position.y = 3;
    scene.updateMatrixWorld();
    expect(snapshot.update(scene)).toBe(false);
  });

  it('detects instance matrix and instance count changes', () => {
    const scene = new THREE.Scene();
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 4);
    instanced.castShadow = true;
    scene.add(instanced);
    scene.updateMatrixWorld();
    const snapshot = new ShadowCasterSnapshot();
    snapshot.update(scene);
    instanced.instanceMatrix.needsUpdate = true;
    expect(snapshot.update(scene)).toBe(true);
    instanced.count = 2;
    expect(snapshot.update(scene)).toBe(true);
    expect(snapshot.update(scene)).toBe(false);
  });
});
