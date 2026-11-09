/** Material-property binding (PHY-01 -> PHY-18, TR-PRB-10): the distribution of a random variable derived from a property model's uncertainty band. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { normalInv } from './numerics';
import type { Distribution, DerivedScatter, MaterialPropertyBinding } from '@cae/reliability/types';

export interface Derived {
  readonly distribution: Distribution;
  readonly derivedFrom: DerivedScatter;
}
export interface Underivable {
  readonly code: string;
  readonly message: string;
}

/**
 * Normal (or lognormal, same mean and sd) distribution from the PHY-01 band of a property at the study condition: sd = h / Φ⁻¹((1 + c) / 2).
 * @invariant a 'statistical' band needs its coverage c, a 'measurement' band the binding's measurementCoverage; 'fitErrorVsData' (fit quality, not population scatter) and a model without uncertainty are refused
 * @failure unresolvable material / model / out-of-range -> PRB_BINDING_UNRESOLVED; unsuitable band -> PRB_SCATTER_KIND_UNSUITABLE; zero or non-finite width -> PRB_DISTRIBUTION_INVALID
 */
export function deriveMaterialDistribution(
  doc: CadDocument,
  binding: MaterialPropertyBinding,
  shape: 'normal' | 'lognormal',
  ctx: ExecutionContext | undefined,
): Derived | Underivable {
  const evaluated = execute(
    doc,
    'evaluate_property',
    {
      material: binding.material,
      property: binding.property,
      at: binding.at ?? {},
      band: true,
      ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
    },
    ctx,
  );
  const data: unknown = evaluated.data;
  if (evaluated.error !== undefined || !isRecord(data) || data['available'] === false || typeof data['value'] !== 'number')
    return { code: 'PRB_BINDING_UNRESOLVED', message: `evaluate_property ${binding.material}.${binding.property}: ${evaluated.summary}` };
  const band = data['band'];
  if (!isRecord(band) || typeof band['low'] !== 'number' || typeof band['high'] !== 'number')
    return {
      code: 'PRB_SCATTER_KIND_UNSUITABLE',
      message: `the property model of ${binding.material}.${binding.property} has no uncertainty band: add one in PHY-01 or give a cited distribution`,
    };
  const kind = String(band['kind']);
  const coverage =
    kind === 'measurement' ? binding.measurementCoverage : typeof band['coverage'] === 'number' ? band['coverage'] : undefined;
  if (kind === 'fitErrorVsData')
    return {
      code: 'PRB_SCATTER_KIND_UNSUITABLE',
      message: 'the band is a fit error against data, not population scatter: give a cited distribution',
    };
  if (coverage === undefined || !(coverage > 0 && coverage < 1))
    return {
      code: 'PRB_SCATTER_KIND_UNSUITABLE',
      message:
        kind === 'measurement'
          ? "a 'measurement' band needs binding.measurementCoverage in (0, 1)"
          : 'the statistical band has no coverage: add it in PHY-01 or give a cited distribution',
    };
  const value = data['value'];
  const halfWidth = (band['high'] - band['low']) / 2;
  const sd = halfWidth / normalInv((1 + coverage) / 2);
  if (!(sd > 0) || !Number.isFinite(sd) || (shape === 'lognormal' && !(value > 0)))
    return { code: 'PRB_DISTRIBUTION_INVALID', message: `derived mean ${value} and sd ${sd} do not make a ${shape} distribution` };
  const reasons = Array.isArray(data['unverifiedReasons']) ? data['unverifiedReasons'].map(String) : [];
  return {
    distribution: { kind: shape, mean: value, sd },
    derivedFrom: { modelId: String(data['modelId']), uncertaintyKind: kind, coverage, value, halfWidth, unverifiedReasons: reasons },
  };
}
