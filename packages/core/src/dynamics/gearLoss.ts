/**
 * Gear mesh losses (FR-FPR-74, TR-FPR-17). The loss itself is applied by the physics engine from the gear's `efficiency` (the equality force
 * of the rigid coupling is the transmitted torque): (1 - efficiency) of it is lost on the driven shaft, against its velocity, so at steady
 * speed the driven shaft carries T_in / ratio_speed * efficiency (121 N·m through 51/21 at 0.99: 290.92 N·m, VC-FPR-27).
 */

import type { DynamicsModel } from '../model/dynamics';

/** Typical mesh efficiency of a real spur gear pair [E-R21], quoted in messages (never applied silently). */
const TYPICAL_MESH_EFFICIENCY = 0.99;

/** One warning per gear that has no efficiency, i.e. is ideal: an engine realism run should state it. */
export function idealGearWarnings(dynamics: DynamicsModel): string[] {
  return Object.values(dynamics.gears)
    .filter((gear) => gear.efficiency === undefined)
    .map(
      (gear) =>
        `gear '${gear.id}' has no efficiency: it is ideal (1.0, no loss); a real spur mesh is about ${TYPICAL_MESH_EFFICIENCY} [E-R21] (add_gear_coupling efficiency)`,
    );
}
