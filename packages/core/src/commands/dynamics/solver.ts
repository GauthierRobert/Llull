/** Solver settings of loop-closed mechanisms (set_dynamics_solver). */

import { DEFAULT_SOLVER_SETTINGS, type DynamicsSolverSettings } from '../../model/dynamics';
import { solverSettingsOf } from '../../dynamics/simulationModel';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { failer, report } from '../noop';
import { dynamicsOf, withDynamics } from './bodies';

/**
 * @affects sets doc.dynamics.solver (affected: []); omitted fields keep their current value
 * @invariant loopTimeConstantSteps >= 2; loopImpedance in (0, 0.9999]; loopResidualPassM <= loopResidualFailM; at least one field given
 * @failure nothing to change, pass limit above fail limit -> no-op
 */
export const setDynamicsSolver = defineCommand({
  name: 'set_dynamics_solver',
  annotations: { idempotent: true },
  description:
    'Tune how simulate_motion integrates a loop-closed mechanism (slider-crank, four-bar, engine). Defaults are right for most ' +
    'models; change them when data.loops.tier of simulate_motion is "warn" or "fail" (FPR_LOOP_DRIFT) or the run diverges. ' +
    'timestepS: seconds, or "auto" (default) = min(1 ms, 0.5 deg of crank at the top speed). integrator: "rk4" (default) or ' +
    '"implicitfast". loopTimeConstantSteps (>= 2, default 2): the loop constraints relax over this many timesteps; 2 is the stiffest ' +
    'stable value and keeps light links (rods of a few grams) closed, but resolves the closure so coarsely that a slider-crank torque (0.5 kg piston, 5 g rod) is ' +
    '0.7 % off: when crank torque accuracy matters use 8 (0.03 %) to 16 (0.01 %), and check data.loops.tier stays "pass". loopImpedance (0 < d <= 0.9999, default 0.9999): closer to 1 = stiffer loop. loopResidualPassM (default 1e-6 m = ' +
    '1 µm, 5 % of a 0.020 mm pin clearance) and loopResidualFailM (default 1e-5 m): residual tiers. timestepSensitivityGate ' +
    '(default 0.01): reserved for the half-timestep check. Only the given fields change. Next: ' +
    'simulate_motion and read data.loops.',
  params: z.object({
    timestepS: z
      .union([z.literal('auto'), z.number().min(1e-5).max(0.01)])
      .optional()
      .describe('Integration step in seconds (1e-5 .. 0.01), or "auto".'),
    integrator: z.enum(['rk4', 'implicitfast']).optional().describe('"rk4" (default) or "implicitfast".'),
    loopTimeConstantSteps: z.number().min(2).max(1000).optional().describe('Loop constraint time constant in timesteps, >= 2 (default 2).'),
    loopImpedance: z.number().gt(0).max(0.9999).optional().describe('Loop constraint impedance, 0 < d <= 0.9999 (default 0.9999).'),
    loopResidualPassM: z.number().positive().optional().describe('Loop residual (m) up to which a run passes. Default 1e-6.'),
    loopResidualFailM: z.number().positive().optional().describe('Loop residual (m) above which a run fails. Default 1e-5.'),
    timestepSensitivityGate: z.number().positive().optional().describe('Relative change gate of the half-timestep check. Default 0.01.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'set_dynamics_solver');
    const given = Object.entries(params).filter(([, value]) => value !== undefined);
    if (given.length === 0) return fail('give at least one setting to change');
    const dynamics = dynamicsOf(doc);
    const solver: DynamicsSolverSettings = { ...solverSettingsOf(dynamics), ...Object.fromEntries(given) };
    if (solver.loopResidualPassM > solver.loopResidualFailM) return fail('loopResidualPassM must not exceed loopResidualFailM');
    const changes = given.map(([key, value]) => `${key} = ${String(value)}`).join(', ');
    const defaults = Object.entries(DEFAULT_SOLVER_SETTINGS).every(([key, value]) => solver[key as keyof DynamicsSolverSettings] === value);
    return report(withDynamics(doc, { ...dynamics, solver }), `set_dynamics_solver: ${changes}${defaults ? ' (the defaults)' : ''}.`);
  },
});
