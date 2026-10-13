import { describe, expect, it } from 'vitest';
import { alignmentParamsOf, failuresOf, manholeParamsOf, stormParams } from '@ui/panels/civil/civilRules';
import { xy } from '../helpers/xy';

const alignment = { points: '0,0; 10,0; 10,10', radii: '5', spirals: '', surfaceId: '', interval: '', name: '' };

describe('alignmentParamsOf', () => {
  it('gathers points and optional lists', () => {
    expect(alignmentParamsOf({ ...alignment, surfaceId: 's1', interval: '20', name: 'A' })).toEqual({
      ok: true,
      params: { points: xy(0, 0, 10, 0, 10, 10), radii: [5], surfaceId: 's1', stationInterval: 20, name: 'A' },
    });
  });
  it('reports the first malformed field', () => {
    expect(alignmentParamsOf({ ...alignment, points: '0,0' })).toMatchObject({ ok: false });
    expect(alignmentParamsOf({ ...alignment, radii: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('Radii') });
    expect(alignmentParamsOf({ ...alignment, spirals: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('Spirals') });
  });
});

describe('manholeParamsOf', () => {
  const manhole = { position: '1,2', invert: '5', surfaceId: '', numbers: {}, name: '' };
  it('gathers location, invert and filled numeric fields', () => {
    expect(manholeParamsOf({ ...manhole, numbers: { diameter: '1.2', rimElevation: '' } })).toEqual({
      ok: true,
      params: { location: [1, 2], invertElevation: 5, diameter: 1.2 },
    });
  });
  it('requires exactly one point and an invert', () => {
    expect(manholeParamsOf({ ...manhole, position: '1,2; 3,4' }).ok).toBe(false);
    expect(manholeParamsOf({ ...manhole, invert: '' }).ok).toBe(false);
  });
});

describe('drainage helpers', () => {
  it('extracts string failures only', () => {
    expect(failuresOf({ failures: ['a', 1, 'b'] })).toEqual(['a', 'b']);
    expect(failuresOf(null)).toEqual([]);
    expect(failuresOf({})).toEqual([]);
  });
  it('prefers the IDF curve when a, b and c are all given', () => {
    expect(stormParams('50', { a: '1', b: '2', c: '3' })).toEqual({ idf: { a: 1, b: 2, c: 3 } });
    expect(stormParams('50', { a: '1', b: '', c: '3' })).toEqual({ rainfallIntensityMmH: 50 });
  });
});
