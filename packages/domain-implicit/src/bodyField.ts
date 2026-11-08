/**
 * The field of an implicit body for a host-side job (14 FLL-M1: `fea_mesh` with mesh source implicit_field): the compiled program of the body's
 * field and the bounds it was realised in, after checking the body still matches its field.
 * @invariant bounds are those the body was realised with (explicit bounds, else the program's support box)
 * @invariant explicit bounds CLIP: the program is the sharp intersection of the field with the bounds box (the compiler's own box primitive and
 *   intersect), so the clip is an exact iso-surface of the FE solid and the mesher never cuts the field at its lattice border. The body's display
 *   mesh is not clipped this way (marching tetrahedra over the bounds padded by 2 voxels): bounds are the user's statement of the solid, the
 *   display mesh only shows it (14 FLL-D8)
 * @failure no body with that entity id -> FLL_IMPLICIT_FIELD_MISSING; field no longer compiles / unbounded / body older than its field ->
 *   IMP_BODY_STALE (run regenerate_implicit_bodies); a moved entity -> FLL_IMPLICIT_FIELD_MISSING
 */

import { DEFAULT_DETERMINISM } from '@core/geometry/field/engineTypes';
import type { FieldProgram } from '@core/geometry/field/program';
import type { CadDocument, Vec3 } from '@core/model/types';
import { compileField } from './compile';
import { bodyOf, type BooleanNode, type PrimitiveNode, withField } from './model';
import { bodyGrid, contentHashOf } from './realise';

export type BodyField =
  | {
      readonly ok: true;
      readonly field: string;
      readonly program: FieldProgram;
      readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
    }
  | { readonly ok: false; readonly code: 'FLL_IMPLICIT_FIELD_MISSING' | 'IMP_BODY_STALE'; readonly message: string };

const IDENTITY_TOLERANCE = 1e-12;

/** The field program and bounds of the implicit body whose derived entity is `entityId`. */
export function implicitBodyField(doc: CadDocument, entityId: string): BodyField {
  const body = bodyOf(doc, entityId);
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (body === undefined || entity === undefined)
    return {
      ok: false,
      code: 'FLL_IMPLICIT_FIELD_MISSING',
      message: `part '${entityId}' is not an implicit body (create_implicit_body): mesh source implicit_field meshes implicit bodies only; use source geometry for other solids`,
    };
  if ([...entity.position, ...entity.rotation].some((value) => Math.abs(value) > IDENTITY_TOLERANCE))
    return {
      ok: false,
      code: 'FLL_IMPLICIT_FIELD_MISSING',
      message: `implicit body '${entityId}' is placed away from its field (position / rotation not zero): transform the field (transform_field) instead`,
    };
  const stale = (why: string): BodyField => ({
    ok: false,
    code: 'IMP_BODY_STALE',
    message: `implicit body '${entityId}' ${why}: run regenerate_implicit_bodies, then fea_mesh`,
  });
  const compiled = compileField(doc, body.field);
  if (!compiled.ok) return stale(`no longer compiles (${compiled.code}: ${compiled.message})`);
  const bounds = body.explicitBounds === true ? body.bounds : compiled.program.bounds;
  if (bounds === null) return stale('has an unbounded field');
  const hash = contentHashOf(compiled.program, bodyGrid(bounds, body.voxel), { determinism: DEFAULT_DETERMINISM }, body.mesher);
  if (hash !== body.contentHash) return stale(`is older than its field '${body.field}'`);
  if (body.explicitBounds !== true) return { ok: true, field: body.field, program: compiled.program, bounds };
  const clipped = compileField(clippedDocument(doc, body.field, bounds), CLIP_ID);
  if (!clipped.ok) return stale(`cannot be clipped to its bounds (${clipped.code}: ${clipped.message})`);
  return { ok: true, field: body.field, program: clipped.program, bounds };
}

/** Ids of the two transient nodes of the clip (never stored: the document they live in is local to this function). */
const CLIP_BOX_ID = 'fll-clip-box';
const CLIP_ID = 'fll-clip';

/** `doc` with field ∩ box(bounds) as node CLIP_ID. */
function clippedDocument(doc: CadDocument, field: string, bounds: { readonly min: Vec3; readonly max: Vec3 }): CadDocument {
  const { min, max } = bounds;
  const box: PrimitiveNode = {
    id: CLIP_BOX_ID,
    op: 'primitive',
    shape: 'box',
    dims: { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    position: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    rotation: [0, 0, 0],
  };
  const clip: BooleanNode = { id: CLIP_ID, op: 'boolean', kind: 'intersect', operands: [field, CLIP_BOX_ID] };
  return withField(withField(doc, box), clip);
}
