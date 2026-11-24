/** The shared decoder of the flow result files (LLSL slice, LLST streamlines): what it returns for good files and every named refusal. */
import { describe, expect, it } from 'vitest';
import { parseSliceFile, parseStreamlinesFile } from '@aero/cfd/resultFiles';
import { sliceBytes, streamlinesBytes } from '../../../helpers/cfdFiles';

const word = (bytes: Uint8Array, at: number, value: number, kind: 'f' | 'u'): Uint8Array => {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  if (kind === 'f') view.setFloat32(at, value, true);
  else view.setUint32(at, value, true);
  return copy;
};

describe('parseSliceFile', () => {
  it('decodes the frame, field name, values and finite range, also from a Node Buffer view over a shared pool', () => {
    const bytes = sliceBytes(2, [1, NaN, 3, 4], 'speed');
    const slice = parseSliceFile(Buffer.from(bytes));
    if (typeof slice === 'string') throw new Error(slice);
    expect(slice).toMatchObject({ samples: 2, spacingM: 0.5, field: 'speed', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0] });
    expect(slice.range).toEqual({ min: 1, max: 4 });
    expect(Number.isNaN(slice.values[1])).toBe(true);
    const empty = parseSliceFile(sliceBytes(2, [NaN, NaN, NaN, NaN], 'p'));
    expect(typeof empty === 'string' ? empty : empty.range).toBeNull();
  });

  it('names what is wrong: magic, length, version, counts, header numbers, spacing', () => {
    const good = sliceBytes(2, [1, 2, 3, 4], 'speed');
    expect(parseSliceFile(new Uint8Array(4))).toContain('not an LLSL');
    expect(parseSliceFile(sliceBytes(2, [1, 2, 3], 'p'))).toContain('wrong length');
    expect(parseSliceFile(word(good, 4, 2, 'u'))).toContain('Unsupported slice');
    expect(parseSliceFile(word(good, 8, 3, 'u'))).toContain('Unsupported slice');
    expect(parseSliceFile(word(good, 8, 1000, 'u'))).toContain('Unsupported slice');
    expect(parseSliceFile(word(good, 24, NaN, 'f'))).toContain('non-finite');
    expect(parseSliceFile(word(good, 52, 0, 'f'))).toContain('non-positive spacing');
  });
});

describe('parseStreamlinesFile', () => {
  it('decodes offsets, positions, speeds and the speed range', () => {
    const file = parseStreamlinesFile(Buffer.from(streamlinesBytes()));
    if (typeof file === 'string') throw new Error(file);
    expect(file).toMatchObject({ lineCount: 2, pointCount: 5 });
    expect(file.range).toEqual({ min: 1, max: 5 });
    expect([...file.offsets]).toEqual([0, 3, 5]);
  });

  it('names what is wrong: magic, version, length, counts, offsets, a non-finite position', () => {
    const good = streamlinesBytes();
    expect(parseStreamlinesFile(new Uint8Array(20))).toContain('not an LLST');
    expect(parseStreamlinesFile(word(good, 4, 9, 'u'))).toContain('version');
    expect(parseStreamlinesFile(good.subarray(0, good.length - 4))).toContain('wrong length');
    expect(parseStreamlinesFile(word(good, 8, 0xffffffff, 'u'))).toContain('too many');
    expect(parseStreamlinesFile(word(good, 12, 0xfffffff0, 'u'))).toContain('too many');
    expect(parseStreamlinesFile(word(good, 16, 1, 'u'))).toContain('offsets');
    expect(parseStreamlinesFile(word(good, 20, 9, 'u'))).toContain('offsets');
    expect(parseStreamlinesFile(word(good, 24, 2, 'u'))).toContain('offsets');
    const positionsAt = 16 + 4 * 3;
    expect(parseStreamlinesFile(word(good, positionsAt + 8, NaN, 'f'))).toContain('non-finite position');
  });
});
