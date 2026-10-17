/** Hole diameter taken from the fastener catalogue (07 FTR M6, VC-FTR-29): `hole.fastener` -> `doc.fasteners.catalogs`. */

import type { CadDocument } from '../../model/types';
import type { FastenerRef } from '../../model/features';
import type { FastenerFamily } from '../../model/fasteners';
import { convertValue, isUnitFailure } from '../../lib/quantity';

export interface FastenerHole {
  /** Clearance hole diameter, document length units (middle of the catalogued min/max). */
  readonly diameter: number;
  readonly source: string;
}

const dashOf = (text: string): string => text.replace(/^-/, '');

/** The catalogue size whose dash is a `-`-separated token of the part number (e.g. NAS1351-3-8 -> dash 3). */
function sizeOf(family: FastenerFamily, partNumber: string): FastenerFamily['sizes'][number] | undefined {
  const tokens = partNumber.split('-').filter((token) => token !== '');
  return family.sizes.find((size) => tokens.includes(dashOf(size.dash)));
}

/**
 * @failure no catalogue / family / size / hole diameter / convertible unit -> reason string
 */
export function holeFromFastener(doc: CadDocument, ref: FastenerRef): FastenerHole | string {
  const catalogs = doc.fasteners?.catalogs ?? {};
  if (Object.keys(catalogs).length === 0) return 'the document has no fastener catalogue (install one with the fasteners commands)';
  const family = catalogs[ref.catalogId];
  if (family === undefined) return `catalogue '${ref.catalogId}' is not in the document (have: ${Object.keys(catalogs).join(', ')})`;
  const size = sizeOf(family, ref.partNumber);
  if (size === undefined) return `part number '${ref.partNumber}' matches no size of catalogue '${ref.catalogId}'`;
  const range = size.holeDiameter;
  if (range === undefined) return `size '${size.dash}' of catalogue '${ref.catalogId}' has no hole diameter`;
  const converted = convertValue((range.min + range.max) / 2, range.unit, doc.units);
  if (isUnitFailure(converted)) return `hole diameter unit '${range.unit}' cannot be converted to ${doc.units}`;
  return { diameter: converted.value, source: `${family.standard.body} ${family.standard.id} size ${size.dash}` };
}
