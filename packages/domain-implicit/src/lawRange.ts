/** Measured range of a graded law over a box (05 IMP FR-IMP-15: "the agent reads min / max of the realised value"). */

import type { FieldEngine } from '@core/geometry/field/engineTypes';
import type { CadDocument, Vec3 } from '@core/model/types';
import { compileScalarField } from './compile';
import type { Law } from './model';

const CELLS = 2 ** 17;

export interface LawRange {
  readonly min: number;
  readonly max: number;
  /** True for a number; false when sampled from a scalar field over the box. */
  readonly constant: boolean;
}

/** Range of `law` over `box`: the number itself, or the sample minimum / maximum on about 2^17 cells (a statement about samples, not a proof). */
export function lawRange(
  engine: FieldEngine,
  doc: CadDocument,
  law: Law,
  box: { readonly min: Vec3; readonly max: Vec3 } | null,
): LawRange | null {
  if (typeof law === 'number') return { min: law, max: law, constant: true };
  if (box === null) return null;
  const compiled = compileScalarField(doc, law);
  if (!compiled.ok) return null;
  const volume = (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
  const voxel = Math.max(Math.cbrt(volume / CELLS), 1e-9);
  const answer = engine.measure(compiled.program, { ...box, voxel }, null, { kind: 'quantile', probabilities: [0, 1], absolute: false });
  if (!answer.ok || answer.kind !== 'quantile') return null;
  const [min, max] = answer.values;
  return min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max) ? null : { min, max, constant: false };
}
