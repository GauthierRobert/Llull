// Face handle drags as pure data (04 DIR M1): which entities offer them, what each operation is called and measures, and the ONE registered
// command a drag value commits (`push_pull_face`, `replace_face`, `draft_faces`, `move_faces`). The face is named by a point on it (`faceNear`).

import type { Entity, Vec3 } from '@core/model/types';
import { add3, scale3 } from '@lib/vec3';

export type FaceOp = 'push_pull' | 'flush' | 'draft' | 'offset';

export interface FaceOpSpec {
  readonly op: FaceOp;
  readonly label: string;
  readonly unit: 'length' | 'angle';
  readonly tip: string;
}

export const FACE_OPS: readonly FaceOpSpec[] = [
  { op: 'push_pull', label: 'Push / pull', unit: 'length', tip: 'Move a planar face along its normal (push_pull_face)' },
  {
    op: 'flush',
    label: 'Flush to plane',
    unit: 'length',
    tip: 'Move a planar face onto a parallel plane; snaps to other faces (replace_face)',
  },
  { op: 'draft', label: 'Draft', unit: 'angle', tip: 'Tilt a face about the parting line at the bottom (draft_faces)' },
  { op: 'offset', label: 'Offset', unit: 'length', tip: 'Offset a face and extend its neighbours (move_faces)' },
];

/** The face the user picked: a point on it (world) and its outward unit normal. */
export interface FacePick {
  readonly point: Vec3;
  readonly normal: Vec3;
  /** Height of `point` above the lowest point of the solid along +Z: the lever arm of a draft. */
  readonly lever: number;
}

export interface FaceCommand {
  readonly name: 'push_pull_face' | 'replace_face' | 'draft_faces' | 'move_faces';
  readonly params: Readonly<Record<string, unknown>>;
}

const SOLID_KINDS: ReadonlySet<string> = new Set([
  'box',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'wedge',
  'pyramid',
  'extrusion',
  'revolution',
  'sweep',
  'loft',
]);

/** Does the entity offer face handles? Exact solids only: primitives and profile solids, and meshes that carry their B-rep recipe. */
export function canEditFaces(entity: Entity | undefined): boolean {
  if (entity === undefined) return false;
  return SOLID_KINDS.has(entity.kind) || (entity.kind === 'mesh' && entity.brep !== undefined);
}

/** Largest draft the handle produces (the command accepts 89). */
const MAX_DRAFT_DEGREES = 45;

const round = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;
const roundVec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/** Draft angle (degrees) for a face point `lever` above the parting line pushed `offset` along the outward normal. Positive = narrower along +Z. */
export function draftAngle(offset: number, lever: number): number {
  if (!(lever > 1e-9)) return 0;
  const degrees = (Math.atan2(-offset, lever) * 180) / Math.PI;
  return Math.max(-MAX_DRAFT_DEGREES, Math.min(MAX_DRAFT_DEGREES, degrees));
}

/** Is `value` too small to commit (a click that moved nothing)? */
const isIdleFaceValue = (op: FaceOp, value: number): boolean => Math.abs(value) < (op === 'draft' ? 1e-3 : 1e-6);

/** The command a drag value commits, or null for an idle value. For `draft`, `value` is the angle in degrees. */
export function faceCommand(op: FaceOp, entityId: string, pick: FacePick, value: number): FaceCommand | null {
  if (isIdleFaceValue(op, value)) return null;
  const faceNear = roundVec(pick.point);
  switch (op) {
    case 'push_pull':
      return { name: 'push_pull_face', params: { id: entityId, faceNear, distance: round(value) } };
    case 'flush':
      return {
        name: 'replace_face',
        params: {
          id: entityId,
          faceNear,
          target: { origin: roundVec(add3(pick.point, scale3(pick.normal, value))), normal: roundVec(pick.normal) },
        },
      };
    case 'draft':
      return { name: 'draft_faces', params: { id: entityId, facesNear: [faceNear], angle: round(value) } };
    case 'offset':
      return { name: 'move_faces', params: { id: entityId, facesNear: [faceNear], mode: 'offset', distance: round(value) } };
  }
}

/** Readout of a drag value for the bar: "+2.5" for lengths, "5.0 deg" for angles. */
export function formatFaceValue(op: FaceOp, value: number): string {
  if (op === 'draft') return `${value.toFixed(1)}\u00b0`;
  const text = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(3).replace(/\.?0+$/, '');
  return value > 0 ? `+${text}` : text;
}
