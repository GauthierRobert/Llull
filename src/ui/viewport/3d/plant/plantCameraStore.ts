// External store of the camera view the plant renderer plans from. Components subscribe through `useSyncExternalStore` only when a plant
// scene is active, so a camera bump re-renders nothing in a small document.

import type * as THREE from 'three';

export interface PlantCameraView {
  readonly camera: THREE.Camera;
  readonly width: number;
  readonly height: number;
  readonly version: number;
  readonly moving: boolean;
}

export class PlantCameraStore {
  private view: PlantCameraView | null;
  private readonly listeners = new Set<() => void>();

  constructor(initial: PlantCameraView | null) {
    this.view = initial;
  }

  readonly getSnapshot = (): PlantCameraView | null => this.view;

  /** The first subscriber gets a fresh view (the camera moved unobserved while nobody listened; `moving` is kept). */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0 && this.view !== null) this.view = { ...this.view, version: this.view.version + 1 };
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** True while a component plans from this store; the provider skips its per-frame work otherwise. */
  get active(): boolean {
    return this.listeners.size > 0;
  }

  publish(camera: THREE.Camera, width: number, height: number, moving: boolean): void {
    this.view = { camera, width, height, moving, version: (this.view?.version ?? 0) + 1 };
    for (const listener of [...this.listeners]) listener();
  }
}
