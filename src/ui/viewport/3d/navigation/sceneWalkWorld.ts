// Walk probes against the rendered scene (UI only, read-only): floor = a ray straight down, walls = horizontal rays. Plant batches answer through
// their BVH-backed `raycast` (`plantPick.bucketRaycast`); every other mesh through three's own (three-mesh-bvh accelerated) raycast.
// The probed root sits in the floating-origin group, so WORLD positions are shifted by `renderOrigin` on the way in and out.

import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { isClippedAway } from '../review/activeClipPlanes';
import type { WalkWorld, WallHit } from './navigationMath';

/** A hit whose surface is flatter than this (normal Z) is a floor or ceiling, not a wall. */
const WALL_MAX_NORMAL_Z = 0.7;
/** Floor ray length when the scene's lowest z is unknown. */
const FALLBACK_FLOOR_RANGE = 1e5;

const scratchNormal = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchInstance = new THREE.Matrix4();
const scratchNormalMatrix = new THREE.Matrix3();

function isVisibleChain(object: THREE.Object3D | null): boolean {
  for (let node = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
}

/** Only real, visible, un-clipped triangles count: lines, points, sprites, hidden layers and the part a section plane cuts away do not. */
function isSolidHit(hit: THREE.Intersection): boolean {
  return (hit.object as THREE.Mesh).isMesh === true && isVisibleChain(hit.object) && !isClippedAway(hit.point);
}

function worldNormal(hit: THREE.Intersection): THREE.Vector3 | null {
  if (hit.face === undefined || hit.face === null) return null;
  const instanced = hit.object as THREE.InstancedMesh;
  if (instanced.isInstancedMesh === true && hit.instanceId !== undefined) {
    instanced.getMatrixAt(hit.instanceId, scratchInstance);
    scratchMatrix.multiplyMatrices(hit.object.matrixWorld, scratchInstance);
  } else scratchMatrix.copy(hit.object.matrixWorld);
  return scratchNormal.copy(hit.face.normal).applyNormalMatrix(scratchNormalMatrix.getNormalMatrix(scratchMatrix)).normalize();
}

/** `lowestZ` is the scene's lowest world z (null = unknown): the floor ray only reaches that far down. */
export function createSceneWalkWorld(root: THREE.Object3D, renderOrigin: () => Vec3, lowestZ: () => number | null = () => null): WalkWorld {
  const raycaster = new THREE.Raycaster();
  const hits: THREE.Intersection[] = [];
  const probe = (origin: THREE.Vector3, direction: THREE.Vector3, far: number): THREE.Intersection[] => {
    raycaster.set(origin, direction);
    raycaster.near = 0;
    raycaster.far = far;
    hits.length = 0;
    root.updateWorldMatrix(true, false);
    return raycaster.intersectObject(root, true, hits);
  };
  const origin = new THREE.Vector3();
  const down = new THREE.Vector3(0, 0, -1);
  const up = new THREE.Vector3(0, 0, 1);
  const along = new THREE.Vector3();
  return {
    floorBelow(x, y, fromZ): number | null {
      const [ox, oy, oz] = renderOrigin();
      const lowest = lowestZ();
      const range = lowest === null ? FALLBACK_FLOOR_RANGE : Math.max(fromZ - lowest, 0) + 1;
      const found = probe(origin.set(x - ox, y - oy, fromZ - oz), down, range).find(isSolidHit);
      return found === undefined ? null : found.point.z + oz;
    },
    ceilingAbove(x, y, fromZ, maxDistance): number | null {
      const [ox, oy, oz] = renderOrigin();
      const found = probe(origin.set(x - ox, y - oy, fromZ - oz), up, maxDistance).find(isSolidHit);
      return found === undefined ? null : found.point.z + oz;
    },
    wallAhead(from, dirX, dirY, maxDistance): WallHit | null {
      const [ox, oy, oz] = renderOrigin();
      along.set(dirX, dirY, 0);
      for (const hit of probe(origin.set(from[0] - ox, from[1] - oy, from[2] - oz), along, maxDistance)) {
        if (!isSolidHit(hit)) continue;
        const normal = worldNormal(hit);
        if (normal !== null && Math.abs(normal.z) > WALL_MAX_NORMAL_Z) continue;
        let nx = -dirX;
        let ny = -dirY;
        if (normal !== null && Math.hypot(normal.x, normal.y) > 1e-6) {
          const length = Math.hypot(normal.x, normal.y);
          const sign = normal.x * dirX + normal.y * dirY > 0 ? -1 : 1;
          nx = (sign * normal.x) / length;
          ny = (sign * normal.y) / length;
        }
        return { distance: hit.distance, normal: [nx, ny] };
      }
      return null;
    },
  };
}
