/** check_prototype: the one last call of a functional-prototype review (PHY-21 FR-FPR-30, TECHNICAL_SPEC 5.7). */

import type { CadDocument } from '../../model/types';
import { PROCESS_IDS } from '../../model/processRules';
import { checkedPrototype } from '../../model/prototype';
import type { Accuracy } from '../../dynamics/accuracy';
import { RAD_PER_S_PER_RPM } from '../../dynamics/forceLaws';
import { announcedSpeed } from '../../dynamics/timestep';
import { isRecord } from '../../lib/isRecord';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { currentContext } from '../context';
import { dynamicsOf } from './bodies';
import { simulateMotion } from './simulate';
import { motionClearanceCheck } from './checkMotionClearance';
import { dynamicsCheck as runDynamicsCheck } from './checkDynamics';
import { mechanismCheck, mobilityOf } from './prototypeMechanism';
import {
  isCheck,
  mergeChecks,
  ownerSummary,
  skippedCheck,
  staleDispositions,
  verdictOf,
  withDispositions,
  type PrototypeCheck,
  type PrototypeItem,
} from './prototypeVerdict';

const NAME = 'check_prototype';
const DEFAULT_DURATION_S = 2;
const MAX_DURATION_S = 600;
/**
 * Coarse anchors of the shared run the clearance sweep probes first (the run keeps every sample for the engine report). A stretch between
 * two anchors is skipped only when the part travel summed over the recorded samples proves the distance cannot reach the contact / best
 * bound there; otherwise it is split down to the recorded samples, so the cap changes the time, not the findings.
 */
const CLEARANCE_MAX_SAMPLES = 720;
/** Settling cycles before the measured ones when the duration comes from the crank speed. */
const SETTLE_CYCLES = 2;

interface Sub {
  readonly result: CommandResult;
  readonly check: PrototypeCheck | null;
}

function runSub(context: ExecutionContext, doc: CadDocument, name: string, params: Record<string, unknown>): Sub | null {
  const command = context.registry(name);
  if (command === undefined) return null;
  const result = command.run(doc, params, context);
  return { result, check: isCheck(result.data) ? result.data : null };
}

function withoutDispositions(doc: CadDocument): CadDocument {
  const prototype = checkedPrototype(doc.prototype);
  return prototype === doc.prototype || prototype === undefined ? doc : { ...doc, prototype };
}

const reasonOf = (summary: string): string => summary.replace(/^[a-z_]+:\s*/, '').replace(/;\s*no-op\.$/, '');

/** Simulated seconds: settle + cycles of 720 deg at the announced crank speed, else the default. */
function durationOf(doc: CadDocument, cycles: number, settleS: number | undefined): number {
  const rpm = announcedSpeed(dynamicsOf(doc)) / RAD_PER_S_PER_RPM;
  if (!(rpm > 0)) return settleS === undefined ? DEFAULT_DURATION_S : settleS + DEFAULT_DURATION_S;
  const cycleS = 120 / rpm;
  return Math.min(MAX_DURATION_S, (settleS ?? SETTLE_CYCLES * cycleS) + cycles * cycleS);
}

/** check_timestep_convergence / compare_to_reference results become dynamics items, with the accuracy each value carries. */
function engineParts(context: ExecutionContext, doc: CadDocument): PrototypeCheck[] {
  const dynamics = dynamicsOf(doc);
  const parts: PrototypeCheck[] = [];
  if (Object.keys(dynamics.cylinders ?? {}).length > 0) {
    const timestep = runSub(context, doc, 'check_timestep_convergence', {});
    const data = timestep?.result.data;
    const accuracy = isRecord(data) && isRecord(data['accuracy']) ? (data['accuracy'] as Record<string, Accuracy>) : undefined;
    if (timestep?.check != null)
      parts.push({
        ...timestep.check,
        items: timestep.check.items.map((item): PrototypeItem => (accuracy === undefined ? item : { ...item, accuracy })),
      });
  }
  if (Object.keys(doc.prototype?.references ?? {}).length > 0) {
    const compared = runSub(context, doc, 'compare_to_reference', { reference: 'all' });
    const data = compared?.result.data;
    const points = isRecord(data) && Array.isArray(data['points']) ? (data['points'] as { accuracy?: Accuracy; rpm: number | null }[]) : [];
    if (compared?.check != null) {
      let point = 0;
      parts.push({
        ...compared.check,
        // reference items carry their point's accuracy (S, D, E, U_val, origin) on the simulated value
        items: compared.check.items.map((item): PrototypeItem => {
          if (item.code !== 'FPR_REFERENCE_MATCH' && item.code !== 'FPR_REFERENCE_MISMATCH') return item;
          const accuracy = points[point++]?.accuracy;
          return accuracy === undefined ? item : { ...item, accuracy: { simulated: accuracy } };
        }),
      });
    } else if (compared !== null)
      parts.push(skippedCheck('dynamics', 'FPR_REFERENCE_MISMATCH', reasonOf(compared.result.summary), 'Fix the reason, then re-run.'));
  }
  return parts;
}

/**
 * @affects nothing — read-only; data { verdict, ownerSummary, checks[4], staleDispositions, durationS, reviewRequired, inputsHash, references? }
 * @invariant same document back, affected []; dispositions are joined, never applied: an accepted fail stays a fail ("fail (accepted)") and
 *   keeps the verdict blocked (spec 11 Q5); a check that could not run is not_run with its reason, never a pass; the checks read the document
 *   without its dispositions, so recording a disposition does not change their hashes
 * @failure no kernel -> rejected by execute (requiresKernel); invalid params -> rejected by execute; no parts -> verdict blocked with the
 *   assembly check not_run (FPR_NO_PARTS)
 */
export const checkPrototype = defineCommand({
  name: NAME,
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'The functional-prototype review in one call: "is this model ready to build and does it work?". Runs, in order, check_assembly ' +
    '(solids, overlaps, floating parts, walls, joints realised), the mechanism mobility (inspect_dynamics rank DOF; check_mechanism for ' +
    'kinematic joints), check_motion_clearance (one simulated run, collisions while it moves), check_dynamics (realistic inputs, loop drift, ' +
    'energy, timestep) and, for engines, check_timestep_convergence and compare_to_reference (when reference data is stored). It stops ' +
    'before the motion checks when a part is invalid or floating, or a loop is open (those checks read not_run with the reason). Returns ' +
    'data { verdict: "blocked" | "ready_for_review", ownerSummary (plain language), checks[] (assembly, mechanism, motion_clearance, dynamics: ' +
    'the review envelope each, items with findingKey and the reviewer disposition joined), staleDispositions, durationS, reviewRequired }. ' +
    'Dispositions (set_review_disposition) are recorded, never applied: an accepted fail reads "fail (accepted)" and keeps the verdict ' +
    'blocked. The simulated duration is two settling cycles plus `cycles` four-stroke cycles at the crank speed (else 2 s). Needs the ' +
    'geometry kernel and the physics engine (without physics the motion checks are not_run). Read-only. Next: fix the fails, record ' +
    'dispositions on the rest, re-run. Computed by llull, not approved: a qualified engineer must review.',
  params: z.object({
    process: z
      .enum(PROCESS_IDS)
      .optional()
      .describe('Manufacturing process whose sourced minimum wall is the wall threshold (check_assembly).'),
    minWallMm: z.number().positive().optional().describe('Minimum wall thickness, mm; overrides process.'),
    clearanceMm: z.number().min(0).optional().describe('Required static and moving clearance between parts, mm. Default 0 (off).'),
    cycles: z.number().int().min(1).max(20).optional().describe('Measured engine cycles (720 deg each) after settling. Default 1.'),
    settleS: z.number().min(0).max(60).optional().describe('Settling time before the measured cycles, s. Default two cycles.'),
    durationS: z.number().positive().max(MAX_DURATION_S).optional().describe('Simulated seconds; overrides cycles / settleS.'),
    crankAxis: z
      .string()
      .optional()
      .describe('Revolute joint whose angle labels motion findings. Default the crank of the first cylinder.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const context = ctx ?? currentContext();
    const dispositions = doc.prototype?.dispositions ?? {};
    // the checks see the document without its dispositions: recording one must not make every disposition stale
    const checked = withoutDispositions(doc);
    const dynamics = dynamicsOf(checked);
    const durationS = params.durationS ?? durationOf(checked, params.cycles ?? 1, params.settleS);
    const crankAxis = params.crankAxis ?? Object.values(dynamics.cylinders ?? {})[0]?.crank;
    const shared = params.clearanceMm === undefined ? {} : { clearanceMm: params.clearanceMm };

    const assemblyRun = runSub(context, checked, 'check_assembly', {
      ...shared,
      ...(params.process === undefined ? {} : { process: params.process }),
      ...(params.minWallMm === undefined ? {} : { minWallMm: params.minWallMm }),
    });
    const assembly =
      assemblyRun?.check ??
      skippedCheck(
        'assembly',
        'FPR_KERNEL_UNSUPPORTED',
        reasonOf(assemblyRun?.result.summary ?? 'check_assembly is not registered'),
        'Install a geometry kernel.',
      );
    const mobility = mobilityOf(context, checked);
    const mechanism = mechanismCheck(context, checked, mobility);

    const stopper = assembly.items.find(
      (item) => item.status === 'fail' && (item.code === 'FPR_PART_INVALID' || item.code === 'FPR_PART_FLOATING'),
    );
    const openLoop = mobility?.openLoops[0]?.joint;
    const stopReason =
      stopper !== undefined
        ? `${stopper.code} on ${stopper.ids.join(', ')} makes the motion checks meaningless`
        : openLoop !== undefined
          ? `FPR_LOOP_OPEN: loop joint '${openLoop}' is open at the start pose`
          : Object.keys(dynamics.bodies).length === 0
            ? 'the document has no rigid bodies, so nothing moves'
            : null;
    const stopCode = stopReason !== null && stopper === undefined && openLoop === undefined ? 'FPR_NO_MOTION' : 'FPR_CHECK_SKIPPED';
    const fix =
      stopCode === 'FPR_NO_MOTION'
        ? 'Add rigid bodies, joints and a drive (add_rigid_body, add_body_joint, add_motor) to check the motion.'
        : 'Fix the blocking finding first, then re-run check_prototype.';

    let motion: PrototypeCheck;
    let dynamicsCheck: PrototypeCheck;
    let closestMm: number | null = null;
    if (stopReason !== null) {
      motion = skippedCheck('motion_clearance', stopCode, stopReason, fix);
      dynamicsCheck = skippedCheck('dynamics', stopCode, stopReason, fix);
    } else {
      // one simulate_motion run (poses + energy) feeds both motion checks (spec 5.7); check_dynamics still halves the timestep on its own
      const crank = crankAxis === undefined || dynamics.joints[crankAxis]?.kind !== 'revolute' ? {} : { crankAxis };
      const sharedRun = simulateMotion.run(checked, { duration: durationS, detail: 'poses', energy: true, ...crank }, context);
      const motionResult = motionClearanceCheck(
        checked,
        { duration: durationS, maxSamples: CLEARANCE_MAX_SAMPLES, ...shared, ...crank },
        context,
        sharedRun,
      );
      const motionRun: Sub = { result: motionResult, check: isCheck(motionResult.data) ? motionResult.data : null };
      motion =
        motionRun?.check ??
        skippedCheck(
          'motion_clearance',
          motionRun?.result.error?.code ?? 'FPR_NO_MOTION',
          reasonOf(motionRun?.result.summary ?? 'check_motion_clearance is not registered'),
          motionRun?.result.error?.remediation ?? fix,
        );
      const minimum = isRecord(motionRun?.result.data) ? motionRun.result.data['minClearance'] : null;
      closestMm = isRecord(minimum) && typeof minimum['mm'] === 'number' ? minimum['mm'] : null;
      const dynamicsResult = runDynamicsCheck(checked, { duration: durationS }, context, sharedRun);
      const dynamicsRun: Sub = { result: dynamicsResult, check: isCheck(dynamicsResult.data) ? dynamicsResult.data : null };
      const base =
        dynamicsRun?.check ??
        skippedCheck('dynamics', 'FPR_NO_MOTION', reasonOf(dynamicsRun?.result.summary ?? 'check_dynamics is not registered'), fix);
      dynamicsCheck = mergeChecks('dynamics', [base, ...engineParts(context, checked)]);
    }

    const checks = [assembly, mechanism, motion, dynamicsCheck].map((check) => withDispositions(check, dispositions));
    const stale = staleDispositions(checks, dispositions);
    const verdict = verdictOf(checks);
    const assemblyData = assemblyRun?.result.data;
    const partCount = isRecord(assemblyData) && Array.isArray(assemblyData['parts']) ? assemblyData['parts'].length : 0;
    const summaryText = ownerSummary(
      checks,
      { parts: partCount, dof: mobility?.dof ?? null, durationS: stopReason === null ? durationS : null, closestMm, stale: stale.length },
      verdict,
    );
    const count = (status: string): number => checks.flatMap((check) => check.items).filter((item) => item.status === status).length;
    const summary =
      `${NAME}: ${verdict} — ${checks.map((check) => `${check.check} ${check.status}`).join(', ')}; ${count('fail')} fail, ${count('warn')} warn, ` +
      `${count('not_run')} not_run${stale.length > 0 ? `, ${stale.length} stale disposition(s)` : ''}. ` +
      (verdict === 'blocked' ? 'Next: fix the fails (see remediation), then re-run.' : 'Next: a qualified engineer reviews the checks.') +
      ' Computed by llull, not approved — needs a qualified engineer.';
    return report(doc, summary, {
      verdict,
      ownerSummary: summaryText,
      checks,
      staleDispositions: stale,
      durationS: stopReason === null ? durationS : null,
      inputsHash: mergeChecks('dynamics', checks).inputsHash,
      reviewRequired: true,
    });
  },
});
