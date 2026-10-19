/** Hill-1948 plasticity at one driver step: stiffness of any resolved elasticity, yield function and hardening at the step temperature. */

import type { LawOf, MaterialModel } from '../materialModel';
import { resolveIsotropic } from './hardening';
import { hillMatrix, type HillMaterial } from './hill';
import type { Matrix } from './linalg';
import { isLawFailure, type LawFailure, type ResolveEnv } from './resolve';

/**
 * @param stiffness elastic stiffness C (Voigt, engineering shear) of the set's elastic model, in the material axes
 * @param youngModulus E for a tangent-modulus hardening (isotropic elasticity), else null
 * @failure hardening refusals pass through (PROP_*, MATL_LAW_PARAMS_INVALID)
 */
export function resolveHill(
  plastic: MaterialModel,
  stiffness: Matrix,
  youngModulus: number | null,
  env: ResolveEnv,
  temperatureK: number | null,
): HillMaterial | LawFailure {
  const law = plastic.model as LawOf<'hill48_plasticity'>;
  const isotropic = resolveIsotropic(law.isotropic, env, youngModulus, temperatureK, `models.${plastic.id}.isotropic`);
  if (isLawFailure(isotropic)) return isotropic;
  return { C: stiffness, P: hillMatrix(law), yieldStress: isotropic.stress, referenceYield: isotropic.y0 };
}
