/** Solution verification of an engine run by timestep halving (check_timestep_convergence, FR-FPR-79, VC-FPR-33). */

import type { CommandResult } from '../../types';
import { defineCommand, z } from '../../schema';
import { failer, report } from '../../noop';
import { currentContext } from '../../context';
import { type ReviewItem, reviewItem, reviewResult, reviewSummary } from '../../inspect/reviewEnvelope';
import { solverSettingsOf } from '../../../dynamics/simulationModel';
import { accuracy } from '../../../dynamics/accuracy';
import { dynamicsOf } from '../bodies';
import { crankOf, runOperatingPoint, type PointRun } from './operatingPoint';

const NAME = 'check_timestep_convergence';

/** Mean brake torque (indicated when the engine has no losses) and the peak wrist-pin force of a run. */
function metrics(run: PointRun): { torque: number; torqueKind: 'brake' | 'indicated'; wristPinN: number | null } {
  const brake = run.report.realism?.losses?.brakeTorqueNm;
  return {
    torque: brake ?? run.report.meanTorqueNm ?? 0,
    torqueKind: brake === undefined ? 'indicated' : 'brake',
    wristPinN: run.report.cylinders[0]?.derived?.wristPinN.value ?? null,
  };
}

const relativeChange = (a: number, b: number): number => (a !== 0 ? Math.abs(b - a) / Math.abs(a) : b === 0 ? 0 : Infinity);

/**
 * @affects nothing — read-only; data { review envelope, rpm, timestepS, halfTimestepS, torque, wristPin, accuracy }
 * @invariant same document back, affected []; the change of the mean torque and of the peak wrist-pin force under dt -> dt/2 is compared with
 *            the gate (default solver.timestepSensitivityGate = 1 %); the second run is never merged into the first
 * @failure no physics engine, no cylinder pressure, no rpm to run at, a run that fails, a timestep that cannot be halved -> not_run
 */
export const checkTimestepConvergence = defineCommand({
  name: NAME,
  annotations: { readOnly: true },
  description:
    'Solution verification of an engine run (FR-FPR-79): runs the engine governed at one speed at the solver timestep dt and again at dt/2, ' +
    'and reports the relative change of the mean BRAKE torque (indicated when there are no engine losses) and of the peak wrist-pin force. A ' +
    'change above the gate (default 1 % = solver timestepSensitivityGate of set_dynamics_solver) gives FPR_TIMESTEP_SENSITIVE (warn): use a ' +
    'smaller timestep. The change is the numerical uncertainty U_num that compare_to_reference reports. `rpm` default: the first speed the ' +
    "cylinder heat release was calibrated at, else the crank's initial speed. Needs the physics engine. Read-only. Next: fix the timestep " +
    '(set_dynamics_solver) if it warns, then compare_to_reference.',
  params: z.object({
    rpm: z
      .number()
      .positive()
      .optional()
      .describe('Crank speed to verify at, rpm. Default the first calibrated speed, else the crank initial speed.'),
    cycles: z.number().int().min(1).max(6).optional().describe('Measured cycles after one settling cycle. Default 2.'),
    gate: z
      .number()
      .positive()
      .max(1)
      .optional()
      .describe('Largest accepted relative change. Default the solver setting timestepSensitivityGate (0.01).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, NAME);
    const context = ctx ?? currentContext();
    if (context.physics === null || context.physics === undefined)
      return fail('no physics engine is loaded yet (MuJoCo loads at startup; retry in a moment)');
    const dynamics = dynamicsOf(doc);
    const crank = crankOf(dynamics);
    if (crank === undefined) return fail('the model has no cylinder pressure (add_cylinder_pressure first)');
    const calibrated = Object.values(dynamics.cylinders ?? {}).flatMap((cylinder) =>
      cylinder.model.kind === 'single_zone' ? (cylinder.model.calibratedRpm ?? []) : [],
    )[0];
    const initial = Math.abs(dynamics.joints[crank]?.initialVelocity ?? 0) * (30 / Math.PI);
    const rpm = params.rpm ?? calibrated ?? (initial > 0 ? initial : undefined);
    if (rpm === undefined) return fail('give `rpm` (no calibrated speed and no initial crank speed to default to)');
    const gate = params.gate ?? solverSettingsOf(dynamics).timestepSensitivityGate;
    const cycles = params.cycles ?? 2;
    const base = runOperatingPoint(doc, { mode: 'governed', rpm, cycles }, context);
    const items: ReviewItem[] = [];
    let data: Record<string, unknown> = {};
    if ('error' in base) {
      items.push(
        reviewItem('dynamics', 'FPR_TIMESTEP_SENSITIVE', 'not_run', [crank], `The run at ${rpm} rpm failed: ${base.error}`, {
          unverified: true,
        }),
      );
    } else {
      const fine = runOperatingPoint(doc, { mode: 'governed', rpm, cycles, timestepS: base.timestepS / 2 }, context);
      if ('error' in fine)
        items.push(
          reviewItem('dynamics', 'FPR_TIMESTEP_SENSITIVE', 'not_run', [crank], `The run at half the timestep failed: ${fine.error}`, {
            unverified: true,
          }),
        );
      else {
        const [a, b] = [metrics(base), metrics(fine)];
        const torqueChange = relativeChange(a.torque, b.torque);
        const wristChange = a.wristPinN === null || b.wristPinN === null ? null : relativeChange(a.wristPinN, b.wristPinN);
        const worst = Math.max(torqueChange, wristChange ?? 0);
        const ok = worst <= gate;
        items.push(
          reviewItem(
            'dynamics',
            'FPR_TIMESTEP_SENSITIVE',
            ok ? 'pass' : 'warn',
            [crank],
            ok ? 'None.' : 'Halving the timestep changes the engine result: use a smaller timestep (set_dynamics_solver timestepS).',
            {
              values: {
                rpm,
                timestepS: base.timestepS,
                halfTimestepS: fine.timestepS,
                meanTorqueChange: torqueChange,
                ...(wristChange === null ? {} : { peakWristPinChange: wristChange }),
                gate,
              },
              threshold: {
                value: gate,
                unit: 'relative change',
                source: 'named gate (solution verification, FR-FPR-79)',
                grade: 'A',
                defaulted: params.gate === undefined,
              },
              ...(ok ? {} : { unverified: true }),
              note: `mean ${a.torqueKind} torque ${a.torque.toPrecision(6)} -> ${b.torque.toPrecision(6)} N·m${a.wristPinN === null || b.wristPinN === null ? '' : `; peak wrist-pin force ${a.wristPinN.toPrecision(6)} -> ${b.wristPinN.toPrecision(6)} N`}`,
            },
          ),
        );
        data = {
          rpm,
          timestepS: base.timestepS,
          halfTimestepS: fine.timestepS,
          torqueKind: a.torqueKind,
          meanTorqueNm: { coarse: a.torque, fine: b.torque, change: torqueChange },
          peakWristPinN:
            a.wristPinN === null || b.wristPinN === null ? null : { coarse: a.wristPinN, fine: b.wristPinN, change: wristChange },
          accuracy: {
            meanTorqueChange: accuracy(
              { abs: torqueChange, unit: 'ratio' },
              'timestep halving: relative change of the mean torque (solver self-check)',
              'verification',
              { validationLevel: 1 },
            ),
          },
        };
      }
    }
    const result = reviewResult(
      'dynamics',
      items,
      {
        method: 'simulate_motion governed at the speed, at dt and dt/2; relative change of the mean torque and of the peak wrist-pin force',
        ...('error' in base ? {} : { engine: context.physics.name }),
        tolerances: { gate },
        params: { ...params },
      },
      { dynamics: doc.dynamics ?? null, rpm },
    );
    return report(doc, reviewSummary(NAME, result, 'Next: compare_to_reference.'), { ...result, ...data });
  },
});
