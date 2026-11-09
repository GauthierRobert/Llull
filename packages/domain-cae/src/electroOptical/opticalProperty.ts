/** A PHY-01 optical value of a coating material read through evaluate_property (composed via execute): shared by optical_balance and check_surface_properties. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

export interface Value {
  readonly value: number;
  readonly provenance: string;
  readonly unverified: readonly string[];
}

export interface Missing {
  readonly code: string;
  readonly message: string;
}

/** A PHY-01 value of the coating material, or why it is not available. `at` is empty for a constant model. */
export function propertyOf(
  doc: CadDocument,
  material: string,
  property: string,
  condition: Record<string, string>,
  at: Record<string, { value: number; unit: string }>,
  ctx: ExecutionContext | undefined,
): Value | Missing {
  const answer = execute(doc, 'evaluate_property', { material, property, at, condition }, ctx);
  const data = answer.data;
  if (answer.rejected === true || !isRecord(data) || typeof data['value'] !== 'number' || !Number.isFinite(data['value']))
    return {
      code: isRecord(data) && typeof data['code'] === 'string' ? data['code'] : 'EOP_SURFACE_PROPERTY_MISSING',
      message: `${material} ${property} ${JSON.stringify(condition)}: ${answer.summary}`,
    };
  const citation =
    isRecord(data['provenance']) && typeof data['provenance']['citation'] === 'string' ? data['provenance']['citation'] : 'unsourced';
  const reasons = data['unverified'] === true && Array.isArray(data['unverifiedReasons']) ? data['unverifiedReasons'].map(String) : [];
  return {
    value: data['value'],
    provenance: `${material} ${property}: ${citation}`,
    unverified: data['unverified'] === true && reasons.length === 0 ? ['value is unverified'] : reasons,
  };
}

export const isMissing = (value: object): value is Missing => 'code' in value;
