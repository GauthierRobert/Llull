// Section / clip planes sit in the renderer's global `clippingPlanes`, which cuts EVERY scene the renderer draws, including the axes gizmo
// (drei GizmoHelper renders its own virtual scene through the same renderer). The bypass renders any scene other than the main one unclipped.

import type * as THREE from 'three';

type RenderTarget = Pick<THREE.WebGLRenderer, 'render' | 'clippingPlanes'>;

/** Wraps `gl.render` so a scene other than `mainScene` is drawn with no global clipping planes; returns the undo. */
export function installClipBypass(gl: RenderTarget, mainScene: THREE.Object3D): () => void {
  const original = gl.render;
  gl.render = function render(this: RenderTarget, scene, camera): void {
    if (scene === mainScene) return original.call(this, scene, camera);
    const planes = this.clippingPlanes;
    this.clippingPlanes = [];
    try {
      original.call(this, scene, camera);
    } finally {
      this.clippingPlanes = planes;
    }
  };
  return () => {
    gl.render = original;
  };
}
