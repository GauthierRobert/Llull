/** What a run says about its transmissions, end stops and friction models: heat per element, stop peaks and the ideal-gear note. */

import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import type { DynamicsModel } from '@core/model/dynamics';

/** Typical mesh efficiency of a real spur gear pair [E-R21], quoted in messages (never applied silently). */
const TYPICAL_MESH_EFFICIENCY = 0.99;

/** One warning per gear / belt that has no efficiency, i.e. is ideal: an engine realism run should state it. */
export function idealGearWarnings(dynamics: DynamicsModel): string[] {
  return Object.values(dynamics.transmissions ?? {})
    .filter((t) => (t.kind === 'gear' || t.kind === 'belt') && t.efficiency === undefined)
    .map(
      (t) =>
        `transmission '${t.id}' has no efficiency: it is ideal (1.0, no loss); a real spur mesh is about ${TYPICAL_MESH_EFFICIENCY} [E-R21] (add_transmission efficiency)`,
    );
}

/** Total heat J of the transmissions, friction models and stops at every sample (cumulative), empty when the run has none. */
export function heatSeries(trace: SimulationTrace): number[] {
  const heat = trace.heat;
  if (heat === undefined) return [];
  return trace.times.map((_, i) => heat.joules.reduce((sum, series) => sum + (series[i] ?? 0), 0));
}
