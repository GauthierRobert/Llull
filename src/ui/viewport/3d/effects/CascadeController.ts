// Owns one three.js CSM (examples/jsm/csm): the cascade lights, the per-frame fit to the camera, the patched receiver materials and
// the disposal that three's `CSM.dispose` leaves incomplete (the global shader chunks stay replaced; the lights stay in the scene).
// No React; the scene content is only read (materials are marked, nothing is moved).

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { cascadeNormalBias, type CsmConfig } from './csmConfig';

/** Lit materials CSM can patch (they include `lights_fragment_begin`); the shadow catcher's ShadowMaterial and unlit ones are skipped. */
function isCsmReceiver(material: THREE.Material): boolean {
  return (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhongMaterial ||
    material instanceof THREE.MeshLambertMaterial ||
    material instanceof THREE.MeshToonMaterial
  );
}

/** Materials of the meshes under `root` that receive shadows and are not yet in `seen` (which is extended). */
export function newReceiverMaterials(root: THREE.Object3D, seen: WeakSet<THREE.Material>): THREE.Material[] {
  const found: THREE.Material[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.receiveShadow) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (seen.has(material) || !isCsmReceiver(material)) continue;
      seen.add(material);
      found.push(material);
    }
  });
  return found;
}

function projectionKeyOf(camera: THREE.Camera): string {
  return camera instanceof THREE.PerspectiveCamera
    ? `${camera.near}|${camera.far}|${camera.fov}|${camera.aspect}|${camera.zoom}`
    : `${camera.projectionMatrix.elements.join(',')}`;
}

export class CascadeController {
  readonly csm: CSM;
  private readonly seen = new WeakSet<THREE.Material>();
  private readonly savedChunks = { begin: THREE.ShaderChunk.lights_fragment_begin, pars: THREE.ShaderChunk.lights_pars_begin };
  private projectionKey = '';
  private readonly lastMatrix = new THREE.Matrix4();
  private fitted = false;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Object3D,
    private readonly camera: THREE.Camera,
    private readonly config: CsmConfig,
    intensity: number,
    shadowRadius: number,
  ) {
    this.csm = new CSM({
      camera,
      parent: scene,
      cascades: config.cascades,
      maxFar: config.maxFar,
      mode: 'practical',
      shadowMapSize: config.shadowMapSize,
      shadowBias: config.shadowBias,
      lightDirection: new THREE.Vector3(...config.lightDirection),
      lightIntensity: intensity,
      lightNear: config.lightNear,
      lightFar: config.lightFar,
      lightMargin: config.lightMargin,
    });
    for (const light of this.csm.lights) light.shadow.radius = shadowRadius;
  }

  /** Marks the receivers that appeared since the last call (one shader recompile each); returns how many. */
  sweep(): number {
    const fresh = newReceiverMaterials(this.scene, this.seen);
    for (const material of fresh) this.csm.setupMaterial(material);
    return fresh.length;
  }

  /**
   * Refits the cascades to the camera. True when the cascade shadow maps are stale (camera moved or its projection changed), so the
   * caller marks the shadow map dirty; false when nothing changed.
   */
  update(): boolean {
    if (this.disposed) return false;
    const key = projectionKeyOf(this.camera);
    const projectionChanged = key !== this.projectionKey;
    if (projectionChanged) {
      this.projectionKey = key;
      this.csm.updateFrustums();
    }
    if (!projectionChanged && this.fitted && this.lastMatrix.equals(this.camera.matrixWorld)) return false;
    this.lastMatrix.copy(this.camera.matrixWorld);
    this.fitted = true;
    this.csm.update();
    for (const light of this.csm.lights) {
      const shadowCamera = light.shadow.camera as THREE.OrthographicCamera;
      light.shadow.normalBias = cascadeNormalBias(shadowCamera.right - shadowCamera.left, this.config.shadowMapSize);
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.csm.dispose();
    for (const light of this.csm.lights) light.shadow.dispose();
    this.csm.remove();
    THREE.ShaderChunk.lights_fragment_begin = this.savedChunks.begin;
    THREE.ShaderChunk.lights_pars_begin = this.savedChunks.pars;
  }
}
