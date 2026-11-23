/** Hostile-input table: the shared decoder of the flow result files (`LLSL` slice, `LLST` streamlines): read by the renderer (served from /cfd/file) and by `cfd_render`. */
import { parseSliceFile, parseStreamlinesFile } from '@aero/cfd/resultFiles';
import { asBytes, type HostileInput, type HostileReader } from './types';

const MAGIC = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** An `n` x `n` slice: version 1, corner at the origin, axes x / y, spacing 0.5; `header` overrides the ten header floats. */
function sliceFile(n: number, header: readonly number[] = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5]): Uint8Array {
  const bytes = new Uint8Array(72 + 4 * n * n);
  bytes.set(MAGIC('LLSL'));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, n, true);
  view.setUint32(12, n, true);
  header.forEach((value, k) => view.setFloat32(16 + 4 * k, value, true));
  for (let k = 0; k < n * n; k += 1) view.setFloat32(72 + 4 * k, Math.sin(k), true);
  return bytes;
}

/** An LLST file of `lines` lines of `each` points; `first` is the first offset, `declaredPoints` the header's point count. */
function lineFile(lines: number, each: number, first = 0, declaredPoints = lines * each): Uint8Array {
  const points = lines * each;
  const bytes = new Uint8Array(16 + 4 * (lines + 1) + 16 * points);
  bytes.set(MAGIC('LLST'));
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, lines, true);
  view.setUint32(12, declaredPoints, true);
  for (let k = 0; k <= lines; k += 1) view.setUint32(16 + 4 * k, k === 0 ? first : k * each, true);
  for (let k = 0; k < 4 * points; k += 1) view.setFloat32(16 + 4 * (lines + 1) + 4 * k, k % 7, true);
  return bytes;
}

const ok = (result: unknown): boolean => typeof result === 'object' && result !== null;
const withWord = (bytes: Uint8Array, at: number, value: number): Uint8Array => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(at, value, true);
  return copy;
};
const withFloat = (bytes: Uint8Array, at: number, value: number): Uint8Array => {
  const copy = bytes.slice();
  new DataView(copy.buffer).setFloat32(at, value, true);
  return copy;
};
const truncated = (build: () => Uint8Array): { name: string; input: () => HostileInput } => ({
  name: 'header cut short',
  input: () => build().subarray(0, 20),
});

export const CFD_FILE_READERS: readonly HostileReader[] = [
  {
    name: 'aero: parseSliceFile (LLSL flow slice)',
    covers: ['domain-aero/src/cfd/resultFiles.ts:parseSliceFile'],
    input: 'bytes',
    build: (records) => sliceFile(Math.min(512, 2 + records)),
    maxRecords: 510,
    read: (input) => parseSliceFile(asBytes(input)),
    accepts: ok,
    extra: [
      truncated(() => sliceFile(4)),
      { name: 'NaN in the header', input: () => sliceFile(4, [0, 0, NaN, 1, 0, 0, 0, 1, 0, 0.5]) },
      { name: 'zero spacing', input: () => sliceFile(4, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0]) },
      { name: 'infinite origin', input: () => sliceFile(4, [Infinity, 0, 0, 1, 0, 0, 0, 1, 0, 0.5]) },
      { name: 'sample count near 2^32', input: () => withWord(sliceFile(4), 8, 0xffffffff) },
      { name: 'both sample counts near 2^32', input: () => withWord(withWord(sliceFile(4), 8, 0xfffffffe), 12, 0xfffffffe) },
    ],
  },
  {
    name: 'aero: parseStreamlinesFile (LLST flow streamlines)',
    covers: ['domain-aero/src/cfd/resultFiles.ts:parseStreamlinesFile'],
    input: 'bytes',
    build: (records) => lineFile(Math.min(4096, records + 1), 3),
    maxRecords: 4000,
    read: (input) => parseStreamlinesFile(asBytes(input)),
    accepts: ok,
    extra: [
      truncated(() => lineFile(3, 4)),
      { name: 'offsets not starting at 0', input: () => lineFile(3, 4, 2) },
      { name: 'empty lines only', input: () => lineFile(50, 0) },
      { name: 'no lines', input: () => lineFile(0, 0) },
      { name: 'line count near 2^32', input: () => withWord(lineFile(3, 4), 8, 0xffffffff) },
      { name: 'point count near 2^32', input: () => withWord(lineFile(3, 4), 12, 0xfffffff0) },
      { name: 'point count disagreeing with the offsets', input: () => lineFile(3, 4, 0, 5) },
      { name: 'one NaN position among the points', input: () => withFloat(lineFile(3, 4), 16 + 4 * 4 + 4 * 5, NaN) },
    ],
  },
];
