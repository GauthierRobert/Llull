/** Shared documents of the 06 STA M2 / M3 suites (millimetre documents; ids are deterministic per document). */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, ok } from '../../../helpers/commandAssertions';

export const BOTH = ['iso_14122', 'osha_1910'];
export const TYPE = '19-W-4 1-1/4x3/16';

export const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** SC-STA-06 frame: grade level, grid x = 0 / 609.6 / 1524 / 3324, y = 0 / 3000, HEB200 columns, IPE200 beams with top of steel at -32 mm. */
export function gratingFrame(): CadDocument {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  doc = apply(doc, 'add_grid_system', { xSpacings: [609.6, 914.4, 1800], ySpacings: [3000] });
  doc = apply(doc, 'add_grid_columns', { profile: 'HEB200' });
  return apply(doc, 'add_grid_beams', { profile: 'IPE200', topOffset: -32 });
}

/** The frame with the SC-STA-06 grating laid over the whole bounds: ids of the three panels. */
export function gratedFrame(extra: Record<string, unknown> = {}): { doc: CadDocument; ids: string[] } {
  const result = ok(gratingFrame(), 'add_grating', {
    supportedBy: 'beams',
    bounds: [
      [0, 0],
      [3324, 3000],
    ],
    gratingType: TYPE,
    bearingBarDirection: [1, 0],
    thickness: 31.75,
    ...extra,
  });
  return { doc: result.document, ids: (result.data as { elementIds: string[] }).elementIds };
}

/** Grade 0 / +4000 levels with a 4000 x 2000 deck on the upper one (SC-STA-05). */
export function deckDoc(): { doc: CadDocument; deck: string; upper: string; lower: string } {
  let doc = apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0, height: 4000 });
  const lower = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_level', { name: '+4000', elevation: 4000, height: 3000 });
  const upper = Object.keys(doc.building?.levels ?? {}).find((id) => id !== lower) as string;
  const slab = ok(doc, 'add_slab', { boundary: rect(0, 0, 4000, 2000), thickness: 30, levelId: upper });
  return { doc: slab.document, deck: slab.affected[0] as string, upper, lower };
}
