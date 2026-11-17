/** simulate_motion phases: start-pose checks, run plan, adaptive integration, report. */

import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { commandError, failer, rejection, report } from '@core/commands/noop';
import type { DynamicsModel } from '@core/model/dynamics';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import type { PhysicsEngine, SimulationTrace } from '@core/dynamics/physicsEngine';
import { errorMessage } from '@lib/errorMessage';
import { buildSimulationModel, solverSettingsOf, type BuiltSimulation } from '../sim/simulationModel';
import { simulationData, simulationSummary } from '../sim/simulationReport';
import { PILOT_DURATION, PILOT_TIMESTEP, resolveTimestep, type ResolvedTimestep } from '../sim/timestep';
import { buildTopology, isRefusal, type Topology } from '../sim/topology';
import { analyseMobility } from '../sim/mobility';
import { reactionsData, residualTier, type ReactionMode } from '../sim/reactions';
import { cycleAngleSeries, engineData } from '../sim/engineReport';
import { realismOf } from './realismHook';
import { idealGearWarnings } from '../sim/transmissionReport';
import { ledgerOf } from '../sim/ledger';
import { driveReport } from '../sim/driveReport';
import { dynamicsOf } from './bodies';
import { openLoopGaps } from './inspect';
import { flightData, flightSummary } from '../flight/flightReport';

/** Default samples per turn of the fastest announced joint (10 deg), and the floor below which a warning says the motion aliases. */
const SAMPLES_PER_TURN = 36;
const MIN_SAMPLES_PER_TURN = 8;

/** Upper bound on integration steps of one run (keeps a call interactive). */
const MAX_STEPS = 1_000_000;
/** Upper bound on recorded samples (keeps results small enough for the CLI and the viewport). */
const MAX_SAMPLES = 6001;
/** Most halvings of the auto timestep after a failed loop-residual gate, and the smallest step they may reach (s). */
const MAX_HALVINGS = 5;
const MIN_STEP = 1e-5;

export interface SimulateParams {
  readonly duration?: number | undefined;
  readonly timestep?: number | undefined;
  readonly sampleRate?: number | undefined;
  readonly detail?: 'summary' | 'series' | 'poses' | 'drives' | undefined;
  readonly reactions?: ReactionMode | undefined;
  readonly energy?: boolean | undefined;
  readonly crankAxis?: string | undefined;
}

type Success = {
  readonly timestep: number;
  readonly built: BuiltSimulation;
  readonly trace: SimulationTrace;
  readonly sampleInterval: number;
};

type Attempt = { readonly timestep: number; readonly error: string } | Success;

type Fail = (why: string) => CommandResult;

interface Plan {
  readonly doc: CadDocument;
  readonly params: SimulateParams;
  readonly engine: PhysicsEngine;
  readonly kernel: ExecutionContext['kernel'];
  readonly dynamics: DynamicsModel;
  readonly metres: number;
  readonly topology: Topology;
  readonly hasCylinders: boolean;
  readonly structured: boolean;
  readonly settings: ReturnType<typeof solverSettingsOf>;
  readonly duration: number;
  readonly resolved: ResolvedTimestep;
  readonly defaultInterval: number;
  readonly withEnergy: boolean;
  readonly mode: ReactionMode;
}

/** Stop peaks with the static inertia (kg·m² or kg) the stop's damping was scaled to (constant-inertia approximation, spec 13.15). */
function stopsData(
  stops: NonNullable<SimulationTrace['stops']>,
  built: BuiltSimulation,
): Record<string, { peakPenetration: number; peakForce: number; effectiveInertia: number }> {
  const inertiaOf = (key: string): number =>
    built.model.jointPhysics?.limits.find((limit) => limit.joint === key)?.effectiveInertia ??
    built.model.transmissions.find((coupling) => coupling.id === key)?.backlash?.effectiveInertia ??
    Number.NaN;
  return Object.fromEntries(Object.entries(stops).map(([key, stop]) => [key, { ...stop, effectiveInertia: inertiaOf(key) }]));
}

function startPoseRefusal(
  doc: CadDocument,
  params: SimulateParams,
  dynamics: DynamicsModel,
  topology: Topology,
  metres: number,
  fail: Fail,
): CommandResult | null {
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
  return null;
}

type Base = Pick<Plan, 'doc' | 'params' | 'engine' | 'kernel' | 'dynamics' | 'metres' | 'topology' | 'hasCylinders' | 'structured'>;

function planRun(base: Base): Plan {
  const { doc, params, engine, kernel, dynamics, structured, hasCylinders } = base;
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
  // engines: one sample per degree of crank at the top speed; otherwise 50 Hz, or 36 samples per turn of the fastest announced joint
  // (sampling a 3000 rpm crank at 50 Hz sees the same phase every turn: the motion would alias into a false "steady")
  const degreeInterval = resolved.maxSpeed > 0 ? Math.PI / 180 / resolved.maxSpeed : 1 / 50;
  const turnInterval = resolved.maxSpeed > 0 ? (2 * Math.PI) / SAMPLES_PER_TURN / resolved.maxSpeed : Infinity;
  const defaultInterval = hasCylinders ? degreeInterval : Math.min(1 / 50, turnInterval);
  const withEnergy =
    params.energy ??
    (params.detail === 'drives' ||
      Object.values(dynamics.joints).some((joint) => joint.stiffness !== undefined) ||
      Object.keys(dynamics.springs ?? {}).length > 0);
  const mode: ReactionMode = params.reactions ?? (structured ? 'peaks' : 'off');
  return { ...base, settings, duration, resolved, defaultInterval, withEnergy, mode };
}

function attemptAt(plan: Plan, step: number): Attempt {
  const { doc, params, engine, kernel, duration, defaultInterval, withEnergy, mode } = plan;
  if (duration / step > MAX_STEPS)
    return { timestep: step, error: `duration / timestep is over ${MAX_STEPS.toLocaleString('en-US')} steps; raise the timestep` };
  const interval = params.sampleRate !== undefined ? 1 / params.sampleRate : defaultInterval;
  // the engine samples every whole number of steps: round the cap UP to one so the run never exceeds MAX_SAMPLES
  const capInterval = duration / (MAX_SAMPLES - 1);
  const sampleInterval = capInterval > Math.max(step, interval) ? Math.ceil(capInterval / step - 1e-9) * step : Math.max(step, interval);
  const model = buildSimulationModel(doc, step, kernel);
  if ('error' in model) return { timestep: step, error: model.error };
  try {
    const options = {
      duration,
      timestep: step,
      sampleInterval,
      ...(mode !== 'off' ? { reactions: true } : {}),
      ...(withEnergy ? { energy: true } : {}),
    };
    return { timestep: step, built: model, trace: engine.simulate(model.model, options), sampleInterval };
  } catch (error) {
    return { timestep: step, error: `the physics engine rejected the model: ${errorMessage(error)}` };
  }
}

function integrate(plan: Plan): { attempt: Attempt; halvings: number } {
  const { params, settings, structured, resolved } = plan;
  // the auto rule only sees speed and geometry: a light slow loop can still miss the residual gate, so halve the step and retry
  const failsGate = (attempt: Attempt): boolean => {
    if ('error' in attempt) return true;
    return residualTier(attempt.trace.loopResidual ?? 0, settings.loopResidualPassM, settings.loopResidualFailM) === 'fail';
  };
  let attempt = attemptAt(plan, resolved.timestep);
  // a stop or backlash stiffer than the auto step can integrate (DRV_STEP_TOO_COARSE) halves the step the same way
  const coarse = 'error' in attempt && attempt.error.includes('DRV_STEP_TOO_COARSE');
  const adaptive = params.timestep === undefined && settings.timestepS === 'auto' && (structured || coarse);
  let halvings = 0;
  while (adaptive && failsGate(attempt) && halvings < MAX_HALVINGS && attempt.timestep / 2 >= MIN_STEP) {
    const next = attemptAt(plan, attempt.timestep / 2);
    if ('error' in next && next.error.includes('steps; raise')) break;
    attempt = next;
    halvings++;
  }
  return { attempt, halvings };
}

type Tier = ReturnType<typeof residualTier>;
type Driven = ReturnType<typeof driveReport> | null;
type FlightOut = ReturnType<typeof flightData> | null;
type SimBase = ReturnType<typeof simulationData>;

interface Outcome {
  readonly attempt: Success;
  readonly halvings: number;
  readonly base: SimBase;
  readonly driven: Driven;
  readonly flight: FlightOut;
  readonly residual: number;
  readonly tier: Tier;
}

function runWarnings(plan: Plan, outcome: Outcome): string[] {
  const { params, structured, resolved } = plan;
  const { attempt, halvings, base, driven, flight, residual, tier } = outcome;
  const { timestep, built } = attempt;
  const warnings = [...base.warnings, ...(driven?.warnings ?? []), ...built.notes, ...(flight?.warnings ?? [])];
  if (halvings > 0)
    warnings.push(
      `timestep halved ${halvings}x by the auto rule: ${resolved.timestep} s failed the loop residual gate or was too coarse for a stop / backlash, ${timestep} s is used`,
    );
  if (params.sampleRate !== undefined && attempt.sampleInterval > 1 / params.sampleRate + 1e-12)
    warnings.push(
      `sampleRate ${params.sampleRate} Hz was reduced to ${(1 / attempt.sampleInterval).toPrecision(4)} Hz (at most ${MAX_SAMPLES} samples per run, and never finer than the timestep ${timestep} s)`,
    );
  if (resolved.maxSpeed > 0 && attempt.sampleInterval * resolved.maxSpeed > (2 * Math.PI) / MIN_SAMPLES_PER_TURN)
    warnings.push(
      `FPR_SAMPLING_ALIASED: ${((2 * Math.PI) / (attempt.sampleInterval * resolved.maxSpeed)).toPrecision(3)} samples per turn of the fastest joint (< ${MIN_SAMPLES_PER_TURN}): periodic motion aliases (it can read as steady); raise sampleRate or shorten duration`,
    );
  if (structured && tier !== 'pass')
    warnings.push(
      `FPR_LOOP_DRIFT (${tier}): loop residual ${(residual * 1e6).toPrecision(3)} µm; ` +
        `${tier === 'warn' ? 'reactions are approximate' : 'reactions are unreliable'}: use a smaller timestep or set_dynamics_solver`,
    );
  return warnings;
}

function loopsData(plan: Plan, outcome: Outcome, basis: string): object {
  const { topology, settings } = plan;
  const { attempt, tier } = outcome;
  const { trace, built, timestep } = attempt;
  return {
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
  };
}

type Realism = ReturnType<typeof realismOf>;
type EngineOut = ReturnType<typeof engineData>;

function brakeTextOf(realism: Realism | null): string {
  return realism?.losses == null
    ? ''
    : ` Brake: ${realism.losses.brakeTorqueNm.toFixed(2)} N·m (${realism.losses.brakePowerKW.toFixed(2)} kW, BMEP ${realism.losses.bmepBar.toFixed(3)} bar = IMEP ${realism.losses.imepBar.toFixed(3)} - FMEP ${realism.losses.fmepBar.toFixed(3)}), mechanical efficiency ${(realism.losses.mechanicalEfficiency * 100).toFixed(1)} %.`;
}

function engineTextOf(engineReport: EngineOut): string {
  return engineReport?.meanTorqueNm != null
    ? ` Engine ${engineReport.crankJoint}: mean torque ${engineReport.meanTorqueNm.toFixed(2)} N·m, indicated ${(engineReport.indicatedPowerKW ?? 0).toFixed(2)} kW at ${(engineReport.lastCycle?.meanRpm ?? 0).toFixed(0)} rpm, energy closure ${engineReport.energyClosure?.ratio == null ? 'not evaluated' : `${(engineReport.energyClosure.ratio * 100).toFixed(3)} %`}, speed ripple ${((engineReport.speedRipple?.measured ?? 0) * 100).toFixed(3)} %.`
    : '';
}

function reportRun(plan: Plan, attempt: Success, halvings: number): CommandResult {
  const { doc, params, engine, dynamics, metres, topology, structured, settings, duration, resolved, withEnergy, mode } = plan;
  const { trace, built, timestep } = attempt;
  const basis =
    halvings > 0
      ? `${resolved.basis}; halved ${halvings}x from ${resolved.timestep} s by the auto rule (loop residual gate, or a stop / backlash too stiff for the step)`
      : resolved.basis;
  const base = simulationData(dynamics, built.mass, trace, {
    engine: engine.name,
    duration,
    timestep,
    detail: params.detail === 'drives' ? 'series' : (params.detail ?? 'summary'),
    metresPerUnit: metres,
    drives: built.drives,
  });
  const hasDrives = Object.keys(dynamics.drives ?? {}).length > 0;
  const driven =
    hasDrives && built.drives.length > 0
      ? driveReport(built.drives, built.model.actuators?.ledgerLayout ?? [], trace, base.energy, timestep, params.detail === 'drives')
      : null;
  const residual = trace.loopResidual ?? 0;
  const tier = residualTier(residual, settings.loopResidualPassM, settings.loopResidualFailM);
  const ledger = driven === null ? ledgerOf([], trace, base.energy) : driven.ledger;
  const flight =
    built.flight === undefined
      ? null
      : flightData(built.flight, trace, { series: (params.detail ?? 'summary') !== 'summary', energy: withEnergy });
  const outcome: Outcome = { attempt, halvings, base, driven, flight, residual, tier };
  const warnings = runWarnings(plan, outcome);
  const lead = built.cylinders[0];
  const crankAxis = params.crankAxis;
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
  const realism =
    engineReport === null
      ? null
      : realismOf({
          dynamics,
          runtimes: built.cylinders,
          trace,
          mass: built.mass,
          report: engineReport,
          propellerTorqueNm: Object.fromEntries(Object.entries(base.propellers).map(([id, output]) => [id, output.torque])),
          metresPerUnit: metres,
        });
  if (engineReport !== null) warnings.push(...engineReport.warnings, ...(realism?.warnings ?? []), ...idealGearWarnings(dynamics));
  const data = {
    ...base,
    warnings,
    ...(structured ? { loops: loopsData(plan, outcome, basis) } : {}),
    ...(driven === null ? {} : { drives: driven.drives }),
    ...(flight === null ? {} : { flight: flight.data }),
    ...(ledger === null ? {} : { ledger }),
    ...(trace.stops === undefined ? {} : { stops: stopsData(trace.stops, built) }),
    ...(reactions !== null ? { reactions } : {}),
    ...(engineReport !== null ? { engineReport: { ...engineReport, ...(realism !== null ? { realism } : {}) } } : {}),
  };
  const loopText = structured ? ` Loops: residual ${(residual * 1e6).toPrecision(3)} µm (${tier}), timestep ${timestep} s.` : '';
  const flightText = flight === null ? '' : ` ${flightSummary(flight.data)}`;
  return report(doc, simulationSummary(data) + loopText + engineTextOf(engineReport) + brakeTextOf(realism) + flightText, data);
}

export function runSimulation(doc: CadDocument, params: SimulateParams, ctx: ExecutionContext | undefined): CommandResult {
  const fail = failer(doc, 'simulate_motion');
  const engine = ctx?.physics ?? null;
  const kernel = ctx?.kernel ?? null;
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
  const refusal = startPoseRefusal(doc, params, dynamics, topology, metres, fail);
  if (refusal !== null) return refusal;
  const plan = planRun({ doc, params, engine, kernel, dynamics, metres, topology, hasCylinders, structured });
  const { attempt, halvings } = integrate(plan);
  if ('error' in attempt) return fail(attempt.error);
  try {
    return reportRun(plan, attempt, halvings);
  } catch (error) {
    return fail(`the physics engine rejected the model: ${errorMessage(error)}`);
  }
}
