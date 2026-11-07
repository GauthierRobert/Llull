/** What a `simulate_motion` result carries beyond SimulationData that the drive checks read (sizing, truth, plots), and how to recognise it. */

import { isRecord } from '@lib/isRecord';
import type { CommandResult } from '@core/commands/types';
import type { DriveRunData } from './driveReport';
import type { SimulationData } from './simulationReport';

export interface RunData extends SimulationData {
  /** Per datasheet motor with a drive (simulate_motion detail "drives" adds the series). */
  readonly drives?: Record<string, DriveRunData>;
  /** Peak penetration (rad or m) and force of every end stop / backlash row, with the inertia its damping was scaled to. */
  readonly stops?: Record<string, { readonly peakPenetration: number; readonly peakForce: number; readonly effectiveInertia: number }>;
  readonly loops?: {
    readonly count: number;
    readonly ids: string[];
    readonly residualM: number | null;
    readonly tier: 'pass' | 'warn' | 'fail';
    readonly passM: number;
    readonly failM: number;
  };
}

/** The data of a simulate_motion result that ran, or null (a refusal carries no data). */
export function runDataOf(result: CommandResult): RunData | null {
  const data = result.data;
  return isRecord(data) && 'joints' in data && 'timestep' in data && 'series' in data ? (data as unknown as RunData) : null;
}

/** simulate_motion's refusal text without its command prefix, for a "the simulation did not run: ..." note. */
export const refusalText = (summary: string): string => summary.replace(/^simulate_motion:\s*/, '').replace(/;\s*no-op\.$/, '');
