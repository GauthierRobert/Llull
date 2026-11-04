// The camera a depth-based effect pass renders its normals / depth with: the view camera, or a copy whose near/far hug the scene along the view
// (`viewDepthRange`). The view camera's own range is adaptive but wide (~1:4e6), which a 24-bit depth buffer turns into banding.

import * as THREE from 'three';
import type { DepthRange } from './gtaoSettings';

export class DepthRangeCamera {
  private readonly tight = new THREE.PerspectiveCamera();

  /** `range` returns the near/far to use for the view camera, or null to keep the camera's own. */
  constructor(
    private readonly view: THREE.PerspectiveCamera,
    private readonly range: (view: THREE.PerspectiveCamera) => DepthRange | null,
  ) {}

  current(): THREE.PerspectiveCamera {
    const range = this.range(this.view);
    if (range === null) return this.view;
    this.tight.copy(this.view);
    this.tight.near = range.near;
    this.tight.far = range.far;
    this.tight.updateProjectionMatrix();
    return this.tight;
  }
}
