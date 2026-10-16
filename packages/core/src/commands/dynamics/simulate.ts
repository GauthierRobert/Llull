/** Running the physics (simulate_motion). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { commandError, failer, rejection, report } from '../noop';
import { currentContext } from '../context';
import { toMetres } from '../../model/units';
import { buildSimulationModel, solverSettingsOf } from '../../dynamics/simulationModel';
import { simulationData, simulationSummary } from '../../dynamics/simulationReport';
import { PILOT_DURATION, PILOT_TIMESTEP, resolveTimestep } from '../../dynamics/timestep';
import { buildTopology, isRefusal } from '../../dynamics/topology';
import { analyseMobility } from '../../dynamics/mobility';
import { reactionsData, residualTier, type ReactionMode } from '../../dynamics/reactions';
import { errorMessage } from '../../lib/errorMessage';
import { dynamicsOf } from './bodies';
import { openLoopGaps } from './inspect';

/** Upper bound on integration steps of one run (keeps a call interactive). */
const MAX_STEPS = 1_000_000;
/** Upper bound on recorded samples (keeps results small enough for MCP and the viewport). */
const MAX_SAMPLES = 6001;

/**
 * @affects nothing — read-only; returns { ...SimulationData, loops?, reactions? } in data
 * @invariant deterministic: same document + params → same data; a model without loops or cylinders returns exactly the legacy data
 * @failure no bodies, invalid model, no physics engine installed, engine error or divergence -> no-op with the reason;
 *          FPR_LOOP_PRISMATIC / FPR_SPHERICAL_TREE (topology), FPR_LOOP_OPEN (a loop is open at the start pose) -> rejected, nothing run
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
    'Typical: duration 10 s, timestep 0.001 s (use 0.0002 s for fast, light parts). ' +
    'Closed loops (slider-crank, four-bar): before integrating, the start pose is checked and a loop open by more than 1 µm is refused ' +
    '(FPR_LOOP_OPEN, nothing is run or snapped); with loops the default timestep is the "auto" rule min(1 ms, 0.5 deg of crank at the ' +
    'top speed) unless set_dynamics_solver or `timestep` says otherwise, and data.loops reports the largest constraint violation ' +
    '(metres), its tier (pass <= 1 µm, warn <= 10 µm = FPR_LOOP_DRIFT warn, reactions approximate; fail above, reactions unreliable) ' +
    'and the solver settings used. `reactions`: "off", "peaks" (default when the mechanism has loops) or "series": data.reactions ' +
    'gives, per joint and per loop closure, the force (N) and moment (N·m) on the child body at the joint anchor in world axes, with ' +
    'peak magnitude, time and crank angle. The crank angle axis is the joint named by `crankAxis`. Next: read data.loops.tier first, ' +
    'then data.reactions.',
  params: z.object({
    duration: z.number().positive().max(600).optional().describe('Simulated seconds. Default 5.'),
    timestep: z
      .number()
      .min(1e-5)
      .max(0.01)
      .optional()
      .describe('Integration step in seconds. Default 0.001 (loops or cylinders: the "auto" rule or the stored solver setting).'),
    sampleRate: z.number().positive().optional().describe('Recorded samples per second. Default 50.'),
    detail: z.enum(['summary', 'series', 'poses']).optional().describe('"summary" (default), "series" or "poses".'),
    reactions: z
      .enum(['off', 'peaks', 'series'])
      .optional()
      .describe('Joint / loop reaction forces: "off", "peaks" (default when the mechanism has loops), "series" (adds every sample).'),
    crankAxis: z
      .string()
      .optional()
      .describe('Id of the revolute tree joint whose angle (deg, 0-360) labels the peaks of reactions; default none (time only).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, 'simulate_motion');
    const engine = (ctx ?? currentContext()).physics ?? null;
    if (engine === null) return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
    const dynamics = dynamicsOf(doc);
    const metres = toMetres(doc, 1);
    const topology = buildTopology(dynamics);
    if (isRefusal(topology)) {
      return rejection(
        doc,
        `simulate_motion: ${topology.code} — ${topology.error}; no-op.`,
        commandError(topology.code, topology.error, topology.ids),
      );
    }
    const structured = topology.loops.length > 0;
    const crankAxis = params.crankAxis;
    if (crankAxis !== undefined && !topology.tree.some((entry) => entry.joint.id === crankAxis && entry.joint.kind === 'revolute'))
      return fail(`crankAxis '${crankAxis}' is not a revolute tree joint`);
    if (structured) {
      const open = Object.entries(openLoopGaps(analyseMobility(dynamics, topology, metres)));
      if (open.length > 0) {
        const detail = open.map(([id, gap]) => `loop joint '${id}' is open by ${(gap * 1000).toPrecision(4)} mm`).join('; ');
        return rejection(
          doc,
          `simulate_motion: FPR_LOOP_OPEN — ${detail} at the start pose (limit 0.001 mm); fix the anchors or the geometry, nothing was run; no-op.`,
          commandError(
            'FPR_LOOP_OPEN',
            'Fix the joint anchors (or anchorOnChild) so both pins of each loop coincide.',
            open.map(([id]) => id),
          ),
        );
      }
    }
    const settings = solverSettingsOf(dynamics);
    const duration = params.duration ?? 5;
    const pilotPeak = (): number => {
      const pilot = buildSimulationModel(doc, PILOT_TIMESTEP);
      if ('error' in pilot) return 0;
      try {
        const trace = engine.simulate(pilot.model, { duration: PILOT_DURATION, timestep: PILOT_TIMESTEP, sampleInterval: 0.01 });
        return Math.max(0, ...Object.values(trace.jointVelocity).flatMap((series) => series.map(Math.abs)));
      } catch {
        return 0;
      }
    };
    const resolved = resolveTimestep(dynamics, settings, params.timestep, structured, pilotPeak);
    const timestep = resolved.timestep;
    if (duration / timestep > MAX_STEPS)
      return fail(`duration / timestep is over ${MAX_STEPS.toLocaleString('en-US')} steps; raise the timestep`);
    const sampleInterval = Math.max(timestep, 1 / (params.sampleRate ?? 50), duration / (MAX_SAMPLES - 1));
    const built = buildSimulationModel(doc, timestep);
    if ('error' in built) return fail(built.error);
    const mode: ReactionMode = params.reactions ?? (structured ? 'peaks' : 'off');
    try {
      const trace = engine.simulate(built.model, { duration, timestep, sampleInterval, ...(mode !== 'off' ? { reactions: true } : {}) });
      const base = simulationData(dynamics, built.mass, trace, {
        engine: engine.name,
        duration,
        timestep,
        detail: params.detail ?? 'summary',
        metresPerUnit: metres,
      });
      const residual = trace.loopResidual ?? 0;
      const tier = residualTier(residual, settings.loopResidualPassM, settings.loopResidualFailM);
      const warnings = [...base.warnings];
      if (structured && tier !== 'pass')
        warnings.push(
          `FPR_LOOP_DRIFT (${tier}): loop residual ${(residual * 1e6).toPrecision(3)} µm; ` +
            `${tier === 'warn' ? 'reactions are approximate' : 'reactions are unreliable'}: use a smaller timestep or set_dynamics_solver`,
        );
      const angleDeg =
        crankAxis === undefined ? null : (trace.jointPosition[crankAxis] ?? []).map((rad) => ((((rad * 180) / Math.PI) % 360) + 360) % 360);
      const reactions = mode === 'off' ? null : reactionsData({ topology, trace, mode, angleDeg, tier });
      const data = {
        ...base,
        warnings,
        ...(structured
          ? {
              loops: {
                count: topology.loops.length,
                ids: topology.loops.map((loop) => loop.id),
                tree: topology.tree.map((entry) => entry.joint.id),
                flipped: topology.flipped,
                residualM: trace.loopResidual ?? null,
                tier,
                passM: settings.loopResidualPassM,
                failM: settings.loopResidualFailM,
                solver: {
                  integrator: settings.integrator,
                  timestepS: timestep,
                  timestepBasis: resolved.basis,
                  loopTimeConstantS: built.model.solver.loopTimeConstant,
                  loopTimeConstantSteps: settings.loopTimeConstantSteps,
                  loopImpedance: settings.loopImpedance,
                },
              },
            }
          : {}),
        ...(reactions !== null ? { reactions } : {}),
      };
      const loopText = structured ? ` Loops: residual ${(residual * 1e6).toPrecision(3)} µm (${tier}), timestep ${timestep} s.` : '';
      return report(doc, simulationSummary(data) + loopText, data);
    } catch (error) {
      return fail(`the physics engine rejected the model: ${errorMessage(error)}`);
    }
  },
});
