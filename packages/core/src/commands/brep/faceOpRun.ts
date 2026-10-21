/**
 * Shared body of the face operations (SC-F1: draft_faces, push_pull_face, split_face, replace_face): validate the solid, pick the faces
 * (index / point / persistent name, `faceReferences`), build one `faceOp` recipe node over the operand's exact recipe, replace the source
 * by the result, and record the picked faces' names for regeneration. Needs an exact kernel with face operations (the native OCC kernel);
 * any other kernel refuses with the reason.
 */

import type { CadDocument, Vec3 } from '../../model/types';
import type { FaceOpParams } from '../../model/faceOps';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import type { CommandResult, ExecutionContext } from '../types';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop } from '../noop';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { OCC_KERNEL_HINT, validateSolidTarget } from './modifyTarget';
import { pickFaces, type FaceRequest } from './faceReferences';

export interface FaceOpContext {
  readonly kernel: GeometryKernel;
  readonly shape: ShapeHandle;
  readonly topology: ShapeTopology | null;
  readonly faces: readonly number[];
}

export interface FaceOpRequest {
  readonly command: string;
  readonly id: string;
  readonly pick: FaceRequest;
  /** The node parameters for the picked faces, or why they do not fit (wrong surface, nothing to do). */
  readonly build: (context: FaceOpContext) => FaceOpParams | string;
  readonly describe: (params: FaceOpParams) => string;
}

/** @failure missing / non-solid target, no kernel, kernel without face operations, bad pick, `build` refusal, kernel refusal -> no-op */
export function runFaceOp(doc: CadDocument, ctx: ExecutionContext | undefined, request: FaceOpRequest): CommandResult {
  const { command, id } = request;
  const fail = (why: string): CommandResult => noop(doc, `${command}: ${why}; document unchanged.`);
  const validation = validateSolidTarget(doc, command, id);
  if ('summary' in validation) return validation;
  const { entity } = validation;
  const kernel = (ctx ?? currentContext()).kernel;
  if (!kernel) return noop(doc, kernelUnavailable(command));
  if (!kernel.supports('faceOp')) return fail(`face operations need the exact B-rep of ${OCC_KERNEL_HINT}`);
  const source = operandRecipe(kernel, entity);
  const shape = kernel.evaluate(source);
  if (shape === null) return fail(`kernel could not build entity '${id}' (kind '${entity.kind}')`);
  const topology = kernel.topology(shape);
  const pick = pickFaces(kernel, shape, topology, request.pick);
  if ('problem' in pick)
    return pick.error === undefined ? fail(`${pick.problem} on '${id}'`) : { ...fail(`${pick.problem} on '${id}'`), error: pick.error };
  const params = request.build({ kernel, shape, topology, faces: pick.faces });
  if (typeof params === 'string') return fail(`${params} on '${id}'`);
  const result = evaluateRecipe(kernel, { op: 'faceOp', source, ...params });
  if (typeof result === 'string')
    return fail(`the kernel could not ${request.describe(params)} into a valid solid (${result}); try a smaller value or other faces`);
  const committed = commitKernelResult(
    doc,
    kernel,
    result,
    [entity],
    (newId, triangles) =>
      `${command}: ${request.describe(params)} on '${id}' → mesh '${newId}' (${triangles} triangles). Source entity consumed.${pick.note}`,
  );
  return pick.record === null ? committed : { ...committed, recordExtras: { faceNames: pick.record } };
}

/** Outward normal and a point of planar face `face` (exact face queries), or why there is none. */
export function planarFace(context: FaceOpContext, face: number): { readonly normal: Vec3; readonly point: Vec3 } | string {
  const details = context.kernel.faceQuery?.faceDetails(context.shape, { samples: 0 }) ?? null;
  const detail = details?.[face];
  if (detail === undefined) return `face ${face} has no exact geometry (needs the native kernel's face queries)`;
  if (detail.surface !== 'plane' || detail.normal === undefined) return `face ${face} is ${detail.surface}, not planar`;
  return { normal: detail.normal, point: detail.centroid };
}
