/** Validation of a graded law (a number or a scalar field id) at command time: the scalar exists and, when its range is known, fits the interval the command allows. */

import type { CadDocument } from '@core/model/types';
import { compileScalarField } from './compile';
import { type Law, fieldOf } from './model';

export interface LawProblem {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

/** Declared range of a scalar (infinite ends when unknown) or the problem with the reference. */
function scalarRangeOf(doc: CadDocument, id: string): { lo: number; hi: number } | LawProblem {
  const node = fieldOf(doc, id);
  if (node === undefined) return { code: 'IMP_FIELD_NOT_FOUND', message: `no scalar field '${id}'`, ids: [id] };
  if (node.op !== 'scalar')
    return { code: 'IMP_PARAM_RANGE', message: `'${id}' is not a scalar field (create one with create_scalar_field)`, ids: [id] };
  const compiled = compileScalarField(doc, id);
  if (!compiled.ok) return { code: compiled.code, message: compiled.message, ids: compiled.ids };
  return compiled.scalarRange ?? { lo: -Infinity, hi: Infinity };
}

export const isLawProblem = (value: { lo: number; hi: number } | LawProblem): value is LawProblem => 'code' in value;

/** Range of a law: the number itself, or the declared range of the scalar field. */
export function lawBounds(doc: CadDocument, law: Law): { lo: number; hi: number } | LawProblem {
  return typeof law === 'number' ? { lo: law, hi: law } : scalarRangeOf(doc, law);
}
