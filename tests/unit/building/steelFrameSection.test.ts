import { describe, expect, it } from 'vitest';
import { findProfile, sectionProperties, type SteelProfile } from '@aec/steel/profiles';
import { memberBuckling, sectionResistance } from '@aec/industrial/steelDesign';
import {
  columnBendingAxis,
  inPlaneInertia,
  shearReducedMoment,
  weakAxisBuckling,
  weakAxisResistance,
} from '@aec/industrial/steelFrameSection';

const profile = (name: string): SteelProfile => {
  const found = findProfile(name);
  if (!found) throw new Error(name);
  return found;
};

describe('which axis a frame plane bends', () => {
  const heb = profile('HEB240');

  it('roll 0 puts the depth along X: strong in a y = const frame, weak in x = const', () => {
    expect(columnBendingAxis(heb, 0, 'X')).toBe('strong');
    expect(columnBendingAxis(heb, 0, 'Y')).toBe('weak');
    expect(columnBendingAxis(heb, Math.PI / 2, 'Y')).toBe('strong');
    expect(columnBendingAxis(heb, Math.PI / 2, 'X')).toBe('weak');
    expect(columnBendingAxis(heb, Math.PI, 'X')).toBe('strong');
  });

  it('accepts ±5° and refuses a roll in between; square and round hollows have no preferred axis', () => {
    expect(columnBendingAxis(heb, (4 * Math.PI) / 180, 'X')).toBe('strong');
    expect(columnBendingAxis(heb, Math.PI / 4, 'X')).toBeNull();
    expect(columnBendingAxis(profile('SHS150x8'), Math.PI / 4, 'X')).toBe('strong');
    expect(columnBendingAxis(profile('CHS139.7x5'), 1, 'Y')).toBe('strong');
  });

  it('interpolates the stiffness between the principal axes', () => {
    const section = sectionProperties(heb);
    expect(inPlaneInertia(heb, 0, 'X')).toBeCloseTo(section.inertia, 3);
    expect(inPlaneInertia(heb, 0, 'Y')).toBeCloseTo(section.minorInertia, 3);
    expect(inPlaneInertia(heb, Math.PI / 4, 'X')).toBeCloseTo(
      (section.inertia + section.minorInertia) / 2,
      3,
    );
  });
});

describe('weak-axis resistance and interaction', () => {
  it('matches the catalogue plastic modulus of an HEB200 about the weak axis (Wpl,z ≈ 305.8 cm³)', () => {
    const resistance = weakAxisResistance(profile('HEB200'), 355);
    expect(resistance.moment / 355 / 1000).toBeGreaterThan(300e3 / 1000);
    expect(resistance.moment / 355).toBeLessThan(310e3);
    // Shear area 2 b tf.
    expect(resistance.shear).toBeCloseTo((2 * 200 * 15 * 355) / Math.sqrt(3), 0);
  });

  it('uses the shape factor of the major axis for a rectangular hollow section', () => {
    const rhs = profile('RHS200x100x6');
    const resistance = weakAxisResistance(rhs, 355);
    const section = sectionProperties(rhs);
    expect(resistance.moment).toBeGreaterThan((section.minorInertia / (rhs.b / 2)) * 355);
    expect(resistance.shear).toBeCloseTo((section.area / 2 / Math.sqrt(3)) * 355, 0);
  });

  it('reduces to N / (χz Npl) without moment and grows with both N and M', () => {
    const heb = profile('HEB200');
    const resistance = sectionResistance(heb, 355);
    const pure = weakAxisBuckling(heb, 355, 500e3, 0, 3000);
    const reference = memberBuckling(heb, 355, 500e3, 0, { major: 3000, minor: 3000 });
    expect(pure.utilisation).toBeCloseTo(500e3 / (reference.chiMinor * resistance.axial), 6);
    expect(pure.chi).toBeCloseTo(Math.min(reference.chiMajor, reference.chiMinor), 6);
    const bent = weakAxisBuckling(heb, 355, 500e3, 20e6, 3000);
    expect(bent.utilisation).toBeGreaterThan(pure.utilisation);
    expect(weakAxisBuckling(heb, 355, 800e3, 20e6, 3000).utilisation).toBeGreaterThan(
      bent.utilisation,
    );
    expect(weakAxisBuckling(heb, 355, -10, 20e6, 3000).utilisation).toBeGreaterThan(0);
  });

  it('covers class 3 sections and hollow sections', () => {
    const slender = profile('IPE600');
    const classThree = weakAxisBuckling(slender, 700, 300e3, 10e6, 4000);
    expect(classThree.utilisation).toBeGreaterThan(0);
    const hollow = weakAxisBuckling(profile('RHS200x100x6'), 355, 300e3, 10e6, 4000);
    expect(hollow.utilisation).toBeGreaterThan(0);
  });
});

describe('moment resistance reduced by shear (§6.2.8)', () => {
  const ipe = profile('IPE300');

  it('is the full resistance up to half the plastic shear resistance', () => {
    const vpl = sectionResistance(ipe, 355).shear / 1000;
    const low = shearReducedMoment(ipe, 355, 0.5 * vpl);
    expect(low.reduced).toBe(false);
    expect(low.moment).toBe(sectionResistance(ipe, 355).moment);
  });

  it('reduces with ρ = (2V/Vpl − 1)² and vanishes at the web at V = Vpl', () => {
    const resistance = sectionResistance(ipe, 355);
    const vpl = resistance.shear / 1000;
    const three4 = shearReducedMoment(ipe, 355, 0.75 * vpl);
    expect(three4.reduced).toBe(true);
    expect(three4.moment).toBeLessThan(resistance.moment);
    expect(three4.moment).toBeGreaterThan(0.9 * resistance.moment);
    const full = shearReducedMoment(ipe, 355, vpl);
    expect(full.moment).toBeLessThan(three4.moment);
    const flangesOnly = (profile: SteelProfile): number =>
      sectionProperties(profile).plasticModulus -
      ((profile.h - 2 * profile.tf) * profile.tw) ** 2 / (4 * profile.tw);
    expect(full.moment).toBeCloseTo(flangesOnly(ipe) * 355, 0);
  });

  it('uses (1 − ρ) Mc,Rd for hollow sections', () => {
    const shs = profile('SHS200x10');
    const resistance = sectionResistance(shs, 355);
    const vpl = resistance.shear / 1000;
    const reduced = shearReducedMoment(shs, 355, 0.75 * vpl);
    expect(reduced.moment).toBeCloseTo(resistance.moment * (1 - 0.25), 3);
  });
});
