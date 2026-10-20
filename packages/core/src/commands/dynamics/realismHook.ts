/**
 * Injection point for the engine realism report of simulate_motion (TECHNICAL_SPEC 11 Q3: generic dynamics never imports the engine
 * folder). The engine folder installs `realismData` (`engine/hooks.ts`, called by the dynamics catalog); without it there is no realism block.
 */

import type { DynamicsModel } from '../../model/dynamics';
import type { CylinderRuntime } from '../../dynamics/cylinderLoads';
import type { EngineData } from '../../dynamics/engineReport';
import type { SimulationTrace } from '../../dynamics/physicsEngine';
import type { BodyMassProperties } from '../../dynamics/simulationModel';

export interface RealismHookInput {
  readonly dynamics: DynamicsModel;
  readonly runtimes: readonly CylinderRuntime[];
  readonly trace: SimulationTrace;
  readonly mass: Readonly<Record<string, BodyMassProperties>>;
  readonly report: EngineData;
  /** Absorbed torque of each propeller at the end of the run, N·m. */
  readonly propellerTorqueNm: Readonly<Record<string, number>>;
  readonly metresPerUnit: number;
}

/** What simulate_motion reads of the realism block; the block itself goes into data unchanged. */
export interface RealismHookOutput {
  readonly losses: {
    readonly brakeTorqueNm: number;
    readonly brakePowerKW: number;
    readonly bmepBar: number;
    readonly imepBar: number;
    readonly fmepBar: number;
    readonly mechanicalEfficiency: number;
  } | null;
  readonly warnings: readonly string[];
}

type RealismLaw = (input: RealismHookInput) => RealismHookOutput | null;

let installed: RealismLaw | null = null;

export function setRealismLaw(law: RealismLaw | null): void {
  installed = law;
}

/** Warning of a run whose model declares engine losses while no realism law is installed: the brake figures are missing, never silently. */
export const NO_REALISM_LAW =
  'no engine realism law is installed: brake torque, BMEP, FMEP and the accuracy statements are not reported for this run';

/** The realism block of an engine run; null when the run has nothing to report; a warning-only block when the model needs a law that is missing. */
export function realismOf(input: RealismHookInput): RealismHookOutput | null {
  if (installed !== null) return installed(input);
  return Object.keys(input.dynamics.losses ?? {}).length > 0 ? { losses: null, warnings: [NO_REALISM_LAW] } : null;
}
