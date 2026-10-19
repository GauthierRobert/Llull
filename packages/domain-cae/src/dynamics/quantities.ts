/** PHY-09 probe quantities and the analysis types that own them. */

import type { AnalysisType, ProbeQuantity } from '@core/model/analysis';

/** Absolute acceleration (g) and displacement relative to the base (length unit): random_response probes only. */
export const DYNAMIC_PROBE_QUANTITIES = ['a_x', 'a_y', 'a_z', 'u_x_rel', 'u_y_rel', 'u_z_rel'] as const satisfies readonly ProbeQuantity[];
export type DynamicProbeQuantity = (typeof DYNAMIC_PROBE_QUANTITIES)[number];

/** Quantities a random_response probe can read: rms by modal superposition (stress components from the modal stresses). */
const RANDOM_PROBE_QUANTITIES: readonly ProbeQuantity[] = [...DYNAMIC_PROBE_QUANTITIES, 's_xx', 's_yy', 's_zz'];
/** Quantities a frequency_response probe can read: complex components of the CalculiX steady-state output. */
const FREQUENCY_PROBE_QUANTITIES: readonly ProbeQuantity[] = ['u_x', 'u_y', 'u_z', 's_xx', 's_yy', 's_zz'];

export const isDynamicType = (type: AnalysisType): type is 'frequency_response' | 'random_response' =>
  type === 'frequency_response' || type === 'random_response';

export const isDynamicQuantity = (quantity: ProbeQuantity): quantity is DynamicProbeQuantity =>
  (DYNAMIC_PROBE_QUANTITIES as readonly string[]).includes(quantity);

/** Quantities a probe of a case of `type` may read (null: every 05 quantity except the dynamic ones). */
export function probeQuantitiesOf(type: AnalysisType): readonly ProbeQuantity[] | null {
  if (type === 'random_response') return RANDOM_PROBE_QUANTITIES;
  return type === 'frequency_response' ? FREQUENCY_PROBE_QUANTITIES : null;
}
