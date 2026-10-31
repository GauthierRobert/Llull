/** Test helper: a ZIP with DEFLATE entries (the central directory carries the packed size), for zip-bomb cases. */

import { crc32 } from '@lib/crc32';

/** A ZIP whose entries are deflated (the central directory carries the packed size), so a bomb is tiny. */
export function deflatedZip(entries: { name: string; data: Uint8Array; packed: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length + entry.packed.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, 8, true);
    view.setUint32(14, crc32(entry.data), true);
    view.setUint32(18, entry.packed.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.packed, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc32(entry.data), true);
    cv.setUint32(20, entry.packed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(
    12,
    centrals.reduce((sum, part) => sum + part.length, 0),
    true,
  );
  ev.setUint32(16, offset, true);
  const all = [...parts, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
