import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { installClipBypass } from '@ui/viewport/3d/clipBypass';

describe('installClipBypass', () => {
  it('draws the main scene clipped and any other scene (the axes gizmo) unclipped, then restores', () => {
    const seen: Array<{ scene: THREE.Object3D; planes: number }> = [];
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const gl = {
      clippingPlanes: [plane],
      render(this: { clippingPlanes: THREE.Plane[] }, scene: THREE.Object3D): void {
        seen.push({ scene, planes: this.clippingPlanes.length });
      },
    } as unknown as THREE.WebGLRenderer;
    const original = gl.render;
    const main = new THREE.Scene();
    const gizmo = new THREE.Scene();
    const undo = installClipBypass(gl, main);

    gl.render(main, new THREE.PerspectiveCamera());
    gl.render(gizmo, new THREE.PerspectiveCamera());
    expect(seen.map((s) => s.planes)).toEqual([1, 0]);
    expect(gl.clippingPlanes).toEqual([plane]);

    undo();
    expect(gl.render).toBe(original);
  });
});
