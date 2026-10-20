/** GVP comparison bands (aerospace 04 §5.3) and the IGES census reader. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_GVP_POLICY, compareGvp, gvpPolicy, isPlaceholder, worstBand } from '@core/commands/exchange/gvpBands';
import { summarizeIges } from '@lib/iges/summary';
import { fakeIgesText } from '../../helpers/fakeXdeKernel';

const sender = { volume: 1000, area: 600, centroid: [10, 0, 0] as [number, number, number] };

describe('compareGvp', () => {
  it('is green inside 1e-3 relative and 1e-3 of the diagonal', () => {
    const check = compareGvp(sender, { volume: 1000.5, area: 600.1, centroid: [10.01, 0, 0] }, 100, 1);
    expect(check.band).toBe('green');
    expect(check.comparisons.map((entry) => entry.property)).toEqual(['volume', 'area', 'centroid']);
    expect(check.policy).toEqual(DEFAULT_GVP_POLICY);
  });

  it('is yellow between the limits (1e-2 relative, 1 mm) and red beyond; the worst property decides', () => {
    expect(compareGvp(sender, { volume: 1005, area: 600, centroid: [10, 0, 0] }, 100, 1).band).toBe('yellow');
    expect(compareGvp(sender, { volume: 1000, area: 600, centroid: [10.5, 0, 0] }, 100, 1).band).toBe('yellow');
    expect(compareGvp(sender, { volume: 1100, area: 600, centroid: [10, 0, 0] }, 100, 1).band).toBe('red');
    expect(compareGvp(sender, { volume: 1000, area: 600, centroid: [12, 0, 0] }, 100, 1).band).toBe('red');
  });

  it('converts the yellow centroid limit (mm) into the comparison unit', () => {
    // 1 mm = 1/25.4 in: 0.05 in apart is 1.27 mm (red), 0.03 in is 0.76 mm (yellow)
    expect(compareGvp({ centroid: [1, 0, 0] }, { centroid: [1.05, 0, 0] }, 1, 25.4).band).toBe('red');
    expect(compareGvp({ centroid: [1, 0, 0] }, { centroid: [1.03, 0, 0] }, 1, 25.4).band).toBe('yellow');
  });

  it('is not checkable for a placeholder or a sender with nothing to compare', () => {
    expect(compareGvp({ volume: 0, area: 0, centroid: [0, 0, 0] }, { volume: 5 }, 1, 1).band).toBe('not-checkable');
    expect(compareGvp({ volume: 7 }, { area: 5 }, 1, 1)).toMatchObject({ band: 'not-checkable', comparisons: [] });
    expect(isPlaceholder({ volume: 0 })).toBe(true);
    expect(isPlaceholder({ volume: 1 })).toBe(false);
    expect(worstBand([])).toBe('not-checkable');
    expect(worstBand(['green', 'not-checkable', 'yellow'])).toBe('yellow');
  });

  it('takes policy overrides and ignores non-positive or non-finite limits', () => {
    expect(gvpPolicy(undefined)).toEqual(DEFAULT_GVP_POLICY);
    expect(gvpPolicy({ greenRel: 5e-3, yellowRel: -1, greenCentroidPerDiag: Number.NaN, yellowCentroidMm: 2 })).toEqual({
      ...DEFAULT_GVP_POLICY,
      greenRel: 5e-3,
      yellowCentroidMm: 2,
    });
    expect(compareGvp(sender, { volume: 1004, area: 600, centroid: [10, 0, 0] }, 100, 1, gvpPolicy({ greenRel: 5e-3 })).band).toBe('green');
  });
});

describe('summarizeIges', () => {
  it('reads the unit, resolution and census; annotation and property types are untranslated', () => {
    const iges = summarizeIges(fakeIgesText([186, 514, 510, 190, 116, 214, 406, 406, 124], { unitFlag: 1, resolution: 0.001 }));
    expect(iges.valid).toBe(true);
    expect(iges.global).toMatchObject({ unitFlag: 1, unitName: 'inch', mmPerUnit: 25.4, resolution: 0.001, author: 'author' });
    expect(iges.entities).toBe(9);
    expect(iges.census).toMatchObject({ '186': 1, '406': 2, '214': 1 });
    expect(iges.geometricEntities).toBe(5);
    expect(iges.untranslated).toEqual({ '124 transformation matrix': 1, '214 leader (arrow)': 1, '406 property': 2 });
  });

  it('knows millimetres and an unnamed unit, and refuses a truncated or garbage text', () => {
    expect(summarizeIges(fakeIgesText([110], { unitFlag: 2 })).global).toMatchObject({ unitName: 'mm', mmPerUnit: 1 });
    expect(summarizeIges(fakeIgesText([110], { unitFlag: 99 })).global.mmPerUnit).toBeNull();
    const whole = fakeIgesText([186, 514]);
    expect(summarizeIges(whole.slice(0, whole.indexOf('\n', 400))).valid).toBe(false);
    expect(summarizeIges('garbage').valid).toBe(false);
    expect(summarizeIges('').entities).toBe(0);
  });
});
