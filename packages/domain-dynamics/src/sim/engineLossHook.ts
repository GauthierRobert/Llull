/**
 * Injection point for the engine friction law (TECHNICAL_SPEC 11 Q3: generic dynamics never imports the engine folder). The engine folder
 * installs its law (`commands/dynamics/engine/hooks.ts`, called by the dynamics catalog); without it a model with losses is refused.
 */

import type { EngineLosses } from '@core/model/dynamics';
import type { CylinderRuntime } from './cylinderLoads';
import type { AppliedLoads, SimulationState } from '@core/dynamics/physicsEngine';

type Loads = (state: SimulationState) => AppliedLoads;

/** `base` loads plus the friction torque of every loss record. */
export type EngineLossLaw = (base: Loads, records: readonly EngineLosses[], runtimes: readonly CylinderRuntime[]) => Loads;

let installed: EngineLossLaw | null = null;

export function setEngineLossLaw(law: EngineLossLaw | null): void {
  installed = law;
}

/** `base` with the engine losses applied; an error when the model has losses and no law is installed (never a silent lossless run). */
export function withInstalledLosses(
  base: Loads,
  records: readonly EngineLosses[],
  runtimes: readonly CylinderRuntime[],
): Loads | { error: string } {
  if (records.length === 0) return base;
  if (installed === null) return { error: 'the model has engine losses but no engine friction law is installed' };
  return installed(base, records, runtimes);
}
