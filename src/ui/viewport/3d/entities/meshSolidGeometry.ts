/**
 * @layer ui/viewport/3d
 *
 * Render geometry for `kind:'mesh'` solids. Meshes carry no normals and share vertices across
 * faces, so plain `computeVertexNormals` smooths hard edges (boolean results look rounded).
 * Creased normals keep faces flat while still smoothing fine tessellation (curved surfaces).
 */

import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshData } from '@core/model/types';
import { positionsGeometry } from '../../lineGeometry';

/** Edges sharper than this stay hard (radians). */
export const MESH_CREASE_ANGLE = (30 * Math.PI) / 180;

/** @pure — returns a new non-indexed geometry with `position` + `normal` attributes. */
export function buildMeshSolidGeometry(mesh: MeshData): THREE.BufferGeometry {
  const indexed = positionsGeometry(mesh.positions);
  indexed.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  const creased = toCreasedNormals(indexed, MESH_CREASE_ANGLE);
  indexed.dispose();
  return creased;
}
