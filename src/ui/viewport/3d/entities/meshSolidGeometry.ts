// `kind:'mesh'` render geometry: shared vertices + no normals would smooth hard edges, so creased normals keep faces flat
// while fine tessellation stays smooth.

import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FaceColor, MeshData } from '@core/model/types';
import { faceColorTriangles } from '@core/geometry/faceColors';
import type { Triangle } from '@core/geometry/triangles';
import { soupIndices } from '@core/geometry/meshVolume';
import { toRadians } from '@lib/angle';
import { positionsGeometry } from '../../lineGeometry';

/** Edges sharper than this stay hard (radians). */
const MESH_CREASE_ANGLE = toRadians(30);

/** `colors` (r, g, b per vertex) become the geometry's `color` attribute (analysis colour maps); they survive the crease splitting. */
export function buildMeshSolidGeometry(mesh: MeshData, colors?: ReadonlyArray<number>): THREE.BufferGeometry {
  const indexed = positionsGeometry(mesh.positions);
  indexed.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
  if (colors !== undefined) indexed.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const creased = toCreasedNormals(indexed, MESH_CREASE_ANGLE);
  indexed.dispose();
  return creased;
}

export function buildTriangleSoupGeometry(triangles: readonly Triangle[]): THREE.BufferGeometry | null {
  const positions = triangles.flat(2);
  if (positions.length === 0) return null;
  return buildMeshSolidGeometry({ positions, indices: soupIndices(positions) });
}

/**
 * Unwelded geometry of `mesh` with a per-corner `color` attribute: each triangle in its face colour (`faceColorTriangles`), else in
 * `baseColor`; unwelded so colours stay sharp at face borders.
 */
export function buildFaceColoredGeometry(mesh: MeshData, faceColors: readonly FaceColor[], baseColor: string): THREE.BufferGeometry {
  const triangleColors = faceColorTriangles(mesh, faceColors);
  const corners = mesh.indices.length > 0 ? mesh.indices : Array.from({ length: Math.floor(mesh.positions.length / 3) }, (_, i) => i);
  const positions: number[] = [];
  const colors: number[] = [];
  const rgb = new Map<string, THREE.Color>();
  const colorOf = (hex: string): THREE.Color => {
    const known = rgb.get(hex);
    if (known !== undefined) return known;
    const created = new THREE.Color(hex);
    rgb.set(hex, created);
    return created;
  };
  for (let n = 0; n + 2 < corners.length; n += 3) {
    const color = colorOf(triangleColors[n / 3] ?? baseColor);
    for (let k = 0; k < 3; k++) {
      const vertex = corners[n + k] ?? 0;
      positions.push(mesh.positions[vertex * 3] ?? 0, mesh.positions[vertex * 3 + 1] ?? 0, mesh.positions[vertex * 3 + 2] ?? 0);
      colors.push(color.r, color.g, color.b);
    }
  }
  return buildMeshSolidGeometry({ positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) }, colors);
}
