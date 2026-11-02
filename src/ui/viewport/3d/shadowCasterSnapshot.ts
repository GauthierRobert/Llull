// Writer-agnostic change test for the shadow casters: every visible shadow-casting mesh's world matrix, geometry and instance
// data, compared with the previous frame. Catches imperative moves no store sees (live transitions, previews, drags), so a
// pure camera frame is the only one that skips the shadow pass. O(casters) per frame, no allocation once warmed up.
// Not tracked: material flags (side, alphaTest) — those change through store edits, which mark the shadows dirty anyway.

import type * as THREE from 'three';

/** Values recorded per caster: object id, geometry id, position-attribute version, instance-matrix version, 16 matrix cells. */
const STRIDE = 20;

/** Bumped by `needsUpdate` (an interleaved attribute's version lives on its buffer); -1 when absent. */
function attributeVersion(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined): number {
  if (attribute === undefined) return -1;
  return 'isInterleavedBufferAttribute' in attribute ? attribute.data.version : attribute.version;
}

export class ShadowCasterSnapshot {
  private values = new Float64Array(0);
  private count = 0;
  // per-traversal cursor: the visitor is one bound method, so a frame allocates no closure
  private index = 0;
  private changed = false;

  /** Records the casters of `scene` (world matrices must be current); true when anything differs from the last call. */
  update(scene: THREE.Object3D): boolean {
    this.changed = false;
    this.index = 0;
    scene.traverseVisible(this.visit);
    if (this.index !== this.count) this.changed = true;
    this.count = this.index;
    return this.changed;
  }

  private readonly visit = (object: THREE.Object3D): void => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true || !mesh.castShadow) return;
    const offset = this.index * STRIDE;
    if (offset + STRIDE > this.values.length) this.grow(offset + STRIDE);
    const instanced = object as THREE.InstancedMesh;
    this.write(offset, 0, mesh.id);
    this.write(offset, 1, mesh.geometry.id);
    this.write(offset, 2, attributeVersion(mesh.geometry.getAttribute('position')));
    this.write(offset, 3, instanced.isInstancedMesh === true ? instanced.instanceMatrix.version + instanced.count * 1e9 : -1);
    const cells = mesh.matrixWorld.elements;
    for (let cell = 0; cell < 16; cell += 1) this.write(offset, 4 + cell, cells[cell] ?? 0);
    this.index += 1;
  };

  private write(offset: number, slot: number, value: number): void {
    const at = offset + slot;
    if (this.values[at] === value) return;
    this.values[at] = value;
    this.changed = true;
  }

  private grow(minimum: number): void {
    const next = new Float64Array(Math.max(minimum, this.values.length * 2));
    next.set(this.values);
    next.fill(Number.NaN, this.values.length);
    this.values = next;
  }
}
