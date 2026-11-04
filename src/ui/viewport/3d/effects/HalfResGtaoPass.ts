// three's GTAOPass at half resolution: the composer hands every pass the full frame size, this one shrinks it (its normal / AO / denoise
// targets are all allocated from that size), so the pass costs about a quarter of a full-resolution one.

import type * as THREE from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { hideEdgeExcluded } from './edgeExclusion';
import type { DepthRangeCamera } from './depthRangeCamera';
import { type GtaoParameters, gtaoSize } from './gtaoSettings';

export class HalfResGtaoPass extends GTAOPass {
  /** `depthCamera` gives the camera (tight near/far, see viewDepthRange) the normals and depth are rendered with. */
  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    parameters: GtaoParameters,
    private readonly depthCamera: DepthRangeCamera,
  ) {
    const half = gtaoSize(width, height);
    super(scene, camera, half.width, half.height);
    this.updateGtaoMaterial(parameters);
  }

  /** The pass draws every mesh with an override material, which would also draw what is not world geometry: overlay-only meshes (the
   *  TransformControls gizmo) and the helper planes flagged `noEdges` (the grid is a plane through the origin, it would cut the AO into bands).
   *  Ground contact darkening comes from the contact shadows. */
  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    this.camera = this.depthCamera.current();
    const restore = hideEdgeExcluded(this.scene);
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      restore();
    }
  }

  override setSize(width: number, height: number): void {
    const half = gtaoSize(width, height);
    super.setSize(half.width, half.height);
  }
}
