// Coarse geometries of a component child for the far LOD tiers, built in-process (no native sidecar): tier 1 is the core TS decimation of
// a mesh child (same frame as the full geometry: the decimated mesh goes through `solidTriangles` like the original), tier 2 the
// bounding box of the full geometry (the plant's LOD2 box).

import * as THREE from 'three';
import { decimateMesh } from '@core/geometry/mesh/decimate';
import { solidTriangles } from '@core/geometry/solidTriangles';
import type { Entity } from '@core/model/types';
import { buildTriangleSoupGeometry } from '../entities/meshSolidGeometry';

/** Meshes under this many triangles have nothing worth decimating. */
const DECIMATE_MIN_TRIANGLES = 512;
/** Tier 1 keeps this fraction of the triangles. */
const KEEP_FRACTION = 0.25;

/** Decimated tier-1 geometry of a mesh child; undefined when the child is not a large mesh, the decimation fails or does not shrink it. */
export function buildCoarseGeometry(child: Entity): THREE.BufferGeometry | undefined {
  if (child.kind !== 'mesh') return undefined;
  const before = Math.floor(child.mesh.indices.length / 3);
  if (before < DECIMATE_MIN_TRIANGLES) return undefined;
  try {
    const { mesh, report } = decimateMesh(child.mesh, { targetTriangles: Math.floor(before * KEEP_FRACTION), preserveBoundary: true });
    if (report.trianglesAfter >= before) return undefined;
    return buildTriangleSoupGeometry(solidTriangles({ ...child, mesh })) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Tier-2 box of the full geometry (12 triangles, same frame). */
export function buildBoxGeometry(full: THREE.BufferGeometry): THREE.BufferGeometry {
  full.computeBoundingBox();
  const box = full.boundingBox;
  if (box === null || box.isEmpty()) return new THREE.BufferGeometry();
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  return new THREE.BoxGeometry(size.x, size.y, size.z).translate(centre.x, centre.y, centre.z);
}
