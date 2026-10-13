// three.js builders for primitive solids in the +Z-up local frame (origin = entity.position), same placement as core tessellation.

import { clamp } from '@lib/clamp';
import * as THREE from 'three';
import { revolutionTriangles } from '@core/geometry/revolution';
import { positionsGeometry } from '../../lineGeometry';
import { radialSegmentsForDiag, cylinderDiag, sphereDiag, torusDiag } from '../lodSegments';

/** Cylinder: axis along +Z, centered at the origin. */
export function buildCylinderGeometry(radius: number, height: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, height, radialSegmentsForDiag(cylinderDiag(radius, height)));
  geo.rotateX(Math.PI / 2);
  return geo;
}

/** Cone: base circle in XY at the origin, apex at (0, 0, height). */
export function buildConeGeometry(radius: number, height: number): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(radius, height, radialSegmentsForDiag(cylinderDiag(radius, height)));
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, height / 2);
  return geo;
}

/** Sphere centered at the origin, poles along +/-Z. */
export function buildSphereGeometry(radius: number): THREE.BufferGeometry {
  const segments = radialSegmentsForDiag(sphereDiag(radius));
  const heightSegments = clamp(Math.floor(segments / 2), 4, 32);
  const geo = new THREE.SphereGeometry(radius, segments, heightSegments);
  geo.rotateX(Math.PI / 2);
  return geo;
}

/** Torus: ring in the XY plane (hole along +Z), centered at the origin. */
export function buildTorusGeometry(ringRadius: number, tubeRadius: number): THREE.BufferGeometry {
  const tubularSegments = radialSegmentsForDiag(torusDiag(ringRadius, tubeRadius));
  const radialSegments = Math.max(8, Math.floor(tubularSegments / 2));
  return new THREE.TorusGeometry(ringRadius, tubeRadius, radialSegments, tubularSegments);
}

/** Base centered on the origin at z=0, apex (0,0,height); rows: base ×2, then -Y, +X, +Y, -X sides. */
export function buildPyramidGeometry(baseWidth: number, baseDepth: number, height: number): THREE.BufferGeometry {
  const hw = baseWidth / 2;
  const hd = baseDepth / 2;
  // prettier-ignore
  const geo = positionsGeometry([
    -hw, -hd, 0,  -hw,  hd, 0,   hw,  hd, 0,
    -hw, -hd, 0,   hw,  hd, 0,   hw, -hd, 0,
    -hw, -hd, 0,   hw, -hd, 0,   0, 0, height,
     hw, -hd, 0,   hw,  hd, 0,   0, 0, height,
     hw,  hd, 0,  -hw,  hd, 0,   0, 0, height,
    -hw,  hd, 0,  -hw, -hd, 0,   0, 0, height,
  ]);
  geo.computeVertexNormals();
  return geo;
}

/** Right-triangular prism (ramp); `position` = lower-front-left; full height at z=0 tapering to 0 at z=d. Rows: bottom ×2, front ×2, -X side, +X side, slope ×2 (CCW from outside). */
export function buildWedgeGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  // prettier-ignore
  const geo = positionsGeometry([
    0, 0, 0,   w, 0, d,   0, 0, d,
    0, 0, 0,   w, 0, 0,   w, 0, d,
    0, 0, 0,   0, h, 0,   w, h, 0,
    0, 0, 0,   w, h, 0,   w, 0, 0,
    0, 0, 0,   0, 0, d,   0, h, 0,
    w, 0, 0,   w, h, 0,   w, 0, d,
    0, h, 0,   0, 0, d,   w, 0, d,
    0, h, 0,   w, 0, d,   w, h, 0,
  ]);
  geo.computeVertexNormals();
  return geo;
}

/** Entity-local surface of revolution (no axis quaternion), sampled by core/geometry/revolution. */
export function buildRevolutionGeometry(
  profile: ReadonlyArray<readonly [number, number]>,
  axis: readonly [number, number, number],
  angle: number,
  segments: number,
): THREE.BufferGeometry {
  if (profile.length < 3) return new THREE.BufferGeometry();
  const geo = positionsGeometry(revolutionTriangles(profile, axis, angle, segments).flatMap((triangle) => triangle.flat()));
  geo.computeVertexNormals();
  return geo;
}
