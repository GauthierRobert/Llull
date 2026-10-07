import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SceneObjectCache } from '@ui/viewport/3d/sceneObjectCache';

function named(name: string): THREE.Object3D {
  const object = new THREE.Object3D();
  object.name = name;
  return object;
}

describe('SceneObjectCache', () => {
  it('walks the scene once per name while the object stays attached', () => {
    const scene = new THREE.Scene();
    const box = named('box-1');
    scene.add(box);
    const lookup = vi.spyOn(scene, 'getObjectByName');
    const cache = new SceneObjectCache();
    expect(cache.get(scene, 'box-1')).toBe(box);
    expect(cache.get(scene, 'box-1')).toBe(box);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after the object is removed and replaced', () => {
    const scene = new THREE.Scene();
    const first = named('box-1');
    scene.add(first);
    const cache = new SceneObjectCache();
    cache.get(scene, 'box-1');
    scene.remove(first);
    expect(cache.get(scene, 'box-1')).toBeUndefined();
    const second = named('box-1');
    scene.add(second);
    expect(cache.get(scene, 'box-1')).toBe(second);
  });

  it('re-resolves when an ancestor group was removed', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const child = named('box-2');
    group.add(child);
    scene.add(group);
    const cache = new SceneObjectCache();
    expect(cache.get(scene, 'box-2')).toBe(child);
    scene.remove(group);
    expect(cache.get(scene, 'box-2')).toBeUndefined();
  });
});
