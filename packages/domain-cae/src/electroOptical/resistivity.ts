/** Resistivity of a material through PHY-01 `evaluate_property` (composed via `execute`): shared by the bond check and `electrical_resistance`. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

export interface Resistivity {
  /** ohm m. */
  readonly rho: number;
  readonly unverified: boolean;
  readonly reasons: readonly string[];
  readonly provenance: string;
  /** How rho depends on T, named for the result (TR-EOP-11: `none` for a constant model). */
  readonly temperatureModel: string;
}

export interface Unavailable {
  readonly code: 'EOP_RESISTIVITY_UNAVAILABLE';
  readonly message: string;
}

/** rho (ohm m) of `material` at `temperature` (omitted for a constant model), or why it is unavailable. */
export function resistivityOf(
  doc: CadDocument,
  material: string,
  temperature: { readonly value: number; readonly unit: string } | undefined,
  ctx: ExecutionContext | undefined,
): Resistivity | Unavailable {
  const answer = execute(
    doc,
    'evaluate_property',
    { material, property: 'electricalResistivity', at: temperature === undefined ? {} : { T: temperature }, outputUnit: 'ohm*m' },
    ctx,
  );
  const data = answer.data;
  if (
    answer.rejected === true ||
    !isRecord(data) ||
    typeof data['value'] !== 'number' ||
    !Number.isFinite(data['value']) ||
    data['value'] <= 0
  )
    return {
      code: 'EOP_RESISTIVITY_UNAVAILABLE',
      message: `material '${material}': ${answer.error?.code ?? 'no value'} - ${answer.summary}`,
    };
  const provenance =
    isRecord(data['provenance']) && typeof data['provenance']['citation'] === 'string' ? data['provenance']['citation'] : 'unsourced';
  const reasons = Array.isArray(data['unverifiedReasons'])
    ? data['unverifiedReasons'].filter((reason): reason is string => typeof reason === 'string')
    : [];
  const kind = typeof data['form'] === 'string' ? data['form'] : 'unknown';
  return {
    rho: data['value'],
    temperatureModel: temperatureModelOf(kind, temperature),
    unverified: data['unverified'] === true,
    reasons,
    provenance: `${material}: ${provenance} (${String(data['method'] ?? 'model')})`,
  };
}

/** Plain name of a resistivity model's temperature dependence. */
function temperatureModelOf(kind: string, temperature: { readonly value: number; readonly unit: string } | undefined): string {
  if (kind === 'constant') return 'none (constant model)';
  const at = temperature === undefined ? '' : ` at ${temperature.value} ${temperature.unit}`;
  if (kind === 'linearCoefficient') return `linear temperature coefficient rho0 (1 + alpha (T - T0))${at}`;
  return `PHY-01 ${kind} model${at}`;
}
