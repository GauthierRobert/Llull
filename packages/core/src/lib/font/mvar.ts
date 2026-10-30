/**
 * Font-wide metrics variations (`MVAR`, 03 WRP, TECHNICAL_SPEC §14.14): value records (a four-letter tag and a row of an ItemVariationStore) whose deltas at the instance are
 * added to the ascender (`hasc`), descender (`hdsc`), line gap (`hlgp`) and cap height (`cpht`) the layout reads; the other tags are read and not used.
 * @invariant at most 256 value records of the declared size, every offset checked by `ByteView`, the store bounded like `HVAR`'s
 * @failure a damaged table -> WRP_FONT_PARSE
 */

import { type ByteView, parseError } from './reader';
import { readItemVariationStore } from './variation';

const MAX_RECORDS = 256;

/** The unrounded delta in font units of each metric tag at `coords` (tags the font does not vary are absent). */
export function readMetricDeltas(mvar: ByteView, coords: readonly number[]): ReadonlyMap<string, number> {
  if (mvar.u16(0) !== 1) throw parseError(`MVAR: version ${mvar.u16(0)} is not 1`);
  const recordSize = mvar.u16(6);
  const count = mvar.u16(8);
  const storeAt = mvar.u16(10);
  if (count > MAX_RECORDS) throw parseError(`MVAR: ${count} value records exceed ${MAX_RECORDS}`);
  if (recordSize < 8) throw parseError(`MVAR: value records of ${recordSize} bytes are shorter than 8`);
  const deltas = new Map<string, number>();
  if (count === 0) return deltas;
  if (storeAt === 0) throw parseError('MVAR: value records without an ItemVariationStore');
  const store = readItemVariationStore(mvar.sub(storeAt, mvar.length - storeAt, 'MVAR store'));
  for (let k = 0; k < count; k++) {
    const at = 12 + k * recordSize;
    deltas.set(mvar.ascii(at, 4), store.delta(mvar.u16(at + 4), mvar.u16(at + 6), coords));
  }
  return deltas;
}
