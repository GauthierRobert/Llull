// `kind:'mesh'` render geometry: shared vertices + no normals would smooth hard edges, so creased normals keep faces flat
// while fine tessellation stays smooth.

import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshData } from '@core/model/types';
import type { Triangle } from '@core/geometry/triangles';
import { soupIndices } from '@core/geometry/meshVolume';
import { toRadians } from '@lib/angle';
import { positionsGeometry } from '../../lineGeometry';

/** Edges sharper than this stay hard (radians). */
const MESH_CREASE_ANGLE = toRadians(30);

export function buildMeshSolidGeometry(mesh: MeshData): THREE.BufferGeometry {
  const indexed = positionsGeometry(mesh.positions);
  indexed.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  const creased = toCreasedNormals(indexed, MESH_CREASE_ANGLE);
  indexed.dispose();
  return creased;
}

export function buildTriangleSoupGeometry(triangles: readonly Triangle[]): THREE.BufferGeometry | null {
  const positions = triangles.flat(2);
  if (positions.length === 0) return null;
  return buildMeshSolidGeometry({ positions, indices: soupIndices(positions) });
}
