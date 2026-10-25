/**
 * Units of a PCF (plant 05 ISO §5.1). Coordinates scale by 25.4 mm per inch. A bore in INCH is the nominal pipe size (NPS 4, 0.75), not the
 * millimetre value of the DN: it maps to the DN through the NPS / DN pairing of the catalogue (4 <-> 100, 0.75 <-> 20); a size outside the pairing falls
 * back to the plain conversion and is reported as unmapped. Stored bores are DN in mm.
 */

import { dnToNps, npsToDn, parseDn, parseNps } from '../../catalog/nominal';
import type { PcfUnit } from '../model';

export const MM_PER_INCH = 25.4;

/** The bore of a file in `unit` as DN mm; `mapped` false when an inch value is no nominal size and was converted by value. */
export function boreToMm(value: number, unit: PcfUnit): { readonly mm: number; readonly mapped: boolean } {
  if (unit === 'MM') return { mm: value, mapped: true };
  const nps = parseNps(value);
  const dn = nps === null ? null : npsToDn(nps);
  return dn === null ? { mm: value * MM_PER_INCH, mapped: false } : { mm: dn.value, mapped: true };
}

/** The bore number written in `unit` for a stored DN mm: the NPS for a nominal size, else the converted value (4 decimals). */
export function boreFromMm(mm: number, unit: PcfUnit): number {
  if (unit === 'MM') return Math.round(mm * 100) / 100;
  const dn = parseDn(mm);
  const nps = dn === null ? null : dnToNps(dn);
  return nps === null ? Math.round((mm / MM_PER_INCH) * 10_000) / 10_000 : nps.value;
}
