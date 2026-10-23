/**
 * Size comparison for specs: a spec range may be written in NPS or DN, a query in either; both reduce to one ordinal (the NPS value, or DN / 25 for
 * a DN without an NPS pairing) so ranges compare without float equality on keys. Pure.
 */

import { dnToNps, en10220Dns, parseDn, parseNps, sizePair } from '../catalog/nominal';
import { bundledCatalog } from '../catalog/bundled';
import type { NominalSize } from '../catalog/types';

/** Comparable position of a size on the nominal scale. */
export function sizeOrdinal(size: NominalSize): number {
  if (size.system === 'NPS') return size.value;
  return dnToNps(size)?.value ?? size.value / 25;
}

export const sizeLabel = (size: NominalSize): string => (size.system === 'NPS' ? `NPS ${size.key}` : `DN ${size.key}`);

export const inRange = (size: NominalSize, from: NominalSize, to: NominalSize): boolean => {
  const ordinal = sizeOrdinal(size);
  return ordinal >= sizeOrdinal(from) - 1e-9 && ordinal <= sizeOrdinal(to) + 1e-9;
};

export const rangesOverlap = (aFrom: NominalSize, aTo: NominalSize, bFrom: NominalSize, bTo: NominalSize): boolean =>
  sizeOrdinal(aFrom) <= sizeOrdinal(bTo) + 1e-9 && sizeOrdinal(bFrom) <= sizeOrdinal(aTo) + 1e-9;

export interface QuerySize {
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
}

/** A query size (NPS or DN) as a nominal size, or null when it is neither. */
export function querySize(query: QuerySize): NominalSize | null {
  const pair = sizePair(query);
  if (pair === null) return null;
  return query.nps !== undefined ? pair.nps : pair.dn;
}

/** The key of `size` in the given system (`"2-1/2"` for NPS, `"65"` for DN) through the fixed pairing, or null when it has none. */
export function keyIn(size: NominalSize, system: NominalSize['system']): string | null {
  if (size.system === system) return size.key;
  const pair = sizePair(size.system === 'NPS' ? { nps: size.key } : { dn: size.key });
  return (system === 'NPS' ? pair?.nps : pair?.dn)?.key ?? null;
}

/** A size from a file value in the given system, or null. */
export const parseSize = (system: 'nps' | 'dn', input: string | number): NominalSize | null =>
  system === 'nps' ? parseNps(input) : parseDn(input);

/** Standard sizes of the system within `[from, to]`: B36.10M NPS keys for an NPS range, the EN 10220 DN series for a DN range. */
export function sizesInRange(from: NominalSize, to: NominalSize): readonly NominalSize[] {
  const all: NominalSize[] =
    from.system === 'NPS'
      ? [
          ...new Set(
            bundledCatalog()
              .families.filter((family) => family.id === 'asme-b36.10m')
              .flatMap((family) => family.sizes.map((size) => size.size.key)),
          ),
        ].flatMap((key) => parseNps(key) ?? [])
      : en10220Dns().flatMap((dn) => parseDn(dn) ?? []);
  return all.filter((size) => inRange(size, from, to)).sort((a, b) => sizeOrdinal(a) - sizeOrdinal(b));
}
