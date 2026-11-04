// three's GTAOPass at half resolution: the composer hands every pass the full frame size, this one shrinks it (its normal / AO / denoise
// targets are all allocated from that size), so the pass costs about a quarter of a full-resolution one.

import * as THREE from 'three';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { hideEdgeExcluded } from './edgeExclusion';
import { type DepthRange, type GtaoParameters, gtaoSize } from './gtaoSettings';

export class HalfResGtaoPass extends GTAOPass {
  private readonly viewCamera: THREE.PerspectiveCamera;
  private readonly aoCamera = new THREE.PerspectiveCamera();

  /** `depthRange` gives the near/far the AO renders with (see tightDepthRange); null keeps the view camera's own. */
  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    parameters: GtaoParameters,
    private readonly depthRange: (camera: THREE.PerspectiveCamera) => DepthRange | null,
  ) {
    const half = gtaoSize(width, height);
    super(scene, camera, half.width, half.height);
    this.viewCamera = camera;
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
    const range = this.depthRange(this.viewCamera);
    if (range !== null) {
      this.aoCamera.copy(this.viewCamera);
      this.aoCamera.near = range.near;
      this.aoCamera.far = range.far;
      this.aoCamera.updateProjectionMatrix();
      this.camera = this.aoCamera;
    } else this.camera = this.viewCamera;
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
