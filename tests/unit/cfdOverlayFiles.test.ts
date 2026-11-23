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
});
