/**
 * STA-FU: `check_grating` on wedge panels. Circular platform OD 3000, gap 150, width 1000, sweep 180, default bracket step: 23 panels of pi/23 (7.826 deg), radial brackets
 * converge, so the span is 2 r sin(pi/46) = 225.2 mm at ri 1650 and 361.7 mm at ro 2650 (the bulge of the outer arc reads 2 ro tan(pi/46) = 362.6 mm).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { TYPE, gratedFrame } from './accessFixtures';

interface Panel {
  id: string;
  wedge: boolean;
  spanMm: number;
  spanMinMm: number;
  deflectionLimitMm: number;
  findings: Array<{ code: string }>;
}
const check = (doc: CadDocument, extra: Record<string, unknown> = {}): { panels: Panel[]; verdict: string } =>
  data(doc, 'check_grating', { uniformLoadKPa: 2, deflectionRatio: 100, ...extra });

function circular(): CadDocument {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 6000 });
  doc = apply(doc, 'add_equipment', {
    name: 'Column',
    mark: 'C-101',
    location: [0, 0],
    size: [3000, 3000, 18000],
    shape: 'vertical_vessel',
  });
  return apply(doc, 'add_circular_access_platform', {
    equipmentId: 'equipment-1',
    elevation: 6000,
    startAngleDeg: 0,
    sweepDeg: 180,
    gap: 150,
    width: 1000,
    gratingType: TYPE,
  });
}

describe('check_grating wedge panels', () => {
  const doc = circular();
  const answer = check(doc);

  it('judges every wedge panel on its widest span, between the chord at the outer radius and the bracket spread at the arc bulge', () => {
    expect(answer.panels).toHaveLength(23);
    const half = Math.PI / 46;
    for (const panel of answer.panels) {
      expect(panel.wedge).toBe(true);
      expect(panel.spanMm).toBeGreaterThanOrEqual(2 * 2650 * Math.sin(half) - 0.01);
      expect(panel.spanMm).toBeLessThanOrEqual(2 * 2650 * Math.tan(half) + 0.01);
      expect(panel.spanMinMm).toBeCloseTo(2 * 1650 * Math.sin(half), 0);
      expect(panel.findings).toEqual([]);
    }
  });

  it('the ratio limit follows the governing (widest) span', () => {
    const first = answer.panels[0] as Panel;
    expect(first.deflectionLimitMm).toBeCloseTo(first.spanMm / 100, 3);
  });

  it('parallel supports are not wedges: spanMinMm equals spanMm (a straight grating)', () => {
    const straight = check(gratedFrame().doc);
    expect(straight.panels.length).toBeGreaterThan(0);
    for (const panel of straight.panels) {
      expect(panel.wedge).toBe(false);
      expect(panel.spanMinMm).toBeCloseTo(panel.spanMm, 6);
    }
  });

  it('is read-only and pure', () => {
    expectPure(doc, () => execute(doc, 'check_grating', { uniformLoadKPa: 2, deflectionRatio: 100 }));
  });
});
