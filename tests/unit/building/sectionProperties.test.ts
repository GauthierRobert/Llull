import { describe, expect, it } from 'vitest';
import { findProfile, sectionProperties } from '@core/commands/building/steel/profiles';

describe('sectionProperties', () => {
  it.each([
    // name, Iy (cm⁴), Wpl,y (cm³) — catalogue values (root radii ignored here → within ~6 %)
    ['IPE300', 8356, 628.4],
    ['IPE450', 33740, 1702],
    ['HEA400', 45070, 2562],
    ['HEB300', 25170, 1869],
  ])('%s matches the catalogue within the root-radius effect', (name, iy, wpl) => {
    const props = sectionProperties(findProfile(name)!);
    expect(props.inertia / 1e4 / iy).toBeGreaterThan(0.93);
    expect(props.inertia / 1e4 / iy).toBeLessThan(1.01);
    expect(props.plasticModulus / 1e3 / wpl).toBeGreaterThan(0.93);
    expect(props.plasticModulus / 1e3 / wpl).toBeLessThan(1.01);
  });

  it.each([
    // name, Iz (cm⁴) — catalogue
    ['IPE300', 603.8],
    ['HEB300', 8563],
  ])('%s minor-axis inertia matches the catalogue', (name, iz) => {
    const props = sectionProperties(findProfile(name)!);
    expect(props.minorInertia / 1e4 / iz).toBeGreaterThan(0.95);
    expect(props.minorInertia / 1e4 / iz).toBeLessThan(1.01);
  });

  it('gives exact values for a hollow section and an asymmetric angle', () => {
    const shs = sectionProperties(findProfile('SHS100x5')!);
    const exact = (100 ** 4 - 90 ** 4) / 12;
    expect(shs.inertia).toBeCloseTo(exact, -2);
    expect(shs.elasticModulus).toBeCloseTo(exact / 50, -1);
    expect(shs.minorInertia).toBeCloseTo(exact, -2);
    expect(shs.plasticModulus).toBeCloseTo(
      ((100 * 50 * 50) / 2) * 2 - ((90 * 45 * 45) / 2) * 2,
      -1,
    );
    const angle = sectionProperties(findProfile('L100x10')!);
    expect(angle.area).toBeCloseTo(1900, -1);
    expect(angle.plasticModulus).toBeGreaterThan(angle.elasticModulus);
  });
});
