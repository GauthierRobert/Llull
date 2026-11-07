/** size_drive: can this motor do this duty cycle? RMS, peak and thermal demand against the datasheet, the limiting factor, and a gear-ratio sweep. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, failer, report } from '@core/commands/noop';
import type { DcMotor } from '@core/model/drives';
import { transmissionRatio } from '@core/model/transmissions';
import { buildSimulationModel, jointInertiaOf } from '../sim/simulationModel';
import { provenanceOf, weakInputs, type ProvenanceInput } from '../sim/provenance';
import { inertiaMatchedRatio } from '../sim/sizing';
import { refusalText, type RunData } from '../sim/runData';
import { sizingOf, type Factor, type SizingFinding, type SizingReport } from '../sim/sizingReport';
import { dynamicsOf } from './bodies';
import { drivenTimestep, gearOf, MIN_STEP, profileWindow, runSizing, withReduction, type SizingRunOptions } from './sizingRun';

const NAME = 'size_drive';
const MAX_SWEEP = 12;
/** Named defaults of the documented parameters: the headroom a factor must keep, the ambient of the thermal network, the step when no drive gives one (s). */
const DEFAULT_MARGIN = 0.2;
const DEFAULT_AMBIENT_C = 25;
const DEFAULT_STEP = 1e-3;

/** One row of the ratio sweep: the sizing of the duty cycle at a reduction (motor turns per output turn). */
interface SweepRow {
  readonly reduction: number;
  readonly error?: string;
  readonly peakShaftTorqueNm?: number;
  readonly rmsShaftTorqueNm?: number;
  readonly peakCurrentA?: number;
  readonly rmsCurrentA?: number;
  readonly peakSpeedRpm?: number;
  /** J_load / (N² J_motor): 1 at the inertia match. */
  readonly inertiaRatio?: number;
  readonly limiting?: { readonly factor: Factor; readonly margin: number } | null;
  readonly verdict?: SizingReport['verdict'];
}

interface Sweep {
  readonly rows: SweepRow[];
  readonly best: SweepRow | null;
  readonly inertiaMatchedRatio: number | null;
  readonly currentReduction: number;
}

/** The load and motor inertias (kg·m²) the matching ratio needs, or null when a joint has no inertia of its own. */
function inertiasOf(
  doc: CadDocument,
  motor: DcMotor,
  driven: string,
  timestep: number,
  ctx: ExecutionContext | undefined,
): { readonly load: number; readonly rotor: number } | null {
  const built = buildSimulationModel(doc, timestep, ctx?.kernel ?? null);
  if ('error' in built) return null;
  const [load, rotor] = [jointInertiaOf(built, driven), jointInertiaOf(built, motor.joint)];
  return load === undefined || rotor === undefined ? null : { load, rotor };
}

/** Best row: the highest margin of its limiting factor, then the lowest peak shaft torque. */
function bestRow(rows: readonly SweepRow[]): SweepRow | null {
  const ok = rows.filter((row) => row.error === undefined && row.limiting !== undefined && row.limiting !== null);
  const first = ok[0];
  if (first === undefined) return null;
  return ok.reduce((best, row) => {
    const [a, b] = [best.limiting?.margin ?? Number.NEGATIVE_INFINITY, row.limiting?.margin ?? Number.NEGATIVE_INFINITY];
    return b > a || (b === a && (row.peakShaftTorqueNm ?? Infinity) < (best.peakShaftTorqueNm ?? Infinity)) ? row : best;
  }, first);
}

const pct = (margin: number): string => `${(margin * 100).toFixed(0)} %`;

function sweepOf(
  doc: CadDocument,
  motor: DcMotor,
  gear: NonNullable<ReturnType<typeof gearOf>>,
  reductions: readonly number[],
  options: SizingRunOptions,
  limits: { readonly ambientC: number; readonly margin: number },
  ctx: ExecutionContext | undefined,
): Sweep {
  const inertias = inertiasOf(doc, motor, gear.driven, options.timestep === undefined ? DEFAULT_STEP : options.timestep, ctx);
  const rows = reductions.map((reduction): SweepRow => {
    const copy = withReduction(doc, gear.id, reduction);
    if (copy === null) return { reduction, error: 'the gear is gone' };
    const run = runSizing(copy, options, ctx);
    const drive = run.data?.drives?.[motor.id];
    const sized = drive === undefined ? null : sizingOf(motor, drive, limits.ambientC, limits.margin);
    if (sized === null) return { reduction, error: refusalText(run.result.summary) };
    return {
      reduction,
      peakShaftTorqueNm: sized.demand.peakShaftTorqueNm,
      rmsShaftTorqueNm: sized.demand.rmsShaftTorqueNm,
      peakCurrentA: sized.demand.peakCurrentA,
      rmsCurrentA: sized.demand.rmsCurrentA,
      peakSpeedRpm: sized.demand.peakSpeedRpm,
      ...(inertias === null ? {} : { inertiaRatio: inertias.load / (reduction * reduction * inertias.rotor) }),
      limiting: sized.limiting,
      verdict: sized.verdict,
    };
  });
  return {
    rows,
    best: bestRow(rows),
    inertiaMatchedRatio: inertias === null ? null : inertiaMatchedRatio(inertias.rotor, inertias.load),
    currentReduction: 1 / Math.abs(transmissionRatio(gear)),
  };
}

function summaryOf(
  motorId: string,
  seconds: number,
  sized: SizingReport,
  findings: readonly SizingFinding[],
  lowest: ProvenanceInput | undefined,
  sweep: Sweep | null,
  run: RunData,
): string {
  const { demand } = sized;
  const limit =
    sized.limiting === null
      ? 'no factor could be evaluated'
      : `limiting factor ${sized.limiting.factor} (margin ${pct(sized.limiting.margin)})`;
  const heat =
    sized.thermal === null
      ? 'thermal not evaluated (no thermal data)'
      : sized.thermal.runaway
        ? 'THERMAL RUNAWAY at the RMS current'
        : `winding steady ${sized.thermal.steadyAtRmsC?.toFixed(1)} C at the RMS current, peak ${sized.thermal.peakWindingC.toFixed(1)} C in the run`;
  const codes = [...new Set(findings.filter((entry) => entry.status !== 'info').map((entry) => entry.code))];
  const best = sweep?.best ?? null;
  const matched = sweep?.inertiaMatchedRatio ?? null;
  return (
    `size_drive: motor ${motorId} over ${seconds} s at dt ${run.timestep} s: peak ${demand.peakCurrentA.toPrecision(4)} A / ${demand.peakShaftTorqueNm.toPrecision(4)} N·m at the shaft, ` +
    `${demand.peakSpeedRpm.toFixed(0)} rpm, RMS ${demand.rmsCurrentA.toPrecision(4)} A / ${demand.rmsShaftTorqueNm.toPrecision(4)} N·m; ${limit}; ${heat}; verdict ${sized.verdict}` +
    `${codes.length > 0 ? ` (${codes.join(', ')})` : ''}.` +
    `${lowest === undefined ? '' : ` Lowest-grade input: ${lowest.id} (${lowest.grade}).`}` +
    `${best === null ? '' : ` Sweep: best N ${best.reduction}${matched === null ? '' : `, inertia-matched N ${matched.toPrecision(4)}`}.`}` +
    ' Next: fix the limiting factor, then check_motion_truth.'
  );
}

/**
 * @affects nothing — read-only; returns data { motor, window, demand, capacity, margins, limiting, thermal, findings, verdict, ledger, provenance, sweep? }
 * @invariant input document deep-equal, no FeatureStep, affected []; the ratio sweep runs on copies of the model, never on the stored one; a factor
 *            without a datasheet value is listed in notEvaluated, never passed; the verdict is `over` on any fail finding, `marginal` below the requested margin
 * @failure unknown / non-datasheet motor -> no-op; no drive or no profile (and no `duration`) -> DRV_NO_DUTY_CYCLE; simulation refused -> DRV_SOURCE_FAILED
 *          (the reason quoted); ratioSweep without a gear driven by the motor's joint -> DRV_SWEEP_NO_GEAR
 * @invariant kernel-optional: the simulation reads body mass properties through the kernel when present, mesh integration otherwise
 */
export const sizeDrive = defineCommand({
  name: NAME,
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Size a datasheet DC motor (add_motor kind "dc" with set_motor_drive) for its duty cycle: simulates the drive over whole repeats of its profile ' +
    '(or `duration`) and reports, against the datasheet, the PEAK current / shaft torque / speed / voltage, the RMS current and shaft torque over the window ' +
    '(trapezoid-weighted, TR-DRV-21), the winding temperature from the 2-node thermal network (steady value at the RMS current, peak and end of the run; ' +
    'runaway above the current where copper loss feeds itself), the margin of each factor (capacity / demand - 1: peak_current vs the peak or stall current, ' +
    'rms_current vs the nominal current, speed vs the maximum speed, thermal vs the winding limit) and the LIMITING factor (smallest margin). Coded findings: ' +
    'DRV_PEAK_OVER, DRV_RMS_OVER, DRV_SPEED_OVER, DRV_THERMAL_OVER, DRV_THERMAL_RUNAWAY (fail), DRV_VOLTAGE_LIMITED (the current limit or bus voltage clipped ' +
    'the command), DRV_MARGIN_LOW (limiting margin under `margin`), DRV_TRACKING_ERROR, DRV_PARAM_UNSOURCED (inputs of grade C or without a source: the ' +
    'result is unverified, the lowest-grade input is named), DRV_THERMAL_MODEL_FORM (info). verdict "ok" | "marginal" | "over". `ratioSweep` lists reductions N ' +
    '(motor turns per output turn) of the gear driven by the motor\'s joint (add_transmission kind "gear"): the model is copied and re-run per N and each row ' +
    'gives peak / RMS shaft torque, peak speed, the inertia ratio J_load / (N² J_motor) and its limiting margin; `best` is the N with the largest limiting ' +
    'margin and `inertiaMatchedRatio` the analytic sqrt(J_load / J_motor) (the peak-torque optimum of a pure inertial load). data.ledger gives the energy ' +
    'closure, the regenerated energy and the transmission loss of the run. Cost: one simulation, plus one per sweep entry. Read-only. Next: fix the limiting ' +
    'factor (motor, ratio, profile) or check_motion_truth.',
  params: z.object({
    motor: z.string().describe('Id of a datasheet motor (add_motor kind "dc") that has a drive (set_motor_drive).'),
    duration: z
      .number()
      .positive()
      .max(600)
      .optional()
      .describe('Seconds to simulate. Default: the whole drive profile with its repeats (needed when the drive has no profile).'),
    margin: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe(
        'Required headroom of every factor: capacity / demand - 1 must be at least this (default 0.2 = 20 %); below it DRV_MARGIN_LOW is raised.',
      ),
    ambientC: z.number().min(-60).max(150).optional().describe('Ambient temperature of the thermal network, C. Default 25.'),
    ratioSweep: z
      .array(z.number().positive())
      .min(1)
      .max(MAX_SWEEP)
      .optional()
      .describe(
        'Reductions N (motor turns per output turn, > 0) to try on the gear driven by the motor joint; the stored model is not changed.',
      ),
    timestep: z
      .number()
      .min(MIN_STEP)
      .max(0.01)
      .optional()
      .describe('Integration step, s. Default half the controller period of the fastest sampled drive (at most 1 ms).'),
    sampleRate: z
      .number()
      .positive()
      .optional()
      .describe('Recorded samples per second the RMS is read on. Default 1000 (at most 6001 samples per run).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, NAME);
    const dynamics = dynamicsOf(doc);
    const motor = dynamics.motors[params.motor];
    if (motor === undefined) return fail(`no motor '${params.motor}'`);
    if (motor.kind !== 'dc')
      return fail(`motor '${params.motor}' is a ${motor.kind} motor: size_drive needs a datasheet motor (add_motor kind "dc")`);
    const reject = (code: string, why: string, fix: string): CommandResult => codedRejection(doc, NAME, code, why, fix, [motor.id]);
    const drive = dynamics.drives?.[motor.id];
    if (drive === undefined)
      return reject(
        'DRV_NO_DUTY_CYCLE',
        `motor '${motor.id}' has no drive`,
        'Command the motor first: set_motor_drive with a profile (add_motion_profile).',
      );
    const duty = profileWindow(dynamics, drive);
    const seconds = params.duration ?? ('seconds' in duty ? duty.seconds : undefined);
    if (seconds === undefined)
      return reject(
        'DRV_NO_DUTY_CYCLE',
        'error' in duty ? duty.error : 'no duty cycle',
        'Give the drive a profile (set_motor_drive profile) or pass `duration`.',
      );
    const timestep = params.timestep ?? drivenTimestep(Object.values(dynamics.drives ?? {}));
    const options: SizingRunOptions = {
      duration: seconds,
      ...(timestep === undefined ? {} : { timestep }),
      ...(params.sampleRate === undefined ? {} : { sampleRate: params.sampleRate }),
    };
    const gear = gearOf(dynamics, motor.joint);
    if (params.ratioSweep !== undefined && gear === undefined)
      return reject(
        'DRV_SWEEP_NO_GEAR',
        `no gear transmission is driven by joint '${motor.joint}', so there is no ratio to sweep`,
        'Add the reduction with add_transmission kind "gear" (driver = the motor joint), or drop ratioSweep.',
      );
    const base = runSizing(doc, options, ctx);
    if (base.data === null)
      return reject(
        'DRV_SOURCE_FAILED',
        `the simulation did not run: ${refusalText(base.result.summary)}`,
        'Fix the model or the drive until simulate_motion runs, then retry.',
      );
    const driveRun = base.data.drives?.[motor.id];
    if (driveRun === undefined)
      return reject(
        'DRV_SOURCE_FAILED',
        `the simulation reported no drive data for '${motor.id}'`,
        'Check set_motor_drive and that the motor joint moves.',
      );
    const margin = params.margin === undefined ? DEFAULT_MARGIN : params.margin;
    const ambientC = params.ambientC === undefined ? DEFAULT_AMBIENT_C : params.ambientC;
    const sized = sizingOf(motor, driveRun, ambientC, margin);
    if (sized === null)
      return reject('DRV_SOURCE_FAILED', 'the run recorded fewer than two samples of the drive', 'Raise `duration` or `sampleRate`.');
    const provenance = provenanceOf(dynamics);
    const weak = weakInputs(provenance);
    const lowest: ProvenanceInput | undefined = provenance[0];
    const unsourced: SizingFinding[] =
      weak.length === 0
        ? []
        : [
            {
              code: 'DRV_PARAM_UNSOURCED',
              status: 'warn',
              ids: weak.map((input) => input.id),
              fix: 'Give these inputs a source of grade A or B (set_joint_physics / add_transmission / add_motor `source`): until then the sizing is unverified.',
            },
          ];
    const sweep =
      params.ratioSweep === undefined || gear === undefined
        ? null
        : sweepOf(doc, motor, gear, params.ratioSweep, options, { ambientC, margin }, ctx);
    const ledger = base.data.ledger;
    const energyOf = (entries: readonly { kind: string; joules: number }[], kind: string): number =>
      entries.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.joules, 0);
    const findings = [...sized.findings, ...unsourced];
    const data = {
      motor: motor.id,
      joint: motor.joint,
      window: {
        seconds,
        basis: params.duration === undefined ? `whole run of profile '${drive.profile ?? 'none'}'` : 'requested duration',
        timestepS: base.data.timestep,
      },
      ambientC,
      requestedMargin: margin,
      demand: sized.demand,
      capacity: sized.capacity,
      margins: sized.margins,
      limiting: sized.limiting,
      thermal: sized.thermal,
      notEvaluated: sized.notEvaluated,
      findings,
      verdict: sized.verdict,
      tracking: driveRun.tracking ?? null,
      ledger:
        ledger === undefined
          ? null
          : {
              closureRelative: ledger.closureRelative,
              closure: ledger.closure,
              regeneratedJ: energyOf(ledger.entries, 'regeneration'),
              transmissionLossJ: energyOf(ledger.entries, 'transmission_loss'),
            },
      provenance: { lowest: lowest ?? null, inputs: provenance },
      ...(sweep === null ? {} : { sweep }),
    };
    return report(doc, summaryOf(motor.id, seconds, sized, findings, lowest, sweep, base.data), data);
  },
});
