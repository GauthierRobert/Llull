/** Running the physics (simulate_motion). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { commandError, failer, rejection, report } from '../noop';
import { currentContext } from '../context';
import { toMetres } from '../../model/units';
import { buildSimulationModel, solverSettingsOf, type BuiltSimulation } from '../../dynamics/simulationModel';
import type { SimulationTrace } from '../../dynamics/physicsEngine';
import { simulationData, simulationSummary } from '../../dynamics/simulationReport';
import { PILOT_DURATION, PILOT_TIMESTEP, resolveTimestep } from '../../dynamics/timestep';
import { buildTopology, isRefusal } from '../../dynamics/topology';
import { analyseMobility } from '../../dynamics/mobility';
import { reactionsData, residualTier, type ReactionMode } from '../../dynamics/reactions';
import { cycleAngleSeries, engineData } from '../../dynamics/engineReport';
import { errorMessage } from '../../lib/errorMessage';
import { dynamicsOf } from './bodies';
import { openLoopGaps } from './inspect';

/** Upper bound on integration steps of one run (keeps a call interactive). */
const MAX_STEPS = 1_000_000;
/** Upper bound on recorded samples (keeps results small enough for MCP and the viewport). */
const MAX_SAMPLES = 6001;
/** Most halvings of the auto timestep after a failed loop-residual gate, and the smallest step they may reach (s). */
const MAX_HALVINGS = 5;
const MIN_STEP = 1e-5;

type Attempt =
  | { readonly timestep: number; readonly error: string }
  | { readonly timestep: number; readonly built: BuiltSimulation; readonly trace: SimulationTrace; readonly sampleInterval: number };

/**
 * @affects nothing — read-only; returns { ...SimulationData, loops?, reactions?, engineReport? } in data
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
    'gives, per tree joint, the force (N) and moment (N·m) on the child body at the joint anchor in world axes, and per loop closure ' +
    'the resultant force (N) on the child (no moment), each with peak magnitude, time and crank angle (the crank angle axis is the cycle angle of the first cylinder, or the joint named by ' +
    '`crankAxis`); along the axis of a driven joint the reported component includes the drive force itself. With cylinder pressures ' +
    '(add_cylinder_pressure) the sampling defaults to one sample per crank degree and data.engineReport gives, over the last full ' +
    'cycle: torque against crank angle per cylinder and total (detail series), mean torque (N·m), indicated power (kW), IMEP and peak ' +
    'pressure per cylinder, cycle-energy closure (gate 0.5 %, FPR_ENERGY_CLOSURE), speed ripple against the analytic ΔE/(I·ω²), and ' +
    'the peak wrist-pin, rod, side-thrust, crank-pin and main-bearing forces. Simulate at least one full cycle (two crank turns for a ' +
    'four-stroke) after the speed has settled. Next: read data.loops.tier first, then data.engineReport and data.reactions.',
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
    const kernel = (ctx ?? currentContext()).kernel;
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
    const hasCylinders = Object.keys(dynamics.cylinders ?? {}).length > 0;
    const structured = topology.loops.length > 0 || hasCylinders;
    const crankAxis = params.crankAxis;
    if (crankAxis !== undefined && !topology.tree.some((entry) => entry.joint.id === crankAxis && entry.joint.kind === 'revolute'))
      return fail(`crankAxis '${crankAxis}' is not a revolute tree joint`);
    if (topology.loops.length > 0) {
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
      const pilot = buildSimulationModel(doc, PILOT_TIMESTEP, kernel);
      if ('error' in pilot) return 0;
      try {
        const trace = engine.simulate(pilot.model, { duration: PILOT_DURATION, timestep: PILOT_TIMESTEP, sampleInterval: 0.01 });
        return Math.max(0, ...Object.values(trace.jointVelocity).flatMap((series) => series.map(Math.abs)));
      } catch {
        return 0;
      }
    };
    const resolved = resolveTimestep(dynamics, settings, params.timestep, structured, pilotPeak);
    // engines: one sample per degree of crank at the top speed unless the call sets a rate
    const degreeInterval = resolved.maxSpeed > 0 ? Math.PI / 180 / resolved.maxSpeed : 1 / 50;
    const defaultInterval = hasCylinders ? degreeInterval : 1 / 50;
    const mode: ReactionMode = params.reactions ?? (structured ? 'peaks' : 'off');
    const attemptAt = (step: number): Attempt => {
      if (duration / step > MAX_STEPS)
        return { timestep: step, error: `duration / timestep is over ${MAX_STEPS.toLocaleString('en-US')} steps; raise the timestep` };
      const interval = params.sampleRate !== undefined ? 1 / params.sampleRate : defaultInterval;
      // the engine samples every whole number of steps: round the cap UP to one so the run never exceeds MAX_SAMPLES
      const capInterval = duration / (MAX_SAMPLES - 1);
      const sampleInterval =
        capInterval > Math.max(step, interval) ? Math.ceil(capInterval / step - 1e-9) * step : Math.max(step, interval);
      const model = buildSimulationModel(doc, step, kernel);
      if ('error' in model) return { timestep: step, error: model.error };
      try {
        const options = { duration, timestep: step, sampleInterval, ...(mode !== 'off' ? { reactions: true } : {}) };
        return { timestep: step, built: model, trace: engine.simulate(model.model, options), sampleInterval };
      } catch (error) {
        return { timestep: step, error: `the physics engine rejected the model: ${errorMessage(error)}` };
      }
    };
    // the auto rule only sees speed and geometry: a light slow loop can still miss the residual gate, so halve the step and retry
    const adaptive = params.timestep === undefined && structured && settings.timestepS === 'auto';
    const failsGate = (attempt: Attempt): boolean =>
      'error' in attempt ||
      residualTier(attempt.trace.loopResidual ?? 0, settings.loopResidualPassM, settings.loopResidualFailM) === 'fail';
    let attempt = attemptAt(resolved.timestep);
    let halvings = 0;
    while (adaptive && failsGate(attempt) && halvings < MAX_HALVINGS && attempt.timestep / 2 >= MIN_STEP) {
      const next = attemptAt(attempt.timestep / 2);
      if ('error' in next && next.error.includes('steps; raise')) break;
      attempt = next;
      halvings++;
    }
    if ('error' in attempt) return fail(attempt.error);
    try {
      const { trace, built, timestep } = attempt;
      const basis =
        halvings > 0 ? `${resolved.basis}; halved ${halvings}x from ${resolved.timestep} s after the loop residual failed` : resolved.basis;
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
      if (halvings > 0)
        warnings.push(
          `timestep halved ${halvings}x by the auto rule: ${resolved.timestep} s left the loop residual above the fail tier, ${timestep} s is used`,
        );
      if (params.sampleRate !== undefined && attempt.sampleInterval > 1 / params.sampleRate + 1e-12)
        warnings.push(
          `sampleRate ${params.sampleRate} Hz was reduced to ${(1 / attempt.sampleInterval).toPrecision(4)} Hz (at most ${MAX_SAMPLES} samples per run, and never finer than the timestep ${timestep} s)`,
        );
      if (structured && tier !== 'pass')
        warnings.push(
          `FPR_LOOP_DRIFT (${tier}): loop residual ${(residual * 1e6).toPrecision(3)} µm; ` +
            `${tier === 'warn' ? 'reactions are approximate' : 'reactions are unreliable'}: use a smaller timestep or set_dynamics_solver`,
        );
      const lead = built.cylinders[0];
      const angleDeg =
        crankAxis !== undefined
          ? (trace.jointPosition[crankAxis] ?? []).map((rad) => ((((rad * 180) / Math.PI) % 360) + 360) % 360)
          : lead !== undefined
            ? cycleAngleSeries(lead, trace)
            : null;
      const reactions = mode === 'off' ? null : reactionsData({ topology, trace, mode, angleDeg, tier });
      const engineReport = engineData({
        dynamics,
        topology,
        runtimes: built.cylinders,
        trace,
        mass: built.mass,
        metresPerUnit: metres,
        series: (params.detail ?? 'summary') !== 'summary' || mode === 'series',
      });
      if (engineReport !== null) warnings.push(...engineReport.warnings);
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
                  timestepBasis: basis,
                  loopTimeConstantS: built.model.solver.loopTimeConstant,
                  loopTimeConstantSteps: settings.loopTimeConstantSteps,
                  loopImpedance: settings.loopImpedance,
                },
              },
            }
          : {}),
        ...(reactions !== null ? { reactions } : {}),
        ...(engineReport !== null ? { engineReport } : {}),
      };
      const loopText = structured ? ` Loops: residual ${(residual * 1e6).toPrecision(3)} µm (${tier}), timestep ${timestep} s.` : '';
      const engineText =
        engineReport?.meanTorqueNm != null
          ? ` Engine ${engineReport.crankJoint}: mean torque ${engineReport.meanTorqueNm.toFixed(2)} N·m, indicated ${(engineReport.indicatedPowerKW ?? 0).toFixed(2)} kW at ${(engineReport.lastCycle?.meanRpm ?? 0).toFixed(0)} rpm, energy closure ${engineReport.energyClosure?.ratio == null ? 'not evaluated' : `${(engineReport.energyClosure.ratio * 100).toFixed(3)} %`}, speed ripple ${((engineReport.speedRipple?.measured ?? 0) * 100).toFixed(3)} %.`
          : '';
      return report(doc, simulationSummary(data) + loopText + engineText, data);
    } catch (error) {
      return fail(`the physics engine rejected the model: ${errorMessage(error)}`);
    }
  },
});
