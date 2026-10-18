/** Assembles the strengths a mean-stress model needs from the material record (Ftu, Fty, sigma'f). */

import type { MeanStressModel } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { toMpa, type MeanModelName, type MeanStressInputs } from './lifeMath';
import { strengthMpa, type CurveOf } from './curves';

export const meanModelName = (model: MeanStressModel): MeanModelName => (typeof model === 'string' ? model : 'walker');
export const walkerGamma = (model: MeanStressModel): number | undefined => (typeof model === 'string' ? undefined : model.walker);

/**
 * Mean-stress inputs for `model` on `curve` of record `recordId`.
 * @failure a required strength is missing (Goodman / Gerber: Ftu; Soderberg: Fty; Morrow: Basquin sigmaF) -> { missing }
 */
export function meanInputsFor(
  doc: CadDocument,
  recordId: string,
  model: MeanStressModel,
  compressiveMean: 'no_benefit' | 'formula',
  curve: CurveOf<'sn_basquin'> | CurveOf<'sn_power_law'> | CurveOf<'sn_table'>,
): MeanStressInputs | { readonly missing: string } {
  const name = meanModelName(model);
  const gamma = walkerGamma(model);
  const base = { model: name, compressiveMean, ...(gamma !== undefined ? { gamma } : {}) };
  if (name === 'goodman' || name === 'gerber') {
    const su = strengthMpa(doc, recordId, 'Ftu');
    return su === null ? { missing: `${name} needs Ftu on record '${recordId}'` } : { ...base, su };
  }
  if (name === 'soderberg') {
    const sy = strengthMpa(doc, recordId, 'Fty');
    return sy === null ? { missing: `soderberg needs Fty on record '${recordId}'` } : { ...base, sy };
  }
  if (name === 'morrow') {
    const sigmaF = curve.kind === 'sn_basquin' ? toMpa(curve.sigmaF) : null;
    return sigmaF === null ? { missing: 'morrow needs an sn_basquin curve (sigma_f)' } : { ...base, sigmaF };
  }
  return base;
}
