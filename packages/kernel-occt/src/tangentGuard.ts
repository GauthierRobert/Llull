/**
 * Pre-flight for OCC booleans: a sphere touching a box face at exactly one point (sphere centre
 * at distance r from a face plane) makes `BRepAlgoAPI_*` return a "valid" solid whose meshing
 * aborts the whole WASM module. Shrinking the sphere by a hair turns the point contact into a
 * clean gap (a union stays two solids, an intersection is empty) so OCC never sees the
 * degenerate case.
 *
 * @layer kernel
 * @pure no WASM objects; works on entities only
 */

import type { Entity, Vec3 } from '@core/model/types';

/** Relative size of the gap opened between a tangent sphere and a box face. */
export const TANGENT_GAP = 1e-5;

/** Inverse of llull's M = Rx·Ry·Rz: Rx⁻¹ first, then Ry⁻¹, then Rz⁻¹ (radians). */
function intoBoxFrame([x, y, z]: Vec3, [rx, ry, rz]: Vec3): Vec3 {
  const [y1, z1] = [y * Math.cos(rx) + z * Math.sin(rx), -y * Math.sin(rx) + z * Math.cos(rx)];
  const [x2, z2] = [x * Math.cos(ry) - z1 * Math.sin(ry), x * Math.sin(ry) + z1 * Math.cos(ry)];
  return [x2 * Math.cos(rz) + y1 * Math.sin(rz), -x2 * Math.sin(rz) + y1 * Math.cos(rz), z2];
}

/**
 * Radius that keeps `sphere` clear of every box face plane it is tangent to (inside or out);
 * the radius unchanged when it touches none.
 */
function clearRadius(
  sphere: { position: Vec3; radius: number },
  box: { position: Vec3; rotation: Vec3; size: Vec3 },
): number {
  const gap = sphere.radius * TANGENT_GAP;
  const local = intoBoxFrame(
    [
      sphere.position[0] - box.position[0],
      sphere.position[1] - box.position[1],
      sphere.position[2] - box.position[2],
    ],
    box.rotation,
  );
  let radius = sphere.radius;
  local.forEach((component, axis) => {
    const half = (box.size[axis] ?? 0) / 2;
    // Centre-to-plane distance of the +face and the -face (sign ignored: outside or inside contact).
    for (const distance of [Math.abs(component - half), Math.abs(component + half)]) {
      if (Math.abs(distance - sphere.radius) <= gap * 4) {
        radius = Math.min(radius, distance - 2 * gap);
      }
    }
  });
  return radius;
}

/**
 * `[a, b]` with any sphere tangent to a face plane of the other operand's box shrunk so a gap of
 * `2 · TANGENT_GAP · radius` opens; other operands are returned untouched.
 */
export function clearTangentContact(a: Entity, b: Entity): [Entity, Entity] {
  const shrink = (sphere: Entity, other: Entity): Entity => {
    if (sphere.kind !== 'sphere' || other.kind !== 'box') return sphere;
    const radius = clearRadius(sphere, other);
    return radius < sphere.radius && radius > 0 ? { ...sphere, radius } : sphere;
  };
  return [shrink(a, b), shrink(b, a)];
}
