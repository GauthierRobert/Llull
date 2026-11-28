// Picking of the drawn members of an array: a ray-vs-bounding-sphere prefilter over the members of one tier mesh, then the exact
// triangle test (three-mesh-bvh accelerated `Mesh.raycast`) on the survivors. Above `PICK_MAX_MEMBERS` drawn members a pick is skipped:
// a ray cannot single out one member of a screenful, and the linear prefilter would run on every pointer move.

import * as THREE from 'three';
import { INSTANCE_STRIDE } from '@core/model/instanceArray';
import { isClippedAway } from '../review/activeClipPlanes';

const PICK_MAX_MEMBERS = 100_000;

/** Slots (positions in `members`) whose sphere of `radius` about the member origin the ray touches, ascending. */
function raySphereSlots(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  table: Float64Array,
  members: Uint32Array,
  radius: number,
): number[] {
  const slots: number[] = [];
  const length2 = direction.lengthSq();
  members.forEach((index, slot) => {
    const at = index * INSTANCE_STRIDE;
    const dx = (table[at] ?? 0) - origin.x;
    const dy = (table[at + 1] ?? 0) - origin.y;
    const dz = (table[at + 2] ?? 0) - origin.z;
    const t = (dx * direction.x + dy * direction.y + dz * direction.z) / length2;
    const px = dx - direction.x * t;
    const py = dy - direction.y * t;
    const pz = dz - direction.z * t;
    if (px * px + py * py + pz * pz <= radius * radius) slots.push(slot);
  });
  return slots;
}

const scratchMesh = new THREE.Mesh();
const scratchMatrix = new THREE.Matrix4();
const scratchInverse = new THREE.Matrix4();
const scratchRay = new THREE.Ray();
const scratchHits: THREE.Intersection[] = [];

/** `Object3D.raycast` of one tier's InstancedMesh; `hit.instanceId` is the slot, as for any InstancedMesh. */
export function memberRaycast(
  table: Float64Array,
  members: Uint32Array,
  radius: number,
): (this: THREE.InstancedMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => void {
  return function raycast(this: THREE.InstancedMesh, raycaster, intersects): void {
    if (members.length === 0 || members.length > PICK_MAX_MEMBERS || this.count === 0) return;
    scratchInverse.copy(this.matrixWorld).invert();
    scratchRay.copy(raycaster.ray).applyMatrix4(scratchInverse);
    scratchMesh.geometry = this.geometry;
    scratchMesh.material = this.material;
    for (const slot of raySphereSlots(scratchRay.origin, scratchRay.direction, table, members, radius)) {
      this.getMatrixAt(slot, scratchMatrix);
      scratchMesh.matrixWorld.multiplyMatrices(this.matrixWorld, scratchMatrix);
      scratchHits.length = 0;
      scratchMesh.raycast(raycaster, scratchHits);
      for (const hit of scratchHits) {
        if (isClippedAway(hit.point)) continue;
        hit.instanceId = slot;
        hit.object = this;
        intersects.push(hit);
      }
    }
  };
}
