import { describe, expect, it } from 'vitest';
import { featurePoints, partFocus } from '@ui/panels/manufacturing/mfgFocus';
import { bracket } from '../unit/aero/sheetmetal/helpers';

describe('manufacturing findings beacon the feature they name', () => {
  it('a bend id marks the middle of its bend line, a flat id its centroid', () => {
    const { doc, part } = bracket();
    const [bend] = featurePoints(doc, part, ['b1']);
    expect(bend?.[0]).toBeCloseTo(33.6);
    expect(bend?.[1]).toBeCloseTo(25);
    expect(bend?.[2]).toBeCloseTo(0);
    const [base] = featurePoints(doc, part, ['f1']);
    expect(base?.[0]).toBeCloseTo(16.8);
    expect(base?.[1]).toBeCloseTo(25);
  });

  it('a part-level finding (no feature ids) falls back to the part centre', () => {
    const { doc, part } = bracket();
    expect(featurePoints(doc, part, [part, 'rule'])).toEqual([]);
    const focus = partFocus(doc, part, 'finding:X:0', 'X', '#ffb300', ['b1']);
    expect(focus.markers).toHaveLength(1);
    expect(focus.markers[0]?.position[0]).toBeCloseTo(33.6);
    expect(partFocus(doc, part, 'part', 'part').markers).toHaveLength(1);
  });
});
