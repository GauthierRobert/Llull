/**
 * Energy ledger of a run with datasheet motors (PHY-23 TR-DRV-19): where every joule went, per element, and how well the books close.
 * input = electrical energy in (net of regeneration) + mechanical work of the non-motor loads; sinks = copper, gearhead, friction / damping,
 * propellers; stored = Δ kinetic + Δ potential + magnetic. closure = input - sinks - stored.
 */

import type { ActuatorBlock, LedgerKind, SimulationTrace } from '@core/dynamics/physicsEngine';
import type { EnergyData } from './energyReport';
import { heatSeries } from './transmissionReport';

interface LedgerEntryData {
  readonly element: string;
  readonly kind: LedgerKind | 'friction_damping' | 'friction' | 'stop' | 'propeller' | 'kinetic' | 'potential' | 'external_work';
  /** J at the end of the run (signed: regeneration and a falling potential are negative). */
  readonly joules: number;
}

export interface LedgerData {
  readonly entries: readonly LedgerEntryData[];
  readonly inputJ: number;
  readonly dissipatedJ: number;
  readonly storedChangeJ: number;
  /** input - dissipated - stored change, J. */
  readonly closureErrorJ: number;
  /** |closureErrorJ| / the largest term; the gate is 1e-3 (pass), 1e-2 (warn). */
  readonly closureRelative: number;
  readonly closure: 'pass' | 'warn' | 'fail';
}

const last = (values: readonly number[] | undefined): number => values?.[values.length - 1] ?? 0;

/**
 * The ledger of a run with energy recording and actuators or engine-measured heat (transmissions, friction models, end stops), or null.
 * The heat entries are part of `energy.dissipatedJ`: they are listed apart from the 'joints' line (damping and constant friction).
 */
export function ledgerOf(layout: ActuatorBlock['ledgerLayout'], trace: SimulationTrace, energy: EnergyData | undefined): LedgerData | null {
  const recorded = trace.ledger ?? [];
  if ((trace.ledger === undefined && trace.heat === undefined) || energy === undefined) return null;
  const { inputWorkJ, propellerWorkJ } = energy;
  if (inputWorkJ === undefined || propellerWorkJ === undefined) return null;
  const entries: LedgerEntryData[] = layout.map((entry, k) => ({ element: entry.element, kind: entry.kind, joules: last(recorded[k]) }));
  const heatEntries: LedgerEntryData[] = (trace.heat?.layout ?? []).map((entry, k) => ({
    element: entry.element,
    kind: entry.kind,
    joules: last(trace.heat?.joules[k]),
  }));
  const heatTotal = last(heatSeries(trace));
  const sum = (kind: LedgerKind): number =>
    entries.filter((entry) => entry.kind === kind).reduce((total, entry) => total + entry.joules, 0);
  const externalWork = inputWorkJ - last(trace.actuatorWork);
  const dissipated = sum('copper') + sum('iron') + sum('rotor') + sum('transmission_loss') + energy.dissipatedJ + propellerWorkJ;
  const stored = energy.finalTotalJ - energy.initialTotalJ + sum('magnetic');
  const input = sum('electrical_input') + externalWork;
  const error = input - dissipated - stored;
  const largest = Math.max(Math.abs(input), dissipated, Math.abs(stored), 0);
  const relative = largest > 0 ? Math.abs(error) / largest : 0;
  return {
    entries: [
      ...entries,
      ...heatEntries,
      { element: 'joints', kind: 'friction_damping', joules: energy.dissipatedJ - heatTotal },
      { element: 'propellers', kind: 'propeller', joules: propellerWorkJ },
      { element: 'mechanism', kind: 'kinetic', joules: energy.finalKineticJ - (trace.energy?.kinetic[0] ?? 0) },
      { element: 'mechanism', kind: 'potential', joules: energy.finalPotentialJ - (trace.energy?.potential[0] ?? 0) },
      { element: 'loads', kind: 'external_work', joules: externalWork },
    ],
    inputJ: input,
    dissipatedJ: dissipated,
    storedChangeJ: stored,
    closureErrorJ: error,
    closureRelative: relative,
    closure: relative <= 1e-3 ? 'pass' : relative <= 1e-2 ? 'warn' : 'fail',
  };
}
