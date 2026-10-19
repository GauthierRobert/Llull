/** Persistence validation of the PHY-09 data: `AnalysisCase.dynamics` of dynamic cases and the `analysis.vibration` library. */

import { isRecord } from '@lib/isRecord';
import { historyProblem } from './libraryCommands';
import { spectrumProblem } from './math/psd';

const DAMPING_MODELS = ['modal', 'rayleigh', 'rayleigh_from_ratios', 'structural_material'];
const isDynamic = (type: unknown): boolean => type === 'frequency_response' || type === 'random_response';
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every((v) => typeof v === 'number');

function caseErrors(id: string, analysisCase: Record<string, unknown>): string[] {
  const where = `analysis case '${id}'`;
  const dynamics = analysisCase['dynamics'];
  if (isDynamic(analysisCase['type']) !== (dynamics !== undefined))
    return [`${where}: a dynamics set-up is required for frequency_response / random_response cases and only for them`];
  if (dynamics === undefined) return [];
  if (!isRecord(dynamics) || !isRecord(dynamics['basis'])) return [`${where}: dynamics needs a basis record`];
  const errors: string[] = [];
  const damping = dynamics['damping'];
  if (damping !== undefined && !(isRecord(damping) && DAMPING_MODELS.includes(String(damping['model']))))
    errors.push(`${where}: dynamics.damping has an unknown model`);
  const sweep = dynamics['sweep'];
  if (sweep !== undefined && !(isRecord(sweep) && Number(sweep['fMinHz']) > 0 && Number(sweep['fMaxHz']) > Number(sweep['fMinHz'])))
    errors.push(`${where}: dynamics.sweep needs 0 < fMinHz < fMaxHz`);
  const base = dynamics['base'];
  if (base !== undefined && !(isRecord(base) && base['kind'] === 'acceleration' && ['x', 'y', 'z'].includes(String(base['direction']))))
    errors.push(`${where}: dynamics.base must be an acceleration along x, y or z`);
  return errors;
}

function bagErrors(
  where: string,
  bag: unknown,
  order: unknown,
  check: (name: string, entry: Record<string, unknown>) => string | null,
): string[] {
  if (!isRecord(bag) || !Array.isArray(order)) return [`${where}: expected a record and a name list`];
  const errors: string[] = [];
  const names = Object.keys(bag);
  if (order.length !== names.length || !order.every((name) => typeof name === 'string' && Object.hasOwn(bag, name)))
    errors.push(`${where}: the order list does not match the entries`);
  for (const [name, entry] of Object.entries(bag)) {
    if (!isRecord(entry) || entry['name'] !== name) errors.push(`${where}: entry '${name}' is malformed`);
    else {
      const problem = check(name, entry);
      if (problem !== null) errors.push(`${where}: '${name}' ${problem}`);
    }
  }
  return errors;
}

/** Errors of the PHY-09 parts of a raw document (persistence refuses the file when non-empty). */
export function dynamicsErrors(raw: Record<string, unknown>): string[] {
  const analysis = raw['analysis'];
  if (!isRecord(analysis) || !isRecord(analysis['cases'])) return [];
  const errors = Object.entries(analysis['cases']).flatMap(([id, analysisCase]) =>
    isRecord(analysisCase) ? caseErrors(id, analysisCase) : [],
  );
  const library = analysis['vibration'];
  if (library === undefined) return errors;
  if (!isRecord(library)) return [...errors, 'analysis.vibration: expected a record'];
  errors.push(
    ...bagErrors('analysis.vibration.spectra', library['spectra'], library['spectrumOrder'], (_name, spectrum) => {
      const points = spectrum['points'];
      if (!Array.isArray(points) || !points.every(numbers)) return 'has malformed points';
      return (
        spectrumProblem(points)?.message ?? (['g2/Hz', '(m/s2)2/Hz'].includes(String(spectrum['unit'])) ? null : 'has an unknown unit')
      );
    }),
    ...bagErrors('analysis.vibration.histories', library['histories'], library['historyOrder'], (_name, history) =>
      numbers(history['timeS']) && numbers(history['values'])
        ? (historyProblem(history['timeS'], history['values'])?.message ?? null)
        : 'needs numeric timeS and values',
    ),
  );
  return errors;
}
