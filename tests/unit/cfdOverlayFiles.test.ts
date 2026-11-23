import { describe, expect, it } from 'vitest';
import { parseSliceFile, parseStreamlinesFile } from '@ui/viewport/3d/cfd/cfdFiles';
import { scaleFraction, sliceCorners, sliceTexels, streamlineSegments } from '@ui/viewport/3d/cfd/cfdPaint';
import { sliceBytes, streamlinesBytes } from './../helpers/cfdFiles';

describe('flow result files', () => {
  it('decodes a slice patch with its frame, field name and finite range', () => {
    const slice = parseSliceFile(sliceBytes(2, [1, NaN, 3, 4], 'speed'));
    if (typeof slice === 'string') throw new Error(slice);
    expect(slice).toMatchObject({ samples: 2, spacingM: 0.5, field: 'speed', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0] });
    expect(slice.range).toEqual({ min: 1, max: 4 });
    expect([...sliceTexels(slice, slice.range ?? { min: 0, max: 1 })].filter((_, k) => k % 4 === 3)).toEqual([255, 0, 255, 255]);
  });

  it('refuses damaged slices and streamline files', () => {
    expect(parseSliceFile(new Uint8Array(4))).toContain('not an LLSL');
    expect(parseSliceFile(sliceBytes(2, [1, 2, 3], 'p'))).toContain('wrong length');
    const lines = streamlinesBytes();
    expect(parseStreamlinesFile(lines.subarray(0, lines.length - 4))).toContain('wrong length');
    expect(parseStreamlinesFile(new Uint8Array(20))).toContain('not an LLST');
  });

  it('decodes streamlines and turns each polyline into coloured segments in scene units', () => {
    const file = parseStreamlinesFile(streamlinesBytes());
    if (typeof file === 'string') throw new Error(file);
    expect(file).toMatchObject({ lineCount: 2, pointCount: 5 });
    expect(file.range).toEqual({ min: 1, max: 5 });
    const segments = streamlineSegments(file, { min: 1, max: 5 }, 1000);
    expect(segments.positions).toHaveLength(3 * 6);
    expect([...segments.positions.slice(0, 6)]).toEqual([0, 0, 0, 1000, 0, 0]);
    expect(segments.colors.slice(0, 3)).toEqual(new Float32Array([0, 0, 1]));
  });

  it('places the slice quad around the sample centres', () => {
    const slice = parseSliceFile(sliceBytes(2, [1, 2, 3, 4], 'speed'));
    if (typeof slice === 'string') throw new Error(slice);
    expect([...sliceCorners(slice, 1)].slice(0, 6)).toEqual([-0.25, -0.25, 0, 0.75, -0.25, 0]);
    expect(scaleFraction(5, { min: 5, max: 5 })).toBe(0.5);
    expect(scaleFraction(2, { min: 0, max: 4 })).toBe(0.5);
  });

  it('refuses non-finite header numbers, a non-positive spacing, offsets not starting at 0 and absurd counts', () => {
    const slice = sliceBytes(2, [1, 2, 3, 4], 'speed');
    const word = (bytes: Uint8Array, at: number, value: number, kind: 'f' | 'u'): Uint8Array => {
      const copy = bytes.slice();
      const view = new DataView(copy.buffer);
      if (kind === 'f') view.setFloat32(at, value, true);
      else view.setUint32(at, value, true);
      return copy;
    };
    expect(parseSliceFile(word(slice, 24, NaN, 'f'))).toContain('non-finite');
    expect(parseSliceFile(word(slice, 52, 0, 'f'))).toContain('non-positive spacing');
    const lines = streamlinesBytes();
    expect(parseStreamlinesFile(word(lines, 16, 1, 'u'))).toContain('offsets');
    expect(parseStreamlinesFile(word(lines, 12, 0xfffffff0, 'u'))).toContain('too many');
    expect(parseStreamlinesFile(word(lines, 8, 0xffffffff, 'u'))).toContain('too many');
  });

  it('counts the segments of each polyline (empty and one-point lines have none)', () => {
    const file = {
      lineCount: 3,
      pointCount: 3,
      offsets: new Uint32Array([0, 0, 1, 3]),
      positions: new Float32Array(9),
      speeds: new Float32Array(3),
      range: null,
    };
    expect(streamlineSegments(file, { min: 0, max: 1 }, 1).positions).toHaveLength(6);
  });
});
