/**
 * @layer ui/viewport/3d
 *
 * Pure three.js geometry builders for primitive solids, in the model's +Z-up local frame
 * (same placement as core/commands/tessellation + export). Local origin = entity.position.
 * Memoized and disposed by the mesh components.
 */

import * as THREE from 'three';
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
  const heightSegments = Math.max(4, Math.min(32, Math.floor(segments / 2)));
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

/**
 * Build a rectangular pyramid BufferGeometry: base centered on the local origin in XY (z=0),
 * apex at (0, 0, height).
 *
 * Base corners (z=0):
 *   v0 = (-hw, -hd, 0)   v1 = ( hw, -hd, 0)
 *   v2 = ( hw,  hd, 0)   v3 = (-hw,  hd, 0)
 * Apex: v4 = (0, 0, height)
 *
 * 6 triangles total: 2 for the base, 4 for the side faces.
 */
export function buildPyramidGeometry(baseWidth: number, baseDepth: number, height: number): THREE.BufferGeometry {
  const hw = baseWidth / 2;
  const hd = baseDepth / 2;

  // prettier-ignore
  const vertices = new Float32Array([
    // Base (faces -Z)
    -hw, -hd, 0,  -hw,  hd, 0,   hw,  hd, 0,
    -hw, -hd, 0,   hw,  hd, 0,   hw, -hd, 0,

    // Front side (-Y)
    -hw, -hd, 0,   hw, -hd, 0,   0, 0, height,

    // Right side (+X)
     hw, -hd, 0,   hw,  hd, 0,   0, 0, height,

    // Back side (+Y)
     hw,  hd, 0,  -hw,  hd, 0,   0, 0, height,

    // Left side (-X)
    -hw,  hd, 0,  -hw, -hd, 0,   0, 0, height,
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a right-triangular prism BufferGeometry.
 *
 * Vertices (local coords, position=lower-front-left corner):
 *   Front face (z=0): v0=(0,0,0), v1=(w,0,0), v2=(0,h,0), v3=(w,h,0)
 *   Back edge (z=d):  v4=(0,0,d), v5=(w,0,d)
 *
 * 5 faces total: bottom, front, left slope-top, right slope-top, back (actually
 * the sloped top face) and two triangular side faces (left/right).
 *
 * Triangles (wound counter-clockwise from outside):
 *   Bottom   : v0,v5,v4  v0,v1,v5
 *   Front    : v0,v2,v3  v0,v3,v1
 *   Left side: v0,v4,v2
 *   Right side: v1,v3,v5
 *   Slope top: v2,v4,v5  v2,v5,v3
 *
 * Using computeVertexNormals() for correct smooth-ish lighting.
 */
export function buildWedgeGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  // prettier-ignore
  const vertices = new Float32Array([
    // Bottom face — two triangles
    0, 0, 0,   w, 0, d,   0, 0, d,   // tri 0 (v0,v5,v4)
    0, 0, 0,   w, 0, 0,   w, 0, d,   // tri 1 (v0,v1,v5)

    // Front face (z=0) — one quad = two triangles
    0, 0, 0,   0, h, 0,   w, h, 0,   // tri 2 (v0,v2,v3)
    0, 0, 0,   w, h, 0,   w, 0, 0,   // tri 3 (v0,v3,v1)

    // Left triangular side (x=0)
    0, 0, 0,   0, 0, d,   0, h, 0,   // tri 4 (v0,v4,v2)

    // Right triangular side (x=w)
    w, 0, 0,   w, h, 0,   w, 0, d,   // tri 5 (v1,v3,v5)

    // Sloped top face — one quad = two triangles
    0, h, 0,   0, 0, d,   w, 0, d,   // tri 6 (v2,v4,v5)
    0, h, 0,   w, 0, d,   w, h, 0,   // tri 7 (v2,v5,v3)  — v3=(w,h,0) but slope meets at (w,0,d)
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Surface of revolution in the entity-local frame (origin = entity.position, no axis quaternion).
 * Mirrors core triangulateRevolution (export.ts) / tessellateRevolution (render.ts) exactly:
 * theta = angle * s / segments from +X counter-clockwise; the dominant axis component picks
 * the frame (Z: radial XY / axial Z, Y: radial XZ / axial Y, X: radial YZ / axial X).
 */
export function buildRevolutionGeometry(
  profile: ReadonlyArray<readonly [number, number]>,
  axis: readonly [number, number, number],
  angle: number,
  segments: number,
): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  if (profile.length < 3) return geo;
  const absX = Math.abs(axis[0]), absY = Math.abs(axis[1]), absZ = Math.abs(axis[2]);
  const toLocal = (r: number, a: number, theta: number): [number, number, number] => {
    const c = Math.cos(theta), s = Math.sin(theta);
    if (absZ >= absX && absZ >= absY) return [r * c, r * s, a];
    if (absY >= absX) return [r * c, a, r * s];
    return [a, r * c, r * s];
  };

  const n = profile.length;
  const isFull = angle >= 2 * Math.PI - 1e-6;
  const ringCount = isFull ? segments : segments + 1;
  const rings: Array<Array<[number, number, number]>> = [];
  for (let s = 0; s < ringCount; s++) {
    const theta = (angle * s) / segments;
    rings.push(profile.map(([r, a]) => toLocal(r, a, theta)));
  }

  const out: number[] = [];
  const tri = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
    out.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!);
  };
  const fan = (ring: ReadonlyArray<readonly number[]>): void => {
    for (let i = 1; i + 1 < ring.length; i++) tri(ring[0]!, ring[i]!, ring[i + 1]!);
  };
  for (let s = 0; s < segments; s++) {
    const ringA = rings[s]!;
    const ringB = rings[(s + 1) % rings.length]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(ringA[i]!, ringA[j]!, ringB[j]!);
      tri(ringA[i]!, ringB[j]!, ringB[i]!);
    }
  }
  if (!isFull) {
    fan([...rings[0]!].reverse());
    fan(rings[segments]!);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  geo.computeVertexNormals();
  return geo;
}
