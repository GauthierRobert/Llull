/** Material property reads of the space-environment pack: through the registry (`evaluate_property`, PHY-01), never the model internals. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import type { Quantity } from './types';

export interface MaterialValue {
  readonly value: number;
  readonly unit: string;
  readonly unverified: boolean;
  readonly source: string;
  readonly modelId: string;
}

/** The property could not be read: `code` is the PHY-01 / MAT refusal (PROP_NO_MODEL_FOR_PROPERTY, PROP_OUT_OF_RANGE, MAT_RECORD_NOT_FOUND ...). */
export interface MaterialMissing {
  readonly code: string;
  readonly reason: string;
}

export const isMissing = (value: MaterialValue | MaterialMissing): value is MaterialMissing => 'reason' in value;

const sourceText = (provenance: unknown): string => {
  if (!isRecord(provenance)) return 'no provenance';
  const parts = [provenance['citation'], provenance['locator'], provenance['sourceId']].filter(
    (part): part is string => typeof part === 'string',
  );
  return parts.length > 0 ? parts.join(', ') : 'no provenance';
};

/** One material property at an operating point, converted to `outputUnit`; the evaluation's `unverified` flag is kept. */
export function materialProperty(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  material: string,
  property: string,
  outputUnit: string,
  at: Readonly<Record<string, Quantity>> = {},
  direction?: string,
): MaterialValue | MaterialMissing {
  const evaluated = execute(
    doc,
    'evaluate_property',
    { material, property, at, outputUnit, ...(direction === undefined ? {} : { direction }) },
    ctx,
  );
  const data: unknown = evaluated.data;
  if (!isRecord(data)) return { code: 'ENV_PROPERTY_MISSING', reason: evaluated.summary };
  if (data['available'] === false || typeof data['value'] !== 'number')
    return { code: String(data['code'] ?? 'ENV_PROPERTY_MISSING'), reason: String(data['reason'] ?? evaluated.summary) };
  return {
    value: data['value'],
    unit: String(data['unit'] ?? outputUnit),
    unverified: data['unverified'] !== false,
    source: sourceText(data['provenance']),
    modelId: String(data['modelId'] ?? ''),
  };
}
