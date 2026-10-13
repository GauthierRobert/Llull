// Memoized name → Object3D for per-frame code (getObjectByName walks the scene); re-resolves when a hit left the scene.
// Misses are not cached.

import type * as THREE from 'three';

/** True while `object` is still in `root`'s subtree (walks parents; O(depth)). */
function isUnder(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node === root) return true;
  }
  return false;
}

export class SceneObjectCache {
  private readonly byName = new Map<string, THREE.Object3D>();

  get(scene: THREE.Object3D, name: string): THREE.Object3D | undefined {
    const cached = this.byName.get(name);
    if (cached && isUnder(cached, scene)) return cached;
    const found = scene.getObjectByName(name);
    if (found) this.byName.set(name, found);
    else this.byName.delete(name);
    return found;
  }
}
