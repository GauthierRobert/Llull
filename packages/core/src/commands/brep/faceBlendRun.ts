/**
 * Shared body of the face blends (BLD M4: fillet_faces, fillet_full_round): validate the solid, pick each named face set (points and/or
 * persistent names, `faceReferences`), refuse empty or overlapping sets with stable codes, build one recipe node over the operand's exact
 * shape, replace the source by the result, and record the picked faces' names so regeneration re-picks the same faces.
 * @failure missing / non-solid target, no kernel, an empty or overlapping set, a lost face name, a kernel refusal -> unchanged document
 */

import type { CadDocument, ShapeRecipe, Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { codedRejection, noop } from '../noop';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { remediationOf } from '../../geometry/blend/diagnose';
import { blendSource } from '../../geometry/blend/continuity';
import { validateSolidTarget } from './modifyTarget';
import { pickFaces } from './faceReferences';
import { blendRefusal } from './blendRefusal';
import { vec3, z } from '../schema';

export const faceSetSchema = z
  .object({
    near: z
      .array(vec3('A point [x, y, z] in document units on the face (the face nearest to it is taken; it must be on the solid).'))
      .describe('Points on the faces of the set; each picks the face it lies on (inspect_faces lists faces and centres).')
      .optional(),
    names: z
      .array(z.string().min(1))
      .describe(
        'Persistent face names (inspect_topology): recorded automatically from the first pick and used on regeneration; a name that is gone or split refuses the step (REF_LOST / REF_SPLIT). Win over near.',
      )
      .optional(),
  })
  .describe('A set of faces, picked by points on them and/or persistent names.');

export type FaceSetInput = z.infer<typeof faceSetSchema>;

/** A refusal decided while building the node: stable code, message and the param path it is about. */
export interface BlendProblem {
  readonly code: FaceBlendCode;
  readonly message: string;
  readonly path: string;
}

export interface BlendContext {
  readonly kernel: GeometryKernel;
  readonly shape: ShapeHandle;
  readonly topology: ShapeTopology | null;
  readonly source: ShapeRecipe;
  /** The unique face indices picked for each named set. */
  readonly picked: Readonly<Record<string, readonly number[]>>;
}

export type BlendBuild = { readonly recipe: ShapeRecipe } | { readonly result: CommandResult } | BlendProblem;

export interface FaceBlendRequest {
  readonly command: 'fillet_faces' | 'fillet_full_round';
  readonly id: string;
  /** The face sets in the order of the command's params; each key is the param name. */
  readonly sets: Readonly<Record<string, FaceSetInput>>;
  readonly build: (context: BlendContext) => BlendBuild;
  /** The summary tail after "<command>: ", given the new id. */
  readonly describe: (newId: string, triangles: number) => string;
}

const nameOf = (topology: ShapeTopology | null, face: number): string => topology?.faces[face]?.name ?? `face ${face}`;

/** Names of the faces of `before` that are no longer faces of `after` (by persistent name), the faces a blend consumed. */
function consumedFaces(before: ShapeTopology | null, after: ShapeTopology | null): string[] {
  if (before === null || after === null) return [];
  const kept = new Set(after.faces.map((face) => face.name));
  return before.faces.flatMap((face) => (face.name === undefined || kept.has(face.name) ? [] : [face.name]));
}

export function runFaceBlend(doc: CadDocument, ctx: ExecutionContext | undefined, request: FaceBlendRequest): CommandResult {
  const { command, id } = request;
  const refuse = (code: FaceBlendCode, message: string, path: string): CommandResult =>
    codedRejection(doc, command, code, message, REMEDIATION[code], [id], [path]);
  const validation = validateSolidTarget(doc, command, id);
  if ('summary' in validation) return validation;
  const { entity } = validation;
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable(command));
  const source = operandRecipe(kernel, entity);
  const shape = kernel.evaluate(source);
  if (shape === null) return noop(doc, `${command}: kernel could not build entity '${id}' (kind '${entity.kind}'); document unchanged.`);
  const topology = kernel.topology(shape);
  if (topology === null || kernel.faceQuery === undefined)
    return noop(
      doc,
      `${command}: needs the exact native kernel (check kernel_info): this kernel has no faces to pick; document unchanged.`,
    );
  const picked: Record<string, number[]> = {};
  const recorded: Record<string, { near?: Vec3[]; names: string[] }> = {};
  for (const [key, set] of Object.entries(request.sets)) {
    if ((set.near ?? []).length === 0 && (set.names ?? []).length === 0)
      return refuse('BLD_FACESET_EMPTY', `${key} names no face: give points on the face (near) or persistent names`, key);
    const pick = pickFaces(kernel, shape, topology, { indices: [], near: set.near ?? [], names: set.names });
    if ('problem' in pick)
      return pick.error === undefined
        ? refuse('BLD_FACESET_EMPTY', `${key}: ${pick.problem}`, `${key}.near`)
        : {
            ...noop(doc, `${command}: ${pick.problem} on '${id}'; document unchanged.`),
            rejected: true,
            error: { ...pick.error, ids: [id], paths: [`${key}.names`] },
          };
    picked[key] = pick.faces;
    if (pick.record !== null) recorded[key] = { ...(set.near === undefined ? {} : { near: [...set.near] }), names: pick.record };
  }
  const keys = Object.keys(picked);
  for (const [at, key] of keys.entries())
    for (const other of keys.slice(at + 1)) {
      const shared = (picked[key] ?? []).filter((face) => (picked[other] ?? []).includes(face));
      if (shared.length > 0)
        return refuse(
          'BLD_FACESETS_OVERLAP',
          `${key} and ${other} both contain ${shared.map((face) => nameOf(topology, face)).join(', ')}`,
          other,
        );
    }
  const built = request.build({ kernel, shape, topology, source, picked });
  const withNames = (result: CommandResult): CommandResult =>
    Object.keys(recorded).length === 0 ? result : { ...result, recordExtras: recorded };
  if ('result' in built) return withNames(built.result);
  if ('code' in built) return refuse(built.code, built.message, built.path);
  const result = evaluateRecipe(kernel, built.recipe);
  if (typeof result === 'string') return blendRefusal(doc, command, id, kernel, built.recipe, result, topology);
  const after = kernel.topology(result.shape);
  const committed = commitKernelResult(doc, kernel, result, [entity], (newId, triangles) => request.describe(newId, triangles));
  return withNames({ ...committed, data: faceBlendData(topology, after, committed.affected[0], doc.units) });
}

/** The `data` of a face-blend result: the new entity id, its blend faces (by persistent name), the faces the blend consumed, the unit. */
export function faceBlendData(
  before: ShapeTopology | null,
  after: ShapeTopology | null,
  id: string | undefined,
  unit: string,
): { id: string | undefined; blends: Array<{ face: number; name: string }>; consumedFaces: string[]; unit: string } {
  const blends = (after?.faces ?? []).flatMap((face) =>
    face.name !== undefined && blendSource(face.name) !== null ? [{ face: face.index, name: face.name }] : [],
  );
  return { id, blends, consumedFaces: consumedFaces(before, after), unit };
}

const REMEDIATION = {
  BLD_FACESET_EMPTY:
    'pick points on the intended faces (inspect_faces lists faces with their centres) or give persistent face names (inspect_topology)',
  BLD_FACESETS_OVERLAP: remediationOf('BLD_FACESETS_OVERLAP'),
  BLD_HOLD_LINE_NOT_ON_FACE: 'draw the curve on the face (draw_polyline with position on the face plane) and name that face with onFaces',
  BLD_FACE_FILLET_NO_SOLUTION: remediationOf('BLD_FACE_FILLET_NO_SOLUTION'),
  BLD_FACE_BLEND_UNSUPPORTED: remediationOf('BLD_FACE_BLEND_UNSUPPORTED'),
  BLD_FULL_ROUND_NOT_OPPOSED: remediationOf('BLD_FULL_ROUND_NOT_OPPOSED'),
  BLD_FULL_ROUND_NO_SOLUTION: remediationOf('BLD_FULL_ROUND_NO_SOLUTION'),
} as const satisfies Record<string, string>;

/** The stable codes a face blend refuses with before or after the kernel. */
export type FaceBlendCode = keyof typeof REMEDIATION;

/** The unique face indices picked for the set `key` (the runner picked every set its command declared). */
export const pickedFaces = (context: BlendContext, key: string): number[] => [...(context.picked[key] ?? [])];
