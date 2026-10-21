/**
 * Brake figures and accuracy statements of the analytic engine check (engine_quick_check): FMEP from the engine-loss record at the speed,
 * BMEP = IMEP - FMEP, brake torque / power and mechanical efficiency, each with its accuracy (FR-FPR-70 / 71 / 78).
 */

import type { CylinderPressure, EngineLosses } from '@core/model/dynamics';
import { accuracy, RIGID_BODY_WARNING, type Accuracy } from '../accuracy';
import { combustionOrigin } from './combustionOrigin';
import { efficiencyBand, fmepAt, fmepBand, frictionOrigin, lossBands } from './engineLosses';

const CALIBRATION_BAND = 1e-3;

export interface QuickBrake {
  readonly fmepBar: number;
  readonly bmepBar: number;
  readonly brakeTorqueNm: number;
  readonly brakePowerKW: number;
  readonly mechanicalEfficiency: number;
  readonly outsideValidatedRange: boolean;
}

export interface QuickBrakeInput {
  readonly model: CylinderPressure['model'];
  readonly losses: EngineLosses | undefined;
  /** Net indicated MEP of the cylinder at `rpm`, Pa, and its peak absolute pressure, Pa. */
  readonly imepPa: number;
  readonly peakPa: number;
  readonly rpm: number | undefined;
  /** Swept volume the torque is reported for, m³. */
  readonly displacementM3: number;
  readonly cycle: 'four_stroke' | 'two_stroke';
}

/** The brake figures (null without losses or a speed) and the accuracy of the indicated and brake quantities. */
export function quickBrake(input: QuickBrakeInput): { brake: QuickBrake | null; accuracy: Record<string, Accuracy> } {
  const { model, losses, rpm } = input;
  const origin = rpm === undefined ? (model.kind === 'table' ? 'input' : 'predicted') : combustionOrigin([model], rpm);
  const calibrated = origin === 'calibrated';
  const gasBand = calibrated ? { rel: CALIBRATION_BAND } : null;
  const gasBasis = calibrated
    ? 'heat release calibrated to the brake target at this speed (tolerance 0.1 %): not validation evidence'
    : origin === 'input'
      ? 'gas pressure table given as input; its uncertainty is not stated'
      : 'single-zone combustion away from its calibration speed: no quantitative uncertainty estimate';
  const standing = [RIGID_BODY_WARNING];
  const level = calibrated ? 1 : 0;
  const entries: Record<string, Accuracy> = {
    meanTorqueNm: accuracy(gasBand, gasBasis, origin, { validationLevel: level, warnings: standing }),
    powerKW: accuracy(gasBand, gasBasis, origin, { validationLevel: level, warnings: standing }),
  };
  if (losses === undefined || rpm === undefined) return { brake: null, accuracy: entries };
  const cycleRad = input.cycle === 'four_stroke' ? 4 * Math.PI : 2 * Math.PI;
  const fmep = fmepAt(losses, rpm, input.peakPa);
  const bmep = input.imepPa - fmep.pa;
  const torque = (bmep * input.displacementM3) / cycleRad;
  const friction = fmepBand(losses);
  const bands = lossBands({
    calibrated,
    calibrationBand: CALIBRATION_BAND,
    gasBand,
    frictionBand: friction.band,
    indicated: input.imepPa,
    friction: fmep.pa,
    brake: bmep,
  });
  if (calibrated) {
    const indicatedBasis = 'calibrated brake value plus the friction band, root-sum-square (indicated = brake + friction)';
    for (const key of ['meanTorqueNm', 'powerKW'])
      entries[key] = accuracy(bands.indicated, indicatedBasis, origin, { validationLevel: level, warnings: standing });
  }
  const brakeAccuracy = accuracy(
    bands.brake,
    calibrated
      ? 'brake value calibrated to the target at this speed (tolerance 0.1 %): not validation evidence'
      : 'gas side and friction band, root-sum-square',
    calibrated ? 'calibrated' : origin,
    { validationLevel: level, warnings: standing },
  );
  for (const key of ['brakeTorqueNm', 'brakePowerKW', 'bmepBar']) entries[key] = brakeAccuracy;
  entries['fmepBar'] = accuracy(friction.band, friction.basis, frictionOrigin(losses), { warnings: standing });
  entries['mechanicalEfficiency'] = accuracy(
    efficiencyBand(friction.band, fmep.pa, input.imepPa),
    `${friction.basis}; eta = 1 - FMEP / IMEP, band rel(FMEP) (FMEP / IMEP) / eta`,
    frictionOrigin(losses),
    { warnings: standing },
  );
  return {
    accuracy: entries,
    brake: {
      fmepBar: fmep.pa / 1e5,
      bmepBar: bmep / 1e5,
      brakeTorqueNm: torque,
      brakePowerKW: (torque * rpm * 2 * Math.PI) / 60 / 1000,
      mechanicalEfficiency: input.imepPa > 0 ? bmep / input.imepPa : 0,
      outsideValidatedRange: fmep.outsideRange,
    },
  };
}
