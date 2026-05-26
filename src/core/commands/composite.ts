/**
 * Composite commands — higher-level operations that encapsulate geometry patterns
 * that would otherwise be re-derived in every agent prompt.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

// ---------------------------------------------------------------------------
// Internal math helpers (pure, no external dependencies)
// ---------------------------------------------------------------------------

/** Dot product of two 3-vectors. */
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Cross product of two 3-vectors. */
function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Euclidean length of a 3-vector. */
function len3(a: Vec3): number {
  return Math.sqrt(dot3(a, a));
}

/** Normalize a 3-vector (returns [0,0,1] for zero-length input). */
function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  if (l < 1e-12) return [0, 0, 1];
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Convert a unit-axis / angle rotation (Rodrigues) to an intrinsic XYZ Euler triple
 * [rx, ry, rz] matching the three.js convention used by `applyEulerXYZ` in render.ts
 * (combined matrix M = Rz * Ry * Rx).
 *
 * @pure
 * @invariant axis is a unit vector; angle in [0, π]
 */
function axisAngleToEulerXYZ(axis: Vec3, angle: number): Vec3 {
  const [kx, ky, kz] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;

  // Rodrigues rotation matrix R = t*k⊗k + c*I + s*[k]×
  // Row-major indexing: R[row][col]
  // R[0][0] = t*kx*kx + c
  // R[0][1] = t*kx*ky - s*kz
  // R[0][2] = t*kx*kz + s*ky
  // R[1][0] = t*ky*kx + s*kz
  // R[1][1] = t*ky*ky + c
  // R[1][2] = t*ky*kz - s*kx
  // R[2][0] = t*kz*kx - s*ky
  // R[2][1] = t*kz*ky + s*kx
  // R[2][2] = t*kz*kz + c

  const r00 = t * kx * kx + c;
  const r10 = t * ky * kx + s * kz;
  const r20 = t * kz * kx - s * ky;
  const r21 = t * kz * ky + s * kx;
  const r22 = t * kz * kz + c;

  // Extract Euler XYZ from M = Rz*Ry*Rx:
  //   M[2][0] = -sin(ry)
  //   M[2][1] = cos(ry)*sin(rx)
  //   M[2][2] = cos(ry)*cos(rx)
  //   M[1][0] = cos(rz)*sin(ry)*sin(rx) + sin(rz)*cos(rx)  (not needed)
  //   M[0][0] = cos(ry)*cos(rz)

  // Clamp for numerical safety before asin
  const sinRy = Math.max(-1, Math.min(1, -r20));
  const ry = Math.asin(sinRy);
  const cosRy = Math.cos(ry);

  let rx: number;
  let rz: number;

  if (Math.abs(cosRy) < 1e-9) {
    // Gimbal lock: ry = ±π/2. Pick rx = 0 and absorb into rz.
    rx = 0;
    // In this degenerate case M[1][0] and M[0][0] are both ~0;
    // use M[0][1] and M[1][1] instead (standard gimbal-lock fallback).
    // When ry = π/2: M = Rz * [[0,0,1],[0,1,0],[-1,0,0]] * Rx
    //   M[0][1] = -sin(rz-rx), M[1][1] = cos(rz-rx)  → rz = atan2(-M[0][1], M[1][1]) with rx=0
    const r01 = t * kx * ky - s * kz;
    const r11 = t * ky * ky + c;
    rz = Math.atan2(-r01, r11);
  } else {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  }

  return [rx, ry, rz];
}

/**
 * Compute the intrinsic XYZ Euler rotation [rx, ry, rz] that orients a cylinder
 * (whose local +Z axis = [0,0,1]) to point along `dir` (unit vector).
 *
 * Strategy: axis = cross(+Z, dir); angle = acos(dir.z).
 * Edge cases:
 *   dir ≈ +Z → identity (0, 0, 0).
 *   dir ≈ -Z → 180° rotation about +X.
 *
 * @pure
 * @invariant dir is a unit vector
 */
function directionToEulerXYZ(dir: Vec3): Vec3 {
  const plusZ: Vec3 = [0, 0, 1];
  const cosAngle = Math.max(-1, Math.min(1, dot3(plusZ, dir)));

  if (cosAngle > 1 - 1e-9) {
    // dir ≈ +Z → identity
    return [0, 0, 0];
  }

  if (cosAngle < -1 + 1e-9) {
    // dir ≈ -Z → 180° around +X
    return [Math.PI, 0, 0];
  }

  const angle = Math.acos(cosAngle);
  const axis = normalize3(cross3(plusZ, dir));
  return axisAngleToEulerXYZ(axis, angle);
}

// ---------------------------------------------------------------------------
// Helper shared by geometry.ts pattern — keep commands pure (withEntity clone)
// ---------------------------------------------------------------------------

function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

// ---------------------------------------------------------------------------
// make_tube_between
// ---------------------------------------------------------------------------

/**
 * @command make_tube_between
 * @pure
 * @layer core/commands
 * @affects creates 1 cylinder entity oriented from p1 to p2
 * @invariant radius > 0; ||p2 - p1|| > 1e-9; rotation encodes dir p1→p2 in intrinsic XYZ Euler
 * @failure radius <= 0 or degenerate p1===p2 or non-array inputs → no-op, affected:[]
 */
interface MakeTubeBetweenParams {
  p1: Vec3;
  p2: Vec3;
  radius: number;
  color?: string;
}

export const makeTubeBetween: CommandDefinition<MakeTubeBetweenParams> = {
  name: 'make_tube_between',
  description:
    'Create a cylinder (tube) that spans exactly from world point p1 to world point p2. ' +
    'Automatically computes the orientation so the cylinder axis runs from p1 to p2 in any ' +
    'plane — eliminates the need to manually derive Euler angles. ' +
    'p1 and p2 are [x, y, z] world coordinates. radius is the tube cross-section radius (> 0). ' +
    'The returned entity id is the only affected id. ' +
    'Fails gracefully (no-op) when radius <= 0 or p1 equals p2 (degenerate tube).',
  paramsSchema: {
    type: 'object',
    properties: {
      p1: {
        type: 'array',
        description:
          'Start point of the tube in world space [x, y, z]. The cylinder base center is placed here.',
        items: { type: 'number' },
      },
      p2: {
        type: 'array',
        description:
          'End point of the tube in world space [x, y, z]. The cylinder top center is placed here.',
        items: { type: 'number' },
      },
      radius: {
        type: 'number',
        description: 'Cross-section radius of the tube. Must be greater than 0.',
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#c8553d". Defaults to "#6b8f9c".',
      },
    },
    required: ['p1', 'p2', 'radius'],
  },
  run: (doc, { p1, p2, radius, color = '#6b8f9c' }): CommandResult => {
    // --- Validate inputs ---
    if (!Array.isArray(p1) || p1.length < 3 || p1.some((v) => typeof v !== 'number' || !isFinite(v))) {
      return {
        document: doc,
        summary: 'make_tube_between failed: p1 must be a numeric [x, y, z] array.',
        affected: [],
      };
    }
    if (!Array.isArray(p2) || p2.length < 3 || p2.some((v) => typeof v !== 'number' || !isFinite(v))) {
      return {
        document: doc,
        summary: 'make_tube_between failed: p2 must be a numeric [x, y, z] array.',
        affected: [],
      };
    }
    if (typeof radius !== 'number' || !isFinite(radius) || radius <= 0) {
      return {
        document: doc,
        summary: `make_tube_between failed: radius must be > 0, got ${radius}.`,
        affected: [],
      };
    }

    // --- Compute direction and length ---
    const dx = (p2[0] as number) - (p1[0] as number);
    const dy = (p2[1] as number) - (p1[1] as number);
    const dz = (p2[2] as number) - (p1[2] as number);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (length < 1e-9) {
      return {
        document: doc,
        summary: `make_tube_between failed: p1 and p2 are the same point (distance ${length.toFixed(9)} < 1e-9).`,
        affected: [],
      };
    }

    // --- Solve orientation ---
    const dir: Vec3 = [dx / length, dy / length, dz / length];
    const rotation = directionToEulerXYZ(dir);

    // --- Position: cylinder is centered at its midpoint in three.js, but our model
    //     uses the base-center convention (cylinder spans [pos, pos + height along +Z]
    //     BEFORE rotation). We want the base at p1 and top at p2.
    //     The cylinder is centered at its centroid in three.js (render.ts tessellateCylinder
    //     uses pz ± height/2). So we must place the entity at the midpoint.
    const mid: Vec3 = [
      ((p1[0] as number) + (p2[0] as number)) / 2,
      ((p1[1] as number) + (p2[1] as number)) / 2,
      ((p1[2] as number) + (p2[2] as number)) / 2,
    ];

    // --- Build entity ---
    const id = nextId('cyl');
    const entity: Entity = {
      id,
      kind: 'cylinder',
      radius,
      height: length,
      position: mid,
      rotation,
      layerId: DEFAULT_LAYER_ID,
      color,
    };

    const l3 = length.toFixed(3);
    const p1s = `[${(p1[0] as number).toFixed(3)},${(p1[1] as number).toFixed(3)},${(p1[2] as number).toFixed(3)}]`;
    const p2s = `[${(p2[0] as number).toFixed(3)},${(p2[1] as number).toFixed(3)},${(p2[2] as number).toFixed(3)}]`;

    return {
      document: withEntity(doc, entity),
      summary: `Created tube ${id} from ${p1s} to ${p2s}, radius ${radius}, length ${l3}.`,
      affected: [id],
    };
  },
};
