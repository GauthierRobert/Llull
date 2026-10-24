/** Structural checks of a `{ op: 'faceOp' }` recipe node (SC-F1, `model/faceOps`), for `validateShapeRecipe`. */

import type { FaceOpParams } from '../model/faceOps';
import { isFiniteNumber } from '../lib/isFiniteNumber';
import { isRecord } from '../lib/isRecord';
import { isVec3 } from '../lib/vec3';

const nonZero = (value: unknown): boolean => isVec3(value) && value.some((component) => component !== 0);

const isFaceList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every((face) => Number.isInteger(face) && (face as number) >= 0);

const isPlane = (value: unknown): boolean => isRecord(value) && isVec3(value['origin']) && nonZero(value['normal']);

/** Why `move` is not a valid `moveFaces` motion, or null. */
function moveProblem(move: unknown): string | null {
  if (!isRecord(move)) return 'faceOp moveFaces: move must be { type, ... }';
  switch (move['type']) {
    case 'translate':
      return nonZero(move['vector']) ? null : 'faceOp moveFaces translate: vector must be a non-zero [x, y, z]';
    case 'rotate': {
      const axis = move['axis'];
      const angle = move['angle'];
      if (!isRecord(axis) || !isVec3(axis['origin']) || !nonZero(axis['direction']))
        return 'faceOp moveFaces rotate: axis must be { origin, direction }';
      return isFiniteNumber(angle) && angle !== 0 && Math.abs(angle) < Math.PI
        ? null
        : 'faceOp moveFaces rotate: angle must be finite, non-zero and below 180 degrees';
    }
    case 'offset':
      return isFiniteNumber(move['distance']) && move['distance'] !== 0
        ? null
        : 'faceOp moveFaces offset: distance must be finite and non-zero';
    default:
      return `faceOp moveFaces: unknown move type '${String(move['type'])}'`;
  }
}

/** Why `node` is not a valid face operation, or null. */
export function faceOpProblem(node: Readonly<Record<string, unknown>>): string | null {
  const faces = node['faces'];
  if (!isFaceList(faces)) return 'faceOp: faces must be a non-empty list of non-negative face indices';
  switch (node['kind']) {
    case 'draft': {
      const angle = node['angle'];
      if (!isFiniteNumber(angle) || Math.abs(angle) >= Math.PI / 2 || angle === 0)
        return 'faceOp draft: angle must be finite, non-zero and < 90 degrees';
      if (!nonZero(node['pull'])) return 'faceOp draft: pull must be a non-zero [x, y, z]';
      return isPlane(node['neutral']) ? null : 'faceOp draft: neutral must be a plane { origin, normal }';
    }
    case 'pushPull': {
      if (faces.length !== 1) return 'faceOp pushPull: exactly one face';
      const distance = node['distance'];
      return isFiniteNumber(distance) && distance !== 0 ? null : 'faceOp pushPull: distance must be finite and non-zero';
    }
    case 'splitFace':
      return isPlane(node['plane']) ? null : 'faceOp splitFace: plane must be { origin, normal }';
    case 'moveFaces':
      return moveProblem(node['move']);
    case 'deleteFaces':
      return null;
    default:
      return `faceOp: unknown kind '${String(node['kind'])}'`;
  }
}

/** The face-operation parameters of a `faceOp` node (its `op` and `source` dropped), in a fixed key order. */
export function faceOpParamsOf(node: FaceOpParams): FaceOpParams {
  switch (node.kind) {
    case 'draft':
      return { kind: 'draft', faces: node.faces, angle: node.angle, pull: node.pull, neutral: node.neutral };
    case 'pushPull':
      return { kind: 'pushPull', faces: node.faces, distance: node.distance };
    case 'splitFace':
      return { kind: 'splitFace', faces: node.faces, plane: node.plane };
    case 'moveFaces':
      return { kind: 'moveFaces', faces: node.faces, move: node.move };
    case 'deleteFaces':
      return { kind: 'deleteFaces', faces: node.faces };
  }
}
