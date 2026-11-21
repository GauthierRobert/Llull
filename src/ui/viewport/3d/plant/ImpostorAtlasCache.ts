// Octahedral view atlas per plant prototype, captured once through an injected `AtlasCapture` (the GPU part, `captureAtlas`), kept until
// the prototype leaves the scene and disposed with the cache. A failed capture is remembered as "no impostor" (the real LOD1 mesh stays).

import * as THREE from 'three';
import type { LocalBox } from './plantMatrices';

export interface ImpostorAtlas {
  readonly texture: THREE.Texture;
  /** Bounding-sphere centre of the prototype in its local frame, and the sphere radius (the billboard's half size). */
  readonly centre: THREE.Vector3;
  readonly radius: number;
  dispose(): void;
}

interface CapturedAtlas {
  readonly texture: THREE.Texture;
  /** Frees the GPU memory (a render target's texture is not freed by `texture.dispose()`). */
  dispose(): void;
}
/** Renders the atlas of `geometry` (one view per cell). Throws, or returns null, when it cannot. */
export type AtlasCapture = (geometry: THREE.BufferGeometry, box: LocalBox) => CapturedAtlas | null;

/** Sphere around a local box: the impostor quad must cover every view of it. */
export function boxSphere(box: LocalBox): { centre: THREE.Vector3; radius: number } {
  const centre = new THREE.Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
  const radius = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
  return { centre, radius: Math.max(radius, 1e-9) };
}

/**
 * @invariant one capture per prototype key until `retain` drops it or `dispose` runs; `dispose` empties the cache, which stays usable
 */
export class ImpostorAtlasCache {
  private readonly atlases = new Map<string, ImpostorAtlas | null>();

  constructor(private readonly capture: AtlasCapture) {}

  /** The atlas of the prototype, captured on the first call; null when the capture failed. */
  atlas(prototypeKey: string, geometry: THREE.BufferGeometry, box: LocalBox): ImpostorAtlas | null {
    if (this.atlases.has(prototypeKey)) return this.atlases.get(prototypeKey) ?? null;
    let made: ImpostorAtlas | null = null;
    try {
      const captured = this.capture(geometry, box);
      if (captured !== null) made = { texture: captured.texture, ...boxSphere(box), dispose: () => captured.dispose() };
    } catch (error) {
      console.warn('impostor capture failed; the prototype keeps its real mesh', error);
    }
    this.atlases.set(prototypeKey, made);
    return made;
  }

  /** The already captured atlas (no capture). */
  peek(prototypeKey: string): ImpostorAtlas | null {
    return this.atlases.get(prototypeKey) ?? null;
  }

  retain(liveKeys: ReadonlySet<string>): void {
    for (const [key, atlas] of this.atlases) {
      if (liveKeys.has(key)) continue;
      atlas?.dispose();
      this.atlases.delete(key);
    }
  }

  get size(): number {
    return this.atlases.size;
  }

  dispose(): void {
    for (const atlas of this.atlases.values()) atlas?.dispose();
    this.atlases.clear();
  }
}
