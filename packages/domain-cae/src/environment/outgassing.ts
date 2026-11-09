/** Outgassing screening of one material against a profile (PHY-14 FR-ENV-01..03, 05; TR-ENV-02, 03). Reads values only through `evaluate_property`. */

import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isMissing, materialProperty, type MaterialMissing, type MaterialValue } from './materialValue';
import { meetsLimit } from './profiles';
import type { OutgassingLimit, OutgassingProfile } from './types';

type ItemStatus = 'pass' | 'fail' | 'unknown';

/** One limit judged for one material. */
export interface OutgassingItem {
  readonly material: string;
  readonly entityIds: readonly string[];
  readonly quantity: OutgassingLimit['quantity'];
  readonly op: OutgassingLimit['op'];
  readonly limit: number;
  readonly unit: '%';
  readonly value: number | null;
  readonly status: ItemStatus;
  /** ENV_OUTGASSING_DATA_MISSING (unknown) or ENV_OUTGASSING_FAIL (fail); absent for a pass. */
  readonly code?: string;
  readonly derived: boolean;
  readonly unverified: boolean;
  /** Where the value comes from (record provenance), or why there is none. */
  readonly valueSource: string;
  readonly ruleSource: string;
  readonly reviewRequired: true;
  readonly message: string;
}

export interface MaterialOutgassing {
  readonly TML: MaterialValue | MaterialMissing;
  readonly CVCM: MaterialValue | MaterialMissing;
  readonly WVR: MaterialValue | MaterialMissing;
  readonly RML: MaterialValue | MaterialMissing;
}

/** The four E595 / ECSS quantities of a material, in percent. */
export function outgassingOf(doc: CadDocument, ctx: ExecutionContext | undefined, material: string): MaterialOutgassing {
  const read = (property: string): MaterialValue | MaterialMissing => materialProperty(doc, ctx, material, property, '%');
  return { TML: read('TML'), CVCM: read('CVCM'), WVR: read('WVR'), RML: read('RML') };
}

interface Resolved {
  readonly value: number;
  readonly derived: boolean;
  readonly unverified: boolean;
  readonly source: string;
}

/** The value a limit on `quantity` judges: the measured one, RML derived as TML - WVR (TR-ENV-03), or why there is none. */
function resolveQuantity(data: MaterialOutgassing, quantity: OutgassingLimit['quantity']): Resolved | string {
  const direct = data[quantity];
  if (!isMissing(direct)) return { value: direct.value, derived: false, unverified: direct.unverified, source: direct.source };
  if (quantity !== 'RML') return `no ${quantity} value on the material (${direct.code}: ${direct.reason})`;
  const { TML, WVR } = data;
  if (isMissing(TML) || isMissing(WVR))
    return `no RML, and it cannot be derived as TML - WVR (TML ${isMissing(TML) ? 'missing' : 'present'}, WVR ${isMissing(WVR) ? 'missing' : 'present'})`;
  return {
    value: TML.value - WVR.value,
    derived: true,
    unverified: TML.unverified || WVR.unverified,
    source: `TML - WVR (${TML.source}; ${WVR.source})`,
  };
}

/** Judge every limit of `profile` for one material; a missing value is `unknown`, never a pass. */
export function screenMaterial(
  material: string,
  entityIds: readonly string[],
  data: MaterialOutgassing,
  profile: OutgassingProfile,
): OutgassingItem[] {
  return profile.limits.map((limit): OutgassingItem => {
    const resolved = resolveQuantity(data, limit.quantity);
    const base = {
      material,
      entityIds,
      quantity: limit.quantity,
      op: limit.op,
      limit: limit.value,
      unit: '%' as const,
      ruleSource: `${profile.id}: ${profile.source}`,
      reviewRequired: true as const,
    };
    if (typeof resolved === 'string')
      return {
        ...base,
        value: null,
        status: 'unknown',
        code: 'ENV_OUTGASSING_DATA_MISSING',
        derived: false,
        unverified: true,
        valueSource: resolved,
        message: `${material}: ${limit.quantity} ${resolved}; status unknown (never a pass)`,
      };
    const pass = meetsLimit(resolved.value, limit);
    return {
      ...base,
      value: resolved.value,
      status: pass ? 'pass' : 'fail',
      ...(pass ? {} : { code: 'ENV_OUTGASSING_FAIL' }),
      derived: resolved.derived,
      unverified: resolved.unverified,
      valueSource: resolved.source,
      message: `${material}: ${limit.quantity} ${resolved.value.toPrecision(6)} % ${pass ? 'meets' : 'does not meet'} ${limit.op} ${limit.value} %${resolved.derived ? ' (RML derived as TML - WVR)' : ''}`,
    };
  });
}
