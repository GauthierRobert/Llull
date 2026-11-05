// Utilisation → colour on the model: green below 0.7, amber below 1, red from 1 (or when the check reports the row as failing).

import type { BuildingModel } from '@aec/index';
import type { UtilisationMark } from '@ui/store/structuralOverlayStore';
import { isFailing, isRefused, type ReportRow } from './structuralReport';

export const UTILISATION_COLORS = { ok: '#3ddc84', warn: '#ffb300', fail: '#ff4d4f', refused: '#9e9e9e' } as const;

export type UtilisationBand = keyof typeof UTILISATION_COLORS;

export const UTILISATION_LEGEND: ReadonlyArray<{ band: UtilisationBand; text: string }> = [
  { band: 'ok', text: '< 0.7' },
  { band: 'warn', text: '0.7 – 1' },
  { band: 'fail', text: '≥ 1' },
  { band: 'refused', text: 'refused (not checked)' },
];

export function utilisationBand(utilisation: number, ok = true, refused = false): UtilisationBand {
  if (refused) return 'refused';
  if (!ok || utilisation >= 1) return 'fail';
  return utilisation >= 0.7 ? 'warn' : 'ok';
}

export const utilisationColor = (utilisation: number, ok = true, refused = false): string =>
  UTILISATION_COLORS[utilisationBand(utilisation, ok, refused)];

/** The rows of a check as overlay marks (rows whose element has no geometry are dropped). */
export function toUtilisationMarks(rows: readonly ReportRow[], building: BuildingModel | undefined): UtilisationMark[] {
  // One mark per element, carrying its worst row (a member checked for several effects is coloured by the governing one).
  const byElement = new Map<string, UtilisationMark>();
  for (const row of rows) {
    const entityIds = building?.elements[row.elementId]?.entityIds ?? [];
    if (entityIds.length === 0) continue;
    const mark = {
      key: row.key,
      entityIds,
      utilisation: row.utilisation,
      failing: isFailing(row),
      refused: isRefused(row),
      label: row.label,
    };
    const known = byElement.get(row.elementId);
    // A refused row is never hidden behind a computed one.
    if (
      known === undefined ||
      mark.refused ||
      (!known.refused && (mark.utilisation > known.utilisation || (mark.failing && !known.failing)))
    )
      byElement.set(row.elementId, { ...mark, failing: mark.failing || (known?.failing ?? false) });
    else if (mark.failing) byElement.set(row.elementId, { ...known, failing: true });
  }
  return [...byElement.values()];
}
