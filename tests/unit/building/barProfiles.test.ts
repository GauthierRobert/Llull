/**
 * Flat bars (FL<width>x<thickness>) and solid round bars (RD<diameter>) of the steel catalogue (06 STA M2: ladder stiles, rungs, toe plates).
 * Hand numbers: FL100x10 has A = 1000 mm2, 7.85 kg/m, I = b h^3 / 12 = 10 * 100^3 / 12 = 833 333 mm4; RD20 has A = pi * 100 = 314.16 mm2,
 * 2.466 kg/m, I = pi d^4 / 64 = 7853.98 mm4, paint perimeter pi d.
 */

import { describe, expect, it } from 'vitest';
import { findProfile, profileOutline, sectionProperties } from '@aec/steel/profiles';
import { data } from '../../helpers/commandAssertions';
import { createEmptyDocument } from '@core/model/types';

describe('FL and RD steel profiles', () => {
  it('finds them case- and space-insensitively with their catalogue values', () => {
    const flat = findProfile('fl 100x10')!;
    expect(flat).toMatchObject({ name: 'FL100x10', family: 'FL', shape: 'FL', h: 100, b: 10, area: 1000, perimeter: 220 });
    expect(flat.massPerMetre).toBeCloseTo(7.85, 6);
    const round = findProfile('rd20')!;
    expect(round).toMatchObject({ name: 'RD20', family: 'RD', shape: 'RD', h: 20, b: 20 });
    expect(round.area).toBeCloseTo(314.159, 3);
    expect(round.massPerMetre).toBeCloseTo(2.47, 2);
    expect(round.perimeter).toBeCloseTo(62.832, 3);
    expect(findProfile('FL100x11')).toBeUndefined();
  });

  it('draws a full rectangle and a full disc, and gives exact section properties', () => {
    const flat = profileOutline(findProfile('FL100x10')!);
    expect(flat.holes).toEqual([]);
    expect(flat.outer).toEqual([
      [-5, -50],
      [5, -50],
      [5, 50],
      [-5, 50],
    ]);
    expect(profileOutline(findProfile('RD20')!).holes).toEqual([]);
    expect(sectionProperties(findProfile('FL100x10')!).inertia).toBeCloseTo(833333.33, 1);
    expect(sectionProperties(findProfile('FL100x10')!).elasticModulus).toBeCloseTo(16666.67, 1);
    // The disc is a 20-gon: its second moment is within 4% below pi d^4 / 64.
    const disc = sectionProperties(findProfile('RD20')!).inertia;
    expect(disc).toBeLessThan(7853.98);
    expect(disc).toBeGreaterThan(7853.98 * 0.96);
  });

  it('appears in list_steel_profiles', () => {
    const flats = data<{ profiles: Array<{ name: string }> }>(createEmptyDocument(), 'list_steel_profiles', { family: 'FL' }).profiles;
    expect(flats.map((profile) => profile.name)).toContain('FL70x10');
    const rounds = data<{ profiles: Array<{ name: string }> }>(createEmptyDocument(), 'list_steel_profiles', { family: 'rd' }).profiles;
    expect(rounds.map((profile) => profile.name)).toEqual(['RD10', 'RD12', 'RD16', 'RD20', 'RD25', 'RD30', 'RD40']);
  });
});
