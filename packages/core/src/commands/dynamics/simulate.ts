/** Running the physics (simulate_motion) and inspecting the dynamics model (inspect_dynamics). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { failer, report } from '../noop';
import { currentContext } from '../context';
import { toMetres } from '../../model/units';
import { buildSimulationModel } from '../../dynamics/simulationModel';
import { simulationData, simulationSummary } from '../../dynamics/simulationReport';
import { errorMessage } from '../../lib/errorMessage';
import { dynamicsOf } from './bodies';

/** Upper bound on integration steps of one run (keeps a call interactive). */
const MAX_STEPS = 1_000_000;
/** Upper bound on recorded samples (keeps results small enough for MCP and the viewport). */
const MAX_SAMPLES = 6001;

/**
 * @affects nothing — read-only; returns { ...SimulationData } in data
 * @invariant deterministic: same document + params → same data
 * @failure no bodies, invalid model, no physics engine installed, engine error or divergence -> no-op with the reason
 */
export const simulateMotion = defineCommand({
  name: 'simulate_motion',
  annotations: { readOnly: true },
  description:
    'Run the rigid-body physics of the mechanism (bodies, joints, gears, motors, propellers) forward in time with a real physics ' +
    'engine (MuJoCo) and report what happens: final speed of every joint (rpm), when it settled, engine torque and power, propeller ' +
    'thrust / torque / absorbed power, and measured gear ratios (a self-check). Gravity applies (set_gravity). Read-only. ' +
    'detail "summary" (default) = numbers only; "series" adds per-sample time series (speeds, positions, torques, thrust, power) for ' +
    'plotting; "poses" also adds every body\'s pose per sample (for playback). Warnings flag a run that has not settled. ' +
    'Typical: duration 10 s, timestep 0.001 s (use 0.0002 s for fast, light parts).',
  params: z.object({
    duration: z.number().positive().max(600).optional().describe('Simulated seconds. Default 5.'),
    timestep: z.number().min(1e-5).max(0.01).optional().describe('Integration step in seconds. Default 0.001.'),
    sampleRate: z.number().positive().optional().describe('Recorded samples per second. Default 50.'),
    detail: z.enum(['summary', 'series', 'poses']).optional().describe('"summary" (default), "series" or "poses".'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, 'simulate_motion');
    const engine = (ctx ?? currentContext()).physics ?? null;
    if (engine === null) return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
    const duration = params.duration ?? 5;
    const timestep = params.timestep ?? 0.001;
    if (duration / timestep > MAX_STEPS)
      return fail(`duration / timestep is over ${MAX_STEPS.toLocaleString('en-US')} steps; raise the timestep`);
    const sampleInterval = Math.max(timestep, 1 / (params.sampleRate ?? 50), duration / (MAX_SAMPLES - 1));
    const built = buildSimulationModel(doc, timestep);
    if ('error' in built) return fail(built.error);
    try {
      const trace = engine.simulate(built.model, { duration, timestep, sampleInterval });
      const data = simulationData(dynamicsOf(doc), built.mass, trace, {
        engine: engine.name,
        duration,
        timestep,
        detail: params.detail ?? 'summary',
        metresPerUnit: toMetres(doc, 1),
      });
      return report(doc, simulationSummary(data), data);
    } catch (error) {
      return fail(`the physics engine rejected the model: ${errorMessage(error)}`);
    }
  },
});

/**
 * @affects nothing — read-only; data { bodies, joints, gears, motors, propellers, problems }
 * @failure none: an empty model reports empty tables and the problem "no rigid bodies"
 */
export const inspectDynamics = defineCommand({
  name: 'inspect_dynamics',
  annotations: { readOnly: true },
  description:
    'List the physics model: every rigid body with its computed mass (kg), centre of mass (document units) and moment of inertia about ' +
    'its joint axis (kg·m²), plus joints, gear couplings, motors and propellers, and any problem that would stop simulate_motion. ' +
    'Use it to check a setup before simulating. Read-only; needs no physics engine.',
  params: z.object({}),
  run: (doc): CommandResult => {
    const dynamics = dynamicsOf(doc);
    const built = buildSimulationModel(doc, 0.001);
    const metres = toMetres(doc, 1);
    const problems = 'error' in built ? [built.error] : [];
    const bodies =
      'error' in built
        ? {}
        : Object.fromEntries(
            built.model.bodies.map((body) => {
              const axis = body.joint?.axis;
              const [ixx, iyy, izz, ixy, ixz, iyz] = body.inertia;
              const aboutAxis =
                axis === undefined
                  ? null
                  : ixx * axis[0] ** 2 +
                    iyy * axis[1] ** 2 +
                    izz * axis[2] ** 2 +
                    2 * (ixy * axis[0] * axis[1] + ixz * axis[0] * axis[2] + iyz * axis[1] * axis[2]);
              const offset = body.joint === null ? 0 : distanceToAxis(body.centerOfMass, body.joint.anchor, body.joint.axis);
              return [
                body.id,
                {
                  name: dynamics.bodies[body.id]?.name ?? null,
                  massKg: body.mass,
                  centerOfMass: body.centerOfMass.map((c) => c / metres),
                  fixed: body.fixed,
                  joint: body.joint?.id ?? null,
                  // parallel axis: about the joint axis, not the centre of mass
                  inertiaAboutJointAxis: aboutAxis === null ? null : aboutAxis + body.mass * offset * offset,
                },
              ];
            }),
          );
    const data = {
      bodies,
      joints: dynamics.joints,
      gears: dynamics.gears,
      motors: dynamics.motors,
      propellers: dynamics.propellers,
      problems,
    };
    const lines = Object.entries(bodies).map(
      ([id, body]) =>
        `${id}${body.name !== null ? ` (${body.name})` : ''}: ${body.massKg.toPrecision(4)} kg` +
        (body.inertiaAboutJointAxis !== null
          ? `, I = ${body.inertiaAboutJointAxis.toPrecision(4)} kg·m² about joint ${body.joint ?? ''}`
          : '') +
        (body.fixed ? ', fixed' : ''),
    );
    const counts = `${Object.keys(dynamics.joints).length} joint(s), ${Object.keys(dynamics.gears).length} gear(s), ${Object.keys(dynamics.motors).length} motor(s), ${Object.keys(dynamics.propellers).length} propeller(s)`;
    const summary =
      problems.length > 0
        ? `inspect_dynamics: not simulatable — ${problems.join('; ')}. ${counts}.`
        : `inspect_dynamics: ${lines.join('; ')}. ${counts}.`;
    return report(doc, summary, data);
  },
});

/** Distance from `point` to the line through `anchor` along unit `axis`. */
function distanceToAxis(point: readonly number[], anchor: readonly number[], axis: readonly number[]): number {
  const d = [0, 1, 2].map((i) => (point[i] ?? 0) - (anchor[i] ?? 0));
  const along = d.reduce((sum, value, i) => sum + value * (axis[i] ?? 0), 0);
  return Math.sqrt(Math.max(0, d.reduce((sum, value) => sum + value * value, 0) - along * along));
}
