/** Where the gas-side numbers of a run come from (FR-FPR-70 / 78): a given table, a calibration at this speed, or a prediction. */

import type { CylinderPressure } from '@core/model/dynamics';

/** Window (relative, and at least one rpm quantum) within which a run counts as being AT a calibration speed. */
const CALIBRATION_SPEED_WINDOW = 0.01;
const CALIBRATION_MIN_WINDOW_RPM = 25;

/**
 * `input` when every model is a pressure table, `calibrated` when every model's heat release was calibrated at a speed within the window of
 * `rpm`, else `predicted` (a single-zone model away from its calibration speeds: the torque-curve shape is a prediction).
 */
export function combustionOrigin(models: readonly CylinderPressure['model'][], rpm: number): 'input' | 'calibrated' | 'predicted' {
  if (models.every((model) => model.kind === 'table')) return 'input';
  const window = Math.max(CALIBRATION_MIN_WINDOW_RPM, CALIBRATION_SPEED_WINDOW * rpm);
  const atCalibration = models.every(
    (model) => model.kind === 'single_zone' && (model.calibratedRpm ?? []).some((calibrated) => Math.abs(calibrated - rpm) <= window),
  );
  return atCalibration ? 'calibrated' : 'predicted';
}
