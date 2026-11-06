/**
 * STA-FU: `check_grating` on wedge panels. Circular platform OD 3000, gap 150, width 1000, sweep 180, default bracket step: 23 panels of pi/23 (7.826 deg), radial brackets
 * converge, so the span is 2 r sin(pi/46) = 225.2 mm at ri 1650 and 361.7 mm at ro 2650 (the bulge of the outer arc reads 2 ro tan(pi/46) = 362.6 mm).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { spanRange, type SupportGroup, type SupportLine } from '@aec/plant/structures/grating/gratingSupports';
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

  it('a load that passes on the midspan chord fails on the widest span: STA_GRATING_OVERSTRESS', () => {
    const base = answer.panels[0] as Panel & { allowableUniformKPa: number; selfWeightKPa: number };
    const load = 1.2 * base.allowableUniformKPa - base.selfWeightKPa;
    const mid = 2 * 2075 * Math.sin(Math.PI / 46);
    // On the midspan chord (283.2 mm) the allowable is (span / mid)^2 times larger: the same load is under the limit there.
    expect((load + base.selfWeightKPa) / (base.allowableUniformKPa * (base.spanMm / mid) ** 2)).toBeLessThan(1);
    const failed = check(doc, { uniformLoadKPa: load });
    expect(failed.panels[0]?.findings.map((finding) => finding.code)).toContain('STA_GRATING_OVERSTRESS');
    expect(failed.verdict).toBe('fail');
  });

  it('is read-only and pure', () => {
    expectPure(doc, () => execute(doc, 'check_grating', { uniformLoadKPa: 2, deflectionRatio: 100 }));
  });
});

describe('spanRange', () => {
  const line = (id: string, sMm: number, pMin: number, pMax: number, slope: number): SupportLine => ({
    id,
    sMm,
    pMin,
    pMax,
    halfWidthMm: 0,
    topMm: 0,
    parallelism: 0,
    slope,
  });
  const group = (members: SupportLine[]): SupportGroup => ({
    sMm: members.reduce((sum, member) => sum + member.sMm, 0) / members.length,
    halfWidthMm: 0,
    members,
  });

  it('converging supports: the span at each side edge, the widest governs', () => {
    const a = group([line('a', -100, 0, 1000, -0.1)]);
    const b = group([line('b', 100, 0, 1000, 0.1)]);
    // 200 + 0.2 (p - 500): 100 at p = 0, 300 at p = 1000
    expect(spanRange(a, b, 0, 1000)).toEqual({ minMm: 100, maxMm: 300 });
  });

  it('a support line that does not cover the middle: the member nearest to it carries the side', () => {
    const a = group([line('a1', -100, 0, 100, -0.1), line('a2', -100, 300, 500, -0.1)]);
    const b = group([line('b', 100, 0, 1000, 0.1)]);
    // mid 250 is under neither a1 (0..100) nor a2 (300..500); a2 is nearer: s = -60 at p = 0, -110 at p = 500; b: 50 and 100
    const range = spanRange(a, b, 0, 500);
    expect(range.minMm).toBeCloseTo(110, 9);
    expect(range.maxMm).toBeCloseTo(210, 9);
  });

  it('parallel supports: both values are the centre distance', () => {
    expect(spanRange(group([line('a', 0, 0, 10, 0)]), group([line('b', 400, 0, 10, 0)]), 0, 10)).toEqual({ minMm: 400, maxMm: 400 });
  });
});
