/** check_motion_truth: can this motion result be trusted? Ledger, timestep study, softness, effort, provenance and reference data in one verdict. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { failer, report } from '@core/commands/noop';
import { type ReviewItem, reviewItem, reviewResult } from '@core/model/reviewEnvelope';
import { buildSimulationModel, jointInertiaOf } from '../sim/simulationModel';
import { buildTopology, isRefusal } from '../sim/topology';
import { provenanceOf } from '../sim/provenance';
import { refusalText, runDataOf, type RunData } from '../sim/runData';
import { energyScale, outputCatalogue } from '../sim/truth/outputs';
import { studyItems, studyRows, type StudyRow } from '../sim/truth/studyItems';
import { ledgerItems, ledgerOrderItems } from '../sim/truth/ledgerItems';
import { inertiaVariationItems, stopPenetrationItems } from '../sim/truth/softnessItems';
import { effortItems, provenanceItem, truthVerdict } from '../sim/truth/verdictItems';
import { loopDriftItem } from './dynamicsSimChecks';
import { dynamicsOf } from './bodies';
import { compareSeriesRun, referenceItems } from './engine/referenceSeries';
import { drivenTimestep, MIN_STEP, profileWindow, SIZING_SAMPLE_RATE } from './sizingRun';
import { simulateMotion } from './simulate';

const NAME = 'check_motion_truth';
const DEFAULT_DURATION = 2;

const notRun = (code: string, why: string, fix: string): ReviewItem =>
  reviewItem('dynamics', code, 'not_run', [], fix, { unverified: true, note: why });

/** One run of the model at `timestep` (undefined = simulate_motion's own rule) with the drive series, energy and the joint series; the refusal text when it did not run. */
function simulateAt(doc: CadDocument, duration: number, timestep: number | undefined, ctx: ExecutionContext | undefined): RunData | string {
  const hasCylinders = Object.keys(dynamicsOf(doc).cylinders ?? {}).length > 0;
  const result: CommandResult = simulateMotion.run(
    doc,
    {
      duration,
      detail: 'drives',
      energy: true,
      ...(hasCylinders ? {} : { sampleRate: SIZING_SAMPLE_RATE }),
      ...(timestep === undefined ? {} : { timestep }),
    },
    ctx,
  );
  return runDataOf(result) ?? refusalText(result.summary);
}

/** The duration to simulate: the whole profile of the first profiled drive, else 2 s. */
function defaultDuration(doc: CadDocument): number {
  const dynamics = dynamicsOf(doc);
  for (const drive of Object.values(dynamics.drives ?? {})) {
    const span = profileWindow(dynamics, drive);
    if ('seconds' in span) return Math.min(600, span.seconds);
  }
  return DEFAULT_DURATION;
}

interface Refined {
  readonly runs: RunData[];
  readonly steps: number[];
  /** Why the refinement stopped early, or null when every level ran. */
  readonly stopped: string | null;
}

/** The base run and its halvings (`levels` of them): dt / 2^k, never below the smallest step simulate_motion accepts. */
function refine(doc: CadDocument, base: RunData, duration: number, levels: number, ctx: ExecutionContext | undefined): Refined {
  const runs: RunData[] = [base];
  const steps = [base.timestep];
  for (let k = 1; k <= levels; k++) {
    const step = base.timestep / 2 ** k;
    if (step < MIN_STEP) return { runs, steps, stopped: `dt/${2 ** k} = ${step} s is below the smallest step ${MIN_STEP} s` };
    const run = simulateAt(doc, duration, step, ctx);
    if (typeof run === 'string') return { runs, steps, stopped: `the run at dt/${2 ** k} did not run: ${run}` };
    runs.push(run);
    steps.push(step);
  }
  return { runs, steps, stopped: null };
}

/**
 * @affects nothing — read-only; returns the review envelope (check 'dynamics') in data, plus verdict, study { level, steps, rows[] }, provenance, timestepS
 * @invariant input deep-equal, no FeatureStep, affected []; trusted only when no item fails, warns or is skipped and every graded input is A / B (provenance is
 *            one of the items); an item that could not run is not_run with its reason, never pass; the timestep study reports the OBSERVED order (assumed 1,
 *            and said so, with two levels); an energy closure that is not pass names its cause when it is a servo jump start, never silently passes
 * @failure no physics engine / no rigid bodies / unknown `outputs` key -> no-op with the reason; the base simulation refused -> every simulation item not_run
 *          with the quoted reason; a refinement below 5e-6 s or refused -> the study not_run; engines ["reference"] -> NATIVE_TOOL_MISSING (not_run)
 * @invariant kernel-optional: the simulations read body mass properties through the kernel when present, mesh integration otherwise
 */
export const checkMotionTruth = defineCommand({
  name: NAME,
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Can this motion simulation be trusted? Runs the model and returns the review envelope with ONE verdict: "trusted" (no failing, warning or skipped item and ' +
    'every input grade A / B), "plausible" (no fail, but a warning, a skipped item or an input of grade C / without a source) or "not_trusted" (any fail). ' +
    'Items: (a) DRV_LEDGER_CLOSURE: input - dissipated - stored over the largest term, pass <= 1e-3, warn <= 1e-2; a closure that fails because a velocity ' +
    'servo jump-starts a mass from rest names its cause (DRV_LEDGER_SERVO_JUMP: an impulse of 1/2 J v² the servo work estimate cannot resolve) and DRV_LEDGER_ORDER ' +
    'states the order in which the closure error of a run with end stops / backlash shrinks with the step (first order in dt). (b) DRV_TIMESTEP_STUDY per output: the ' +
    'run at dt, dt/2 (level "quick") and dt/4 ("full"); observed order p and grid-convergence index GCI = 1.25 |f1 - f2| / (2^p - 1) of the finest pair, pass when ' +
    'GCI <= 1 % of the value (warn up to 10 %); with two levels the order is ASSUMED 1 (conservative) and said so; DRV_CONVERGENCE_IRREGULAR when p is outside ' +
    '[0.5, 4]. Outputs: every joint final position / speed (and period), every driven motor RMS joint torque, RMS and peak current, and the numerical errors ' +
    'energy.balanceErrorJ and ledger.closureErrorJ (their order is their slope). (c) softness: FPR_LOOP_DRIFT, DRV_STOP_PENETRATION (peak penetration of a stop / ' +
    'backlash <= 1 % of its travel / gap) and DRV_STOP_INERTIA_VARIES (a stop whose joint carries other moving joints, or sits in a loop, was damped for the inertia ' +
    'at the start configuration: its peak force is approximate). (d) DRV_EFFORT_UNBOUNDED (a governor bound without source, or over 10 x the effort used). ' +
    '(e) DRV_PARAM_UNSOURCED: inputs of grade C or without a source, weakest first (motor sheets, transmission losses, joint friction). (f) DRV_REFERENCE_MATCH / ' +
    'DRV_REFERENCE_MISMATCH for every stored time series (add_reference_data with `series`). (g) engines ["reference"] asks for the independent reference engine: ' +
    'not installed yet (NATIVE_TOOL_MISSING, not_run). Cost: quick = 3 runs of the duration, full = 7 (the step halves, the work doubles). Read-only. Next: fix the ' +
    'failing / warned items (each carries its remediation), regrade inputs with measured values, then check_prototype. Computed by llull, not approved: a qualified engineer must review.',
  params: z.object({
    duration: z
      .number()
      .positive()
      .max(600)
      .optional()
      .describe(
        'Simulated seconds of each run. Default: the whole profile of the first drive that has one, else 2 s. Cover at least one full cycle.',
      ),
    level: z
      .enum(['quick', 'full'])
      .optional()
      .describe(
        '"quick" (default): the study at dt and dt/2 (order assumed 1). "full": dt, dt/2 and dt/4, so the order of convergence is observed.',
      ),
    outputs: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'Keys of the outputs to study (<joint>.finalPosition, <joint>.finalVelocity, <joint>.periodS, <motor>.rmsJointTorque, <motor>.rmsCurrent, <motor>.peakCurrent, energy.balanceErrorJ, ledger.closureErrorJ). Default all.',
      ),
    engines: z
      .array(z.enum(['reference']))
      .optional()
      .describe(
        '["reference"]: also cross-check against the independent reference engine (not installed yet: reported as NATIVE_TOOL_MISSING).',
      ),
    timestep: z
      .number()
      .min(MIN_STEP)
      .max(0.01)
      .optional()
      .describe(
        'Integration step of the first run, s. Default: half the controller period of the fastest sampled drive, else as simulate_motion.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, NAME);
    if (ctx?.physics === null || ctx?.physics === undefined)
      return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
    const dynamics = dynamicsOf(doc);
    if (Object.keys(dynamics.bodies).length === 0)
      return fail('the document has no rigid bodies, so nothing moves (add_rigid_body, add_body_joint)');
    const duration = params.duration ?? defaultDuration(doc);
    const level = params.level ?? 'quick';
    const base = simulateAt(doc, duration, params.timestep ?? drivenTimestep(Object.values(dynamics.drives ?? {})), ctx);
    const items: ReviewItem[] = [];
    let study: { level: string; steps: number[]; rows: StudyRow[] } | null = null;
    if (typeof base === 'string') {
      const why = `the simulation did not run: ${base}`;
      items.push(
        notRun('DRV_LEDGER_CLOSURE', why, 'Fix the model until simulate_motion runs.'),
        notRun('DRV_TIMESTEP_STUDY', why, 'Fix the model until simulate_motion runs.'),
        ...effortItems(Object.values(dynamics.motors), null),
      );
    } else {
      const built = buildSimulationModel(doc, base.timestep, ctx.kernel ?? null);
      const topology = buildTopology(dynamics);
      const inertiaOf = (joint: string): number | undefined => ('error' in built ? undefined : jointInertiaOf(built, joint));
      const catalogue = outputCatalogue(base);
      const keys = catalogue.map((def) => def.key);
      const unknown = (params.outputs ?? []).filter((key) => !keys.includes(key));
      if (unknown.length > 0) return fail(`unknown output(s) ${unknown.join(', ')}; this model offers: ${keys.join(', ')}`);
      const refined = refine(doc, base, duration, level === 'full' ? 2 : 1, ctx);
      const wanted = catalogue.filter((def) => params.outputs === undefined || params.outputs.includes(def.key));
      const rows = refined.stopped === null ? studyRows(wanted, refined.runs, refined.steps, energyScale(base)) : [];
      study = { level, steps: refined.steps, rows };
      items.push(
        ...ledgerItems(base, dynamics, inertiaOf),
        ...(refined.stopped === null
          ? [...studyItems(rows), ...ledgerOrderItems(base, rows)]
          : [notRun('DRV_TIMESTEP_STUDY', refined.stopped, 'Start from a larger timestep, or study a model whose step can be halved.')]),
        ...loopDriftItem(base),
        ...stopPenetrationItems(base, dynamics),
        ...(isRefusal(topology) ? [] : inertiaVariationItems(base, dynamics, topology)),
        ...effortItems(Object.values(dynamics.motors), base),
      );
    }
    const provenance = provenanceOf(dynamics);
    items.push(provenanceItem(provenance));
    const references = Object.values(dynamics.referenceSeries ?? {});
    if (references.length > 0) {
      const span = Math.max(...references.map((reference) => reference.times[reference.times.length - 1] ?? 0));
      if (typeof base !== 'string' && span <= duration + 1e-9) items.push(...referenceItems(references, base));
      else {
        const compared = compareSeriesRun(doc, references, ctx);
        items.push(
          ...('error' in compared
            ? [notRun('DRV_REFERENCE_MISMATCH', compared.error, 'Make the model run, then compare again.')]
            : compared.items),
        );
      }
    }
    if (params.engines?.includes('reference') === true)
      items.push(
        notRun(
          'NATIVE_TOOL_MISSING',
          'no reference engine is installed (DRV-V1): the cross-check against an independent integrator did not run',
          'Wait for the reference engine (physics-reference), or rely on the timestep study and the stored measurements.',
        ),
      );
    const verdict = truthVerdict(items);
    const result = reviewResult(
      'dynamics',
      items,
      {
        method:
          'simulate_motion at dt, dt/2 (and dt/4): energy ledger, grid-convergence index of the outputs, stop softness, effort, provenance, stored references',
        ...(typeof base === 'string' ? {} : { engine: base.engine }),
        tolerances: { ledgerPass: 1e-3, ledgerWarn: 1e-2, gciGate: 0.01, stopPenetration: 0.01 },
        params: { ...params },
      },
      { dynamics: doc.dynamics ?? null, engine: typeof base === 'string' ? null : base.engine, kernel: ctx.kernel?.name ?? null },
    );
    const count = (status: ReviewItem['status']): number => result.items.filter((item) => item.status === status).length;
    const weakest = provenance[0];
    const summary =
      `${NAME}: verdict ${verdict} — ${count('fail')} fail, ${count('warn')} warn, ${count('not_run')} not_run, ${count('pass')} pass, ${count('info')} info (hash ${result.inputsHash}); ` +
      `${typeof base === 'string' ? 'no run' : `dt ${base.timestep} s over ${duration} s, level ${level}`}` +
      `${weakest === undefined ? '' : `; lowest-grade input ${weakest.id} (${weakest.grade})`}. ` +
      `${verdict === 'trusted' ? 'Next: check_prototype.' : 'Next: fix the failing / warned items (see remediation), regrade the weak inputs, then re-run.'} Computed by llull, not approved — needs a qualified engineer.`;
    return report(doc, summary, {
      ...result,
      verdict,
      timestepS: typeof base === 'string' ? null : base.timestep,
      durationS: duration,
      study,
      provenance,
    });
  },
});
