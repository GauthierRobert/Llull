/**
 * Validation of a simulated value against reference data (FR-FPR-77 / 78, TR-FPR-18, TECHNICAL_SPEC 5.8): E = S - D, the validation
 * uncertainty U_val = sqrt(U_num² + U_input² + U_D²) over the terms that are known (the missing ones are listed, never taken as 0), the
 * relative band, and the status. Calibration points are information, never pass evidence; a hold-out miss is a fail for a grade A / B
 * reference and a warning for grade C.
 */

import type { ReferenceData, ReferencePoint, ReferenceQuantity } from '../../model/prototype';
import { accuracy, type Accuracy, type AccuracyBand, type ValidationLevel } from './accuracy';

const REFERENCE_UNITS: Readonly<Record<ReferenceQuantity, string>> = {
  brake_torque_Nm: 'N·m',
  brake_power_kW: 'kW',
  bmep_bar: 'bar',
  static_rpm: 'rpm',
  propeller_rpm: 'rpm',
  bsfc_g_per_kWh: 'g/kWh',
};

type ComparisonStatus = 'pass' | 'fail' | 'warn' | 'info';

export interface PointComparison {
  readonly referenceId: string;
  readonly quantity: ReferenceQuantity;
  readonly unit: string;
  readonly rpm: number | null;
  /** S simulated, D reference, E = S - D (distance outside the window for a window point), E / D. */
  readonly simulated: number;
  readonly reference: number;
  readonly error: number;
  readonly errorRel: number;
  readonly span: { readonly min: number; readonly max: number } | null;
  readonly bandRel: number;
  readonly origin: 'calibrated' | 'predicted';
  readonly holdOut: boolean;
  readonly status: ComparisonStatus;
  readonly code: 'FPR_REFERENCE_MISMATCH' | null;
  /** Absolute uncertainty terms in the unit of the quantity; null = not available. */
  readonly uncertainty: {
    readonly numerical: number | null;
    readonly input: number | null;
    readonly reference: number | null;
    readonly validation: number | null;
    readonly missing: readonly string[];
  };
  readonly accuracy: Accuracy;
}

export interface ComparisonInput {
  readonly reference: ReferenceData;
  readonly point: ReferencePoint;
  /** The simulated value S. */
  readonly simulated: number;
  /** Relative change of the result under timestep halving (U_num / S), null when not run. */
  readonly numericalRel: number | null;
  /** Accuracy band of S from the model's inputs (null = none stated). */
  readonly inputBand: AccuracyBand;
}

/** True when the point's speed is one the reference names as a calibration point. */
const isCalibrationPoint = (reference: ReferenceData, point: ReferencePoint): boolean =>
  point.rpm !== undefined && reference.calibrationRpm.some((rpm) => Math.abs(rpm - (point.rpm ?? NaN)) < 1e-9);

/** E of a simulated value against a point: S - D, or the distance outside the min..max window (0 inside). */
function errorOf(simulated: number, point: ReferencePoint, span: { min: number; max: number } | null): number {
  if (span === null) return simulated - point.value;
  return simulated < span.min ? simulated - span.min : simulated > span.max ? simulated - span.max : 0;
}

/** The comparison of one simulated value with one reference point. */
export function comparePoint(input: ComparisonInput): PointComparison {
  const { reference, point, simulated } = input;
  const span = point.min !== undefined && point.max !== undefined ? { min: point.min, max: point.max } : null;
  const calibration = isCalibrationPoint(reference, point);
  const error = errorOf(simulated, point, span);
  const errorRel = point.value !== 0 ? error / point.value : error === 0 ? 0 : Infinity;
  const pass = span === null ? Math.abs(errorRel) <= reference.bandRel : error === 0;
  const missing: string[] = [];
  const numerical = input.numericalRel === null ? null : Math.abs(input.numericalRel * simulated);
  if (numerical === null) missing.push('U_num (timestep halving not run)');
  const band = input.inputBand;
  const inputTerm = band === null ? null : 'rel' in band ? Math.abs(band.rel * simulated) : band.abs;
  if (inputTerm === null) missing.push('U_input (no band stated for the model inputs)');
  const readingUncertainty = point.uncertainty ?? null;
  if (readingUncertainty === null) missing.push('U_D (reference uncertainty not given)');
  const terms = [numerical, inputTerm, readingUncertainty].filter((term): term is number => term !== null);
  const validation = terms.length === 0 ? null : Math.sqrt(terms.reduce((sum, term) => sum + term * term, 0));
  const status: ComparisonStatus = calibration ? 'info' : pass ? 'pass' : reference.grade === 'C' ? 'warn' : 'fail';
  const level: ValidationLevel = calibration ? 1 : pass ? 2 : 0;
  const unit = REFERENCE_UNITS[reference.quantity];
  return {
    referenceId: reference.id,
    quantity: reference.quantity,
    unit,
    rpm: point.rpm ?? null,
    simulated,
    reference: point.value,
    error,
    errorRel,
    span,
    bandRel: reference.bandRel,
    origin: calibration ? 'calibrated' : 'predicted',
    holdOut: !calibration,
    status,
    code: status === 'fail' || status === 'warn' ? 'FPR_REFERENCE_MISMATCH' : null,
    uncertainty: { numerical, input: inputTerm, reference: readingUncertainty, validation, missing },
    accuracy: {
      ...accuracy(
        validation === null ? null : { abs: validation, unit },
        'validation uncertainty U_val = sqrt(U_num² + U_input² + U_D²) over the known terms [E-R36]',
        calibration ? 'calibrated' : 'predicted',
        {
          validationLevel: level,
          warnings: [
            ...(calibration ? ['calibration point: matched to the reference by construction, not validation evidence'] : []),
            ...missing,
          ],
        },
      ),
      comparison: { referenceId: reference.id, s: simulated, d: point.value, e: error, uVal: validation },
    },
  };
}

export interface ComparisonSummary {
  readonly status: 'pass' | 'warn' | 'fail' | 'not_run';
  readonly calibrationPoints: number;
  readonly holdOutPoints: number;
  readonly holdOutPassed: number;
  readonly validationLevel: ValidationLevel;
  readonly statement: string;
}

/** The overall status and validation level of a set of point comparisons (FR-FPR-78: calibrated-only evidence is level <= 1). */
export function summariseComparison(points: readonly PointComparison[]): ComparisonSummary {
  const holdOut = points.filter((point) => point.holdOut);
  const passed = holdOut.filter((point) => point.status === 'pass').length;
  const status =
    points.length === 0
      ? 'not_run'
      : holdOut.some((p) => p.status === 'fail')
        ? 'fail'
        : holdOut.some((p) => p.status === 'warn')
          ? 'warn'
          : 'pass';
  const level: ValidationLevel = points.length === 0 ? 0 : holdOut.length === 0 ? 1 : passed === holdOut.length ? (passed >= 4 ? 3 : 2) : 1;
  const statement =
    holdOut.length === 0
      ? 'every point is a calibration point: no predictive evidence (validation level 1)'
      : `${passed} of ${holdOut.length} hold-out points inside the band; ${points.length - holdOut.length} calibration point(s) are information only`;
  return {
    status,
    calibrationPoints: points.length - holdOut.length,
    holdOutPoints: holdOut.length,
    holdOutPassed: passed,
    validationLevel: level,
    statement,
  };
}
