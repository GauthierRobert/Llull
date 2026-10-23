/**
 * Realise a field as a closed triangle mesh through the field engine (05 IMP 5.7). The same function serves create_implicit_body and the
 * re-derivation on load, so a body and its reload are byte-identical for one engine.
 * @invariant the grid is the bounds padded by 2 voxels; the content hash covers the compiled program, grid, mesher and engine major version
 */

import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { FieldMeshResult, FieldRefusal } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument, MeshData, Vec3 } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { type CompileWarning, compileField } from './compile';

/** Bumped when the tape semantics or the mesher change what the same program realises. */
const ENGINE_MAJOR = 1;
const PAD_VOXELS = 2;

export interface RealiseRequest {
  readonly field: string;
  readonly voxel: number;
  /** Bounds to realise (default: the program's support box). */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | null;
  readonly maxTriangles: number;
}

export interface Realised {
  readonly ok: true;
  readonly program: FieldProgram;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly mesh: MeshData;
  readonly result: FieldMeshResult;
  readonly contentHash: string;
  readonly warnings: readonly CompileWarning[];
  readonly unverified: boolean;
  readonly minFeature: number;
}

export interface RealiseFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

const failureOf = (refusal: FieldRefusal, field: string): RealiseFailure => ({
  ok: false,
  code: refusal.code,
  message: refusal.message,
  ids: [field],
});

/** Compile `request.field` of `doc` and mesh it on `engine`. */
export function realiseField(doc: CadDocument, request: RealiseRequest, engine: FieldEngine): Realised | RealiseFailure {
  const compiled = compileField(doc, request.field);
  if (!compiled.ok) return compiled;
  const { program } = compiled;
  const bounds = request.bounds ?? program.bounds;
  if (bounds === null)
    return {
      ok: false,
      code: 'IMP_FIELD_UNBOUNDED',
      message: `field '${request.field}' has no finite support (a bare lattice or plane) and no bounds were given`,
      ids: [request.field],
    };
  const pad = PAD_VOXELS * request.voxel;
  const grid = {
    min: [bounds.min[0] - pad, bounds.min[1] - pad, bounds.min[2] - pad] as Vec3,
    max: [bounds.max[0] + pad, bounds.max[1] + pad, bounds.max[2] + pad] as Vec3,
    voxel: request.voxel,
  };
  const result = engine.mesh(program, grid, { mesher: 'tetra', maxTriangles: request.maxTriangles });
  if (!result.ok) return failureOf(result, request.field);
  if (result.mesh.indices.length === 0)
    return { ok: false, code: 'IMP_BODY_EMPTY', message: `no sample of field '${request.field}' is inside the grid`, ids: [request.field] };
  return {
    ok: true,
    program,
    bounds,
    mesh: result.mesh,
    result,
    contentHash: sha256Hex(canonicalJson({ program, grid, mesher: 'tetra', engineMajor: ENGINE_MAJOR, engine: engine.name })),
    warnings: compiled.warnings,
    unverified: compiled.unverified,
    minFeature: compiled.minFeature,
  };
}
