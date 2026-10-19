/** check_dynamics: read-only review of the realism of the dynamics inputs and of the simulation's own self-checks. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { currentContext } from '../context';
import { type ReviewItem, type ReviewResult, reviewItem, reviewResult, reviewSummary } from '../inspect/reviewEnvelope';
import { dynamicsOf } from './bodies';
import { simulateMotion } from './simulate';
import { staticChecks } from './dynamicsStaticChecks';
import { type SimulationRun, energyItem, loopDriftItem, notRunItems, TIMESTEP_GATE, timestepItem, tipMachItems } from './dynamicsSimChecks';

const NAME = 'check_dynamics';
const DEFAULT_DURATION = 2;
const MIN_TIMESTEP = 1e-5;

const reasonOf = (summary: string): string => summary.replace(/^simulate_motion:\s*/, '').replace(/;\s*no-op\.$/, '');
const asRun = (data: unknown): SimulationRun | null =>
  typeof data === 'object' && data !== null && 'joints' in data && 'timestep' in data ? (data as SimulationRun) : null;

/**
 * @affects nothing — read-only; returns the review envelope (check 'dynamics') in data
 * @invariant returns the SAME document, affected []; deterministic; a simulation-based item is never 'pass' when the simulation did not run
 * @failure no rigid bodies -> status not_run with FPR_NO_MOTION; no physics engine, refused model or open loop -> static items + not_run
 *   simulation items; invalid params -> rejected by execute
 */
export const checkDynamics = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'Review check of the physics model (rigid bodies, joints, motors, propellers): are the inputs realistic and are the simulation numbers ' +
    'trustworthy? Returns the review envelope in data (status = worst item; not_run is never a pass; reviewRequired). Static items need no ' +
    'simulation: FPR_MASS_DEFAULTED (warn; a moving body takes the steel default density 7850 kg/m3 instead of a material, density or massKg), ' +
    'FPR_UNREALISTIC (warn; propeller figure of merit above 0.8, or tip Mach above 0.85 in the run), FPR_NO_LOSSES (warn; no joint damping or ' +
    'friction, spring damper or propeller: the model is lossless), loop topology: FPR_LOOP_PRISMATIC (fail; a loop would close through a prismatic ' +
    'joint), FPR_LOOP_OPEN (fail; pins of a loop further apart than 1 um at the start pose), FPR_REDUNDANT_CONSTRAINT (warn; planar loop with ' +
    'all revolute joints, make one spherical). Simulation self-checks run the same engine as simulate_motion (so they need the physics ' +
    'engine; without it they are not_run, never pass): FPR_LOOP_DRIFT (loop-closure residual, pass <= 1 um, warn <= 10 um, fail above), ' +
    'FPR_ENERGY_CLOSURE (cylinder engines: gas work against the pressure model, gate 0.5 % = fail; otherwise the energy balance of the run, ' +
    'over 0.5 % = warn), FPR_TIMESTEP_SENSITIVE (the run is repeated at half the timestep; warn when the final speed or position of a joint ' +
    `changes by more than ${TIMESTEP_GATE.value * 100} %). With no rigid bodies the result is not_run (FPR_NO_MOTION). Not implemented, so ` +
    'never reported: FPR_REFERENCE_MISMATCH, FPR_CALIBRATION_FAILED (no reference data in the document), FPR_OUTSIDE_VALIDATED_RANGE. ' +
    'Approximate: all thresholds are llull named defaults (grade C), the timestep test compares only final joint states, and a run shorter ' +
    'than the motion cycle can hide drift. Read-only. Next: fix warnings, then check_prototype. Computed by llull, not approved: a ' +
    'qualified engineer must review.',
  params: z.object({
    duration: z
      .number()
      .positive()
      .max(600)
      .optional()
      .describe(`Simulated seconds of each run. Default ${DEFAULT_DURATION}. Cover at least one full cycle.`),
    timestep: z
      .number()
      .min(MIN_TIMESTEP)
      .max(0.01)
      .optional()
      .describe('Integration step in seconds of the first run (the second uses half of it); default as simulate_motion.'),
    sampleRate: z
      .number()
      .positive()
      .optional()
      .describe('Recorded samples per second; default as simulate_motion (36 per crank turn for loops). At most 6001 samples per run.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const context = ctx ?? currentContext();
    const dynamics = dynamicsOf(doc);
    const hash = { dynamics: doc.dynamics ?? null, entities: Object.keys(doc.entities).length, units: doc.units };
    const provenance = (engine: string | undefined): ReviewResult['provenance'] => ({
      method: 'static checks of doc.dynamics + simulate_motion at dt and dt/2 (energy balance, loop residual)',
      ...(engine === undefined ? {} : { engine }),
      tolerances: { timestepChangeFraction: TIMESTEP_GATE.value, energyClosureFraction: 0.005, loopPassUm: 1, loopFailUm: 10 },
      params: { ...params },
    });
    if (Object.keys(dynamics.bodies).length === 0) {
      const none = reviewResult(
        'dynamics',
        [
          reviewItem(
            'dynamics',
            'FPR_NO_MOTION',
            'not_run',
            [],
            'Add rigid bodies and joints (add_rigid_body, add_body_joint) and a drive (add_motor), then retry; see inspect_dynamics.',
            { unverified: true },
          ),
        ],
        provenance(undefined),
        hash,
      );
      return report(doc, reviewSummary(NAME, none, 'Next: build the dynamics model.'), none);
    }
    const stat = staticChecks(doc, context.kernel);
    const items: ReviewItem[] = [...stat.items];
    let engine: string | undefined;
    if (!stat.simulatable.ok) items.push(...notRunItems(stat.simulatable.why, false));
    else {
      const common = {
        duration: params.duration ?? DEFAULT_DURATION,
        ...(params.sampleRate !== undefined ? { sampleRate: params.sampleRate } : {}),
      };
      const first = simulateMotion.run(
        doc,
        { ...common, energy: true, ...(params.timestep !== undefined ? { timestep: params.timestep } : {}) },
        ctx,
      );
      const run = asRun(first.data);
      if (run === null) items.push(...notRunItems(reasonOf(first.summary), stat.simulatable.loops > 0));
      else {
        engine = run.engine;
        const half = run.timestep / 2;
        const second = half < MIN_TIMESTEP ? null : simulateMotion.run(doc, { ...common, timestep: half }, ctx);
        const fine = second === null ? null : asRun(second.data);
        items.push(
          ...loopDriftItem(run),
          energyItem(run),
          timestepItem(
            run,
            fine,
            second === null
              ? `the timestep ${run.timestep} s cannot be halved (minimum ${MIN_TIMESTEP} s)`
              : fine === null
                ? reasonOf(second.summary)
                : null,
          ),
          ...tipMachItems(run),
        );
      }
    }
    const result = reviewResult('dynamics', items, provenance(engine), {
      ...hash,
      engine: engine ?? null,
      kernel: context.kernel?.name ?? null,
    });
    const next =
      result.status === 'pass' ? 'Next: check_prototype.' : 'Next: fix the failing / warned items (see remediation), then re-run.';
    return report(doc, reviewSummary(NAME, result, next), result);
  },
});
