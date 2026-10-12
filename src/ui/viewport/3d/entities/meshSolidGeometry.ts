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
import type { Triangle } from '@core/geometry/triangles';
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

/** @pure — creased geometry for a triangle soup; null when there are no triangles. */
export function buildTriangleSoupGeometry(
  triangles: readonly Triangle[],
): THREE.BufferGeometry | null {
  const positions = triangles.flat(2);
  if (positions.length === 0) return null;
  const indices = Array.from({ length: positions.length / 3 }, (_, corner) => corner);
  return buildMeshSolidGeometry({ positions, indices });
}
