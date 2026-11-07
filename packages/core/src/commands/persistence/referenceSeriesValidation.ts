/** Load-time validation of `dynamics.referenceSeries` (PHY-23 DRV-M3): measured / datasheet time series. Total: hostile records give a problem, never a throw. */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { SERIES_QUANTITIES } from '../../model/drives';

/** Most points of one series (a 100 kHz recording of one second). */
const MAX_POINTS = 100_000;

const isNumberArray = (value: unknown): value is readonly number[] => Array.isArray(value) && value.every(isFiniteNumber);

/** Problem of a reference series record, or null. */
export function referenceSeriesProblem(series: Record<string, unknown>): string | null {
  const quantity = series['quantity'];
  if (typeof quantity !== 'string' || !(SERIES_QUANTITIES as readonly string[]).includes(quantity))
    return `quantity must be one of ${SERIES_QUANTITIES.join(', ')}`;
  if (typeof series['target'] !== 'string' || series['target'] === '') return 'target must be a joint id, motor id or ledger element name';
  const [times, values] = [series['times'], series['values']];
  if (!isNumberArray(times) || !isNumberArray(values) || times.length !== values.length || times.length === 0)
    return 'times and values must be non-empty arrays of finite numbers of the same length';
  if (times.length > MAX_POINTS) return `at most ${MAX_POINTS} points`;
  if (times.some((time, k) => time < 0 || (k > 0 && time <= (times[k - 1] ?? Number.NaN))))
    return 'times must be >= 0 and strictly increasing';
  if (quantity === 'ledger_energy' && times.length !== 1) return 'a ledger_energy series has exactly one point (the end of the run)';
  const source = series['source'];
  if (!isRecord(source) || typeof source['name'] !== 'string' || !['A', 'B', 'C'].includes(String(source['grade'])))
    return 'source must be { name, grade: A | B | C }';
  const [uncertainty, band] = [series['uncertainty'], series['bandRel']];
  if (uncertainty !== undefined && !(isFiniteNumber(uncertainty) && uncertainty >= 0)) return 'uncertainty must be >= 0';
  if (band !== undefined && !(isFiniteNumber(band) && band > 0)) return 'bandRel must be > 0';
  return null;
}

/** Cross references of the series: a `joint_*` series names a joint, a `motor_*` series a datasheet (dc) motor of the same dynamics record; as problems with their paths. */
export function referenceSeriesReferenceProblems(dynamics: Record<string, unknown>): string[] {
  const [series, joints, motors] = [dynamics['referenceSeries'], dynamics['joints'], dynamics['motors']];
  if (!isRecord(series) || !isRecord(joints) || !isRecord(motors)) return [];
  return Object.entries(series).flatMap(([id, record]): string[] => {
    if (!isRecord(record) || typeof record['quantity'] !== 'string' || typeof record['target'] !== 'string') return [];
    const [quantity, target] = [record['quantity'], record['target']];
    if (quantity.startsWith('joint_') && !isRecord(joints[target]))
      return [`dynamics.referenceSeries['${id}']: joint '${target}' does not exist`];
    if (quantity.startsWith('motor_') && !(isRecord(motors[target]) && motors[target]['kind'] === 'dc'))
      return [`dynamics.referenceSeries['${id}']: no datasheet (dc) motor '${target}'`];
    return [];
  });
}
