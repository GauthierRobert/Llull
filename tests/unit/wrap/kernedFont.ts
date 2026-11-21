/**
 * A variable TrueType font whose GPOS kerns the pair A B by -80 plus a GDEF 1.3 variation-store delta (row 1: +40 at wght 900), for the instance kerning tests and the hostile-input harness.
 * Row 0 is a decoy (+900) that no reader may apply; `damage` writes the mutations of the harness (device offset, inner row, outer index).
 */

import { buildStore } from './cff2Builder';
import { buildGdef, buildGpos } from './gposBuilder';
import { variable } from './variableTrueType';

export const GDEF_STORE = buildStore({
  axisCount: 2,
  regions: [
    [
      [0, 1, 1],
      [0, 0, 0],
    ],
  ],
  data: [{ regionIndexes: [0], rows: [[900], [40], [-30], [5], [0]] }],
});

type KernDamage = 'deviceOffset' | 'innerRow' | 'outerIndex';

export function kernedDeviceFont(damage?: KernDamage): Uint8Array {
  const gpos = buildGpos([{ type: 2, subtables: [{ format: 1, pairs: [[1, 2, -80, { outer: 0, inner: 1 }]], valueFormat: 0x44 }] }]);
  // tail of the table: [device offset u16] [coverage 6 bytes] [decoy block 8] [device block 8: outer, inner, 0x8000, 0]
  const at = (back: number): number => gpos.length - back;
  if (damage === 'deviceOffset') gpos.splice(at(24), 2, 0xff, 0xff);
  if (damage === 'innerRow') gpos[at(6)] = 0x7f;
  if (damage === 'outerIndex') gpos[at(8)] = 0x7f;
  return variable({ tables: { GPOS: gpos, GDEF: buildGdef(GDEF_STORE) } });
}
