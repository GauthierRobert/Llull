/** Brake calibration of a single-zone cylinder at declaration (add_cylinder_pressure heat calibrate_brake, FR-FPR-72 / 78). */

import type { CylinderPressure, DynamicsModel } from '@core/model/dynamics';
import type { EngineLayout } from '../../sim/engineGeometry';
import { calibrateBrakePoint, type BrakePoint, type CalibratedPoint } from '../../sim/engine/brakeCalibration';

type SingleZone = Extract<CylinderPressure['model'], { kind: 'single_zone' }>;

export interface CalibrationSuccess {
  /** The model with its heat replaced by the calibrated heat-vs-rpm table and the calibrated speeds recorded. */
  readonly model: SingleZone;
  readonly points: readonly CalibratedPoint[];
}

export interface CalibrationRefusal {
  readonly error: string;
  /** FPR_NO_LOSSES, FPR_CALIBRATION_FAILED or a pressure-curve code. */
  readonly code: string;
}

/**
 * Calibrate `cylinder` (single-zone) so the engine's brake torque meets `brake` at each point, with the friction of the engine-loss record on
 * its crank. The brake target is for the whole engine: each of `cylinderCount` identical cylinders delivers its share.
 */
export function calibrateCylinder(
  cylinder: CylinderPressure & { model: SingleZone },
  layout: EngineLayout,
  dynamics: DynamicsModel,
  brake: readonly BrakePoint[],
  cylinderCount: number,
): CalibrationSuccess | CalibrationRefusal {
  const losses = Object.values(dynamics.losses ?? {}).find((record) => record.crank === cylinder.crank);
  if (losses === undefined)
    return {
      code: 'FPR_NO_LOSSES',
      error: `crank '${cylinder.crank}' has no engine losses: a brake target needs friction (set_engine_losses first), else indicated and brake torque would be mixed up`,
    };
  const points: CalibratedPoint[] = [];
  for (const target of [...brake].sort((a, b) => a.rpm - b.rpm)) {
    const result = calibrateBrakePoint(cylinder, layout, losses, target, cylinderCount);
    if ('error' in result) return result;
    points.push(result);
  }
  return {
    points,
    model: {
      ...cylinder.model,
      heat: { kind: 'table_vs_rpm', points: points.map((point) => [point.rpm, point.heatJ] as const) },
      calibratedRpm: points.map((point) => point.rpm),
    },
  };
}
