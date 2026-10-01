import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CheckRow } from '@core/commands/building/industrial/frameCheck';
import {
  bucklingReduction,
  memberBuckling,
  sectionResistance,
} from '@core/commands/building/industrial/steelDesign';
import { craneActions, craneCapacityOf } from '@core/commands/building/industrial/frameModel';
import { findProfile } from '@core/commands/building/steel/profiles';
import type { SteelMemberElement } from '@core/model/building';
import { __resetIdCounter } from '@lib/id';

const HALL = { span: 24000, length: 30000 };

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', { ...HALL, ...params })
    .document;
}

interface CheckData {
  rows: CheckRow[];
  combinations: string[];
  alphaCritical: number | null;
  maxUtilisation: number;
}

function check(doc: CadDocument, params: Record<string, unknown> = {}): CheckData {
  return execute(doc, 'check_portal_frames', params).data as CheckData;
}

const row = (data: CheckData, mark: string, kind: CheckRow['kind']): CheckRow =>
  data.rows.find((candidate) => candidate.mark === mark && candidate.kind === kind)!;

beforeEach(() => __resetIdCounter());

describe('member buckling (EN 1993-1-1 §6.3)', () => {
  it('matches the buckling curves', () => {
    expect(bucklingReduction(0.1, 0.34)).toBe(1);
    expect(bucklingReduction(1, 0.21)).toBeCloseTo(0.666, 3);
    expect(bucklingReduction(1, 0.34)).toBeCloseTo(0.597, 3);
    expect(bucklingReduction(1, 0.49)).toBeCloseTo(0.54, 3);
    expect(bucklingReduction(2, 0.49)).toBeCloseTo(0.196, 3);
  });

  it('reduces the axial resistance of slender columns and interacts with bending', () => {
    const profile = findProfile('HEA240')!;
    const npl = sectionResistance(profile, 355).axial;
    const stocky = memberBuckling(profile, 355, 0.5 * npl, 0, { major: 1000, minor: 1000 });
    const slender = memberBuckling(profile, 355, 0.5 * npl, 0, { major: 8000, minor: 8000 });
    expect(stocky.utilisation).toBeCloseTo(0.5 / stocky.chiMinor, 6);
    expect(slender.chiMinor).toBeLessThan(slender.chiMajor);
    expect(slender.utilisation).toBeGreaterThan(1);
    const bending = memberBuckling(profile, 355, 0, 1e8, { major: 8000, minor: 8000 });
    expect(bending.utilisation).toBeCloseTo((0.9 * 1e8) / sectionResistance(profile, 355).moment);
    // Hollow and other shapes use their own curves.
    expect(
      memberBuckling(findProfile('SHS100x5')!, 355, 1e5, 0, { major: 3000, minor: 3000 }).chiMajor,
    ).toBeLessThan(1);
    expect(
      memberBuckling(findProfile('L100x10')!, 355, 1e5, 0, { major: 3000, minor: 3000 }).chiMinor,
    ).toBeLessThan(1);
    expect(
      memberBuckling(findProfile('IPE300')!, 355, 1e5, 0, { major: 3000, minor: 3000 }).chiMajor,
    ).toBeGreaterThan(0.9);
  });
});

describe('load combinations', () => {
  it('checks snow-only halls with gravity combinations, stability and SLS deflection', () => {
    const data = check(hall());
    expect(data.combinations).toEqual(['1.35G+1.5S (→)', '1.35G+1.5S (←)']);
    expect(data.alphaCritical).toBeGreaterThan(10);
    const deflection = row(data, 'RF5', 'deflection');
    expect(deflection.combination).toBe('SLS S');
    expect(deflection.check).toMatch(/vertical \d+ mm ≤ span\/200 = 120 mm/);
    expect(deflection.utilisation).toBeGreaterThan(0.3);
    expect(deflection.utilisation).toBeLessThan(1);
    expect(data.rows.some((candidate) => candidate.kind === 'stability')).toBe(true);
  });

  it('adds wind (both directions, uplift) with eaves sway checks', () => {
    const doc = hall();
    const calm = check(doc, { snowLoad: 0 });
    const windy = check(doc, { snowLoad: 0, windPressure: 1.0 });
    expect(windy.combinations).toHaveLength(6);
    expect(windy.combinations).toContain('1.0G+1.5W→');
    expect(row(windy, 'SC5', 'column').utilisation).toBeGreaterThan(
      row(calm, 'SC5', 'column').utilisation,
    );
    const sway = windy.rows.find((candidate) => candidate.check.startsWith('eaves sway'))!;
    expect(sway.combination).toMatch(/^SLS W/);
    expect(sway.utilisation).toBeGreaterThan(0);
    // Uplift reverses the apex moment: the bolt group sees both signs.
    const apex = windy.rows.find(
      (candidate) => candidate.kind === 'connection' && candidate.check.startsWith('apex'),
    )!;
    const moments = apex.forces!.map((force) => force.moment);
    expect(Math.max(...moments)).toBeGreaterThan(0);
    expect(Math.min(...moments)).toBeLessThan(0);
    expect(execute(doc, 'check_portal_frames', { windPressure: 1 }).summary).toMatch(
      /qp = 1 kN\/m²/,
    );
  });

  it('applies crane actions from the runway at the brackets', () => {
    const doc = hall({ crane: { capacity: 16, railHeight: 6000 } });
    const withCrane = check(doc);
    const without = check(doc, { craneCapacity: 0 });
    expect(withCrane.combinations).toHaveLength(4);
    expect(withCrane.combinations[2]).toBe('1.35G+1.35C(left)+0.75S');
    expect(without.combinations).toHaveLength(2);
    const rail = withCrane.rows.find((candidate) => candidate.check.startsWith('rail-level'))!;
    expect(rail.check).toMatch(/h\/400/);
    // A heavy crane governs the columns.
    const heavier = check(doc, { craneCapacity: 50 });
    expect(row(heavier, 'SC5', 'column').utilisation).toBeGreaterThan(
      row(without, 'SC5', 'column').utilisation,
    );
    expect(row(heavier, 'SC5', 'column').combination).toMatch(/^1\.35G\+1\.35C/);
    expect(rail.utilisation).toBeLessThan(
      heavier.rows.find((candidate) => candidate.check.startsWith('rail-level'))!.utilisation,
    );
    const both = check(doc, { windPressure: 0.8 });
    expect(both.combinations).toContain('1.35G+1.35C(right)+0.75S+0.9W←');
  });

  it('reads crane capacities and actions', () => {
    const member = { note: 'Crane 12.5 t, rail top 6000' } as SteelMemberElement;
    expect(craneCapacityOf(member)).toBe(12.5);
    expect(craneCapacityOf({ note: 'crane bracket' } as SteelMemberElement)).toBeNull();
    expect(craneCapacityOf({} as SteelMemberElement)).toBeNull();
    const actions = craneActions(10);
    expect(actions.max).toBeGreaterThan(actions.min);
    expect(actions.max / 1000).toBeCloseTo(1.15 * 0.9 * 98.1 + 1.1 * 0.5 * (49.05 + 20), 1);
    expect(actions.lateral / 1000).toBeCloseTo((0.1 * (98.1 + 0.2 * 69.05)) / 2, 2);
  });

  it('flags sway-sensitive frames (αcr < 3) and amplifies their moments', () => {
    const data = check(hall({ rafterProfile: 'IPE300', columnProfile: 'HEA240' }));
    expect(data.alphaCritical).toBeLessThan(3);
    const stability = data.rows.filter((candidate) => candidate.kind === 'stability');
    expect(Math.max(...stability.map((candidate) => candidate.utilisation))).toBeGreaterThan(1);
    expect(row(data, 'RF5', 'rafter').check).toMatch(/sway ×\d\.\d\d/);
  });

  it('rejects negative wind or crane input', () => {
    const doc = hall();
    expect(execute(doc, 'check_portal_frames', { windPressure: -1 }).summary).toMatch(
      /must be >= 0/,
    );
    expect(execute(doc, 'design_portal_frames', { craneCapacity: -2 }).summary).toMatch(
      /must be >= 0/,
    );
  });
});

describe('design_portal_frames with wind and crane', () => {
  it('designs a crane hall under wind so every check passes', () => {
    const doc = hall({ crane: { capacity: 10, railHeight: 6000 } });
    const result = execute(doc, 'design_portal_frames', { windPressure: 0.7 });
    expect(result.summary).toMatch(/Designed 6 frame\(s\) for 8 ULS combination\(s\)/);
    const after = check(result.document, { windPressure: 0.7 });
    expect(after.maxUtilisation).toBeLessThanOrEqual(1);
  });
});
