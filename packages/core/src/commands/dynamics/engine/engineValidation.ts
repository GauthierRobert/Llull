/** Load-time validation of the engine-realism fields (losses, gear efficiency, propeller table, reference data). */

import { isRecord } from '../../../lib/isRecord';
import { isFiniteNumber } from '../../../lib/isFiniteNumber';
import { isReservedKey } from '../../../lib/reservedKey';
import { REFERENCE_QUANTITIES } from '../../../model/prototype';

type Check = (record: Record<string, unknown>) => string | null;

const isPoints = (value: unknown, minimum: number, width: number): boolean =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.every((point) => Array.isArray(point) && point.length === width && point.every(isFiniteNumber));

const nonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

export const lossesProblem: Check = (losses) => {
  if (typeof losses['crank'] !== 'string') return 'crank must be a joint id';
  if (!Array.isArray(losses['cylinders']) || !losses['cylinders'].every((id) => typeof id === 'string'))
    return 'cylinders must be an array of cylinder ids';
  if (!isFiniteNumber(losses['oilTempFactor']) || losses['oilTempFactor'] <= 0) return 'oilTempFactor must be > 0';
  const model = losses['model'];
  if (!isRecord(model) || !nonEmptyString(model['source'])) return 'model needs a non-empty source';
  if (model['kind'] === 'chen_flynn')
    return ['aPa', 'bRatio', 'cPaPerRpm', 'dPaPerRpm2'].every((key) => isFiniteNumber(model[key]))
      ? null
      : 'chen_flynn needs finite aPa, bRatio, cPaPerRpm, dPaPerRpm2';
  if (model['kind'] === 'fmep_table')
    return isPoints(model['points'], 2, 2) ? null : 'fmep_table needs points [[rpm, FMEP Pa], ...] (at least 2)';
  return "model.kind must be 'chen_flynn' or 'fmep_table'";
};

/** Optional gear fields: efficiency in (0, 1], teeth [driver, driven] positive integers. */
export function gearExtrasProblem(gear: Record<string, unknown>): string | null {
  const efficiency = gear['efficiency'];
  if (efficiency !== undefined && !(isFiniteNumber(efficiency) && efficiency > 0 && efficiency <= 1)) return 'efficiency must be in (0, 1]';
  const teeth = gear['teeth'];
  if (teeth !== undefined && !(Array.isArray(teeth) && teeth.length === 2 && teeth.every((n) => Number.isInteger(n) && n > 0)))
    return 'teeth must be [driver, driven] positive integers';
  return null;
}

/** Optional propeller fields: airspeedMps >= 0, inertiaKgM2 > 0 and the C_T(J), C_P(J) table with its source. */
export function propellerExtrasProblem(propeller: Record<string, unknown>): string | null {
  const [airspeed, inertia, table] = [propeller['airspeedMps'], propeller['inertiaKgM2'], propeller['table']];
  if (airspeed !== undefined && !(isFiniteNumber(airspeed) && airspeed >= 0)) return 'airspeedMps must be >= 0';
  if (inertia !== undefined && !(isFiniteNumber(inertia) && inertia > 0)) return 'inertiaKgM2 must be > 0';
  if (table === undefined) return null;
  if (
    !isRecord(table) ||
    !isPoints(table['points'], 2, 3) ||
    !nonEmptyString(table['source']) ||
    !['A', 'B', 'C'].includes(String(table['grade']))
  )
    return 'table needs points [[J, Ct, Cp], ...] (at least 2), a source and a grade A | B | C';
  const js = (table['points'] as number[][]).map((point) => point[0] ?? 0);
  return js.every((j, i) => (i === 0 ? j >= 0 : j > (js[i - 1] ?? Infinity)))
    ? null
    : 'table J values must start at >= 0 and strictly increase';
}

function referenceProblem(id: string, reference: unknown): string | null {
  if (!isRecord(reference) || reference['id'] !== id) return `prototype.references['${id}'] must be an object whose id is '${id}'`;
  const at = `prototype.references['${id}']`;
  if (typeof reference['quantity'] !== 'string' || !(REFERENCE_QUANTITIES as readonly string[]).includes(reference['quantity']))
    return `${at}: quantity must be one of ${REFERENCE_QUANTITIES.join(', ')}`;
  const condition = reference['condition'];
  if (
    !isRecord(condition) ||
    (condition['throttle'] !== 'full' && condition['throttle'] !== 'propeller_curve') ||
    !isFiniteNumber(condition['altitudeM'])
  )
    return `${at}: condition needs throttle 'full' | 'propeller_curve' and a finite altitudeM`;
  if (!nonEmptyString(reference['source']) || !['A', 'B', 'C'].includes(String(reference['grade'])))
    return `${at}: source and grade A | B | C required`;
  if (typeof reference['digitised'] !== 'boolean') return `${at}: digitised must be a boolean`;
  if (!isFiniteNumber(reference['bandRel']) || reference['bandRel'] <= 0) return `${at}: bandRel must be > 0`;
  const points = reference['points'];
  const pointsOk =
    Array.isArray(points) &&
    points.length > 0 &&
    points.every(
      (point) =>
        isRecord(point) &&
        isFiniteNumber(point['value']) &&
        ['rpm', 'min', 'max', 'uncertainty'].every((key) => point[key] === undefined || isFiniteNumber(point[key])),
    );
  if (!pointsOk) return `${at}: points must be a non-empty array of { rpm?, value, min?, max?, uncertainty? } with finite numbers`;
  const calibration = reference['calibrationRpm'];
  return Array.isArray(calibration) && calibration.every(isFiniteNumber) ? null : `${at}: calibrationRpm must be an array of numbers`;
}

/** Problems of `prototype.references` (absent is valid). */
export function referencesProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['prototype.references must be an object'];
  return Object.entries(value).flatMap(([id, reference]) => {
    const problem = isReservedKey(id)
      ? `prototype.references: id '${id}' is a reserved JavaScript property name`
      : referenceProblem(id, reference);
    return problem === null ? [] : [problem];
  });
}
