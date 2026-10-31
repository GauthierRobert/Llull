/**
 * Face picking for the face operations (SC-F1) with persistent names (SC-N1, SC-N2), the face counterpart of `edgeReferences`: recorded
 * `faceNames` win over indices and points and refuse with REF_LOST / REF_SPLIT when they no longer name exactly one face; a first pick by
 * index or point records the names of the faces it chose. Points pick the face nearest to them (the kernel's exact face distance).
 */

import type { Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import { hasNames, namesOf, referenceProblem, resolveNames } from '../../geometry/naming/references';
import { meshDiagonal } from '../../geometry/meshExtent';
import type { CommandError } from '../types';
import { commandError } from '../noop';

export interface FaceRequest {
  readonly indices: readonly number[];
  readonly near: readonly Vec3[];
  /** Persistent names recorded by an earlier run (`faceNames`). */
  readonly names?: readonly string[] | undefined;
}

export type FacePick =
  | { readonly faces: number[]; readonly record: string[] | null; readonly note: string }
  | { readonly problem: string; readonly error?: CommandError; readonly nearIndex?: number };

const REPICK_FACES =
  'Re-pick: edit_step_params on this step with new faceNames (inspect_topology lists the current face names), or remove faceNames to ' +
  'select by faceIndices / facesNear again.';

/** Faces picked by point, or the problem (with the index in `near` of the offending point, when one point caused it). */
type PointPick = number[] | { readonly problem: string; readonly nearIndex?: number };

function facesByPoint(kernel: GeometryKernel, shape: ShapeHandle, near: readonly Vec3[]): PointPick {
  if (near.length === 0) return [];
  const hits = kernel.faceQuery?.distance(shape, near) ?? null;
  if (hits === null) return { problem: 'picking faces by point needs the exact face queries of the native kernel' };
  const mesh = kernel.tessellate(shape);
  const tolerance = 1e-3 * (mesh === null ? 1 : meshDiagonal(mesh)) + 1e-6;
  const far = hits.findIndex((hit) => hit.distance > tolerance);
  if (far >= 0)
    return {
      problem: `point ${far} (${(near[far] ?? []).join(', ')}) is not on the solid (nearest face ${hits[far]?.distance} away)`,
      nearIndex: far,
    };
  const unresolved = hits.findIndex((hit) => !Number.isInteger(hit.face) || hit.face < 0);
  if (unresolved >= 0)
    return {
      problem: `point ${unresolved} (${(near[unresolved] ?? []).join(', ')}) resolves to no single face of the solid (a pole, a seam or a split face): move it onto the interior of one face`,
      nearIndex: unresolved,
    };
  return hits.map((hit) => hit.face);
}

/** The faces `request` names on `shape` (see the module doc); [] is refused (a face operation needs at least one face). */
export function pickFaces(kernel: GeometryKernel, shape: ShapeHandle, topology: ShapeTopology | null, request: FaceRequest): FacePick {
  const names = request.names ?? [];
  if (names.length > 0 && hasNames(topology, 'face')) {
    const resolved = resolveNames(topology, 'face', names);
    if (resolved.ok) return { faces: resolved.indices, record: null, note: '' };
    const code = resolved.lost.length > 0 ? 'REF_LOST' : 'REF_SPLIT';
    return {
      problem: `${referenceProblem('face', resolved)}. ${REPICK_FACES}`,
      error: commandError(code, REPICK_FACES, [], ['faceNames']),
    };
  }
  const byPoint = facesByPoint(kernel, shape, request.near);
  if (!Array.isArray(byPoint)) return byPoint;
  const faces = [...new Set([...request.indices, ...byPoint])];
  if (faces.length === 0) return { problem: 'pick at least one face (faceIndices, facesNear or faceNames)' };
  const count = topology?.faces.length;
  const outOfRange = count === undefined ? [] : faces.filter((face) => face >= count);
  if (outOfRange.length > 0) return { problem: `face index ${outOfRange.join(', ')} out of range (the solid has ${count} faces)` };
  if (names.length > 0)
    return {
      faces,
      record: null,
      note: ' Face names not checked: this kernel keeps no history, faces re-picked by index / position (unverified).',
    };
  return { faces, record: namesOf(topology, 'face', faces), note: '' };
}
