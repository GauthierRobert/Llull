/**
 * Atomic-oxygen erosion (PHY-14 §5.4): recession d = Ey F and mass loss dm = rho A Ey F, with the erosion yield Ey = eroded volume per incident atom.
 * Reference value: Kapton H Ey = 3.0e-24 cm^3/atom (first measured on STS-8 / EOIM-1; JAXA repository AA1830019009, SPENVIS erosion background);
 * the yield depends on exposure conditions, so it is a reference, not a design value for any orbit.
 */

export interface ErosionReference {
  readonly id: string;
  readonly label: string;
  /** cm^3 / atom. */
  readonly erosionYieldCm3PerAtom: number;
  readonly source: string;
  readonly caveat: string;
}

export const EROSION_REFERENCES: Readonly<Record<string, ErosionReference>> = {
  kapton_h: {
    id: 'kapton_h',
    label: 'Kapton H polyimide (flight-experiment fluence reference)',
    erosionYieldCm3PerAtom: 3.0e-24,
    source:
      'Kapton H erosion yield 3.0e-24 cm^3/atom, first measured on STS-8 (EOIM-1, 1982): JAXA repository AA1830019009; ECSS erosion background: SPENVIS help (atmosphere/erosion)',
    caveat: 'the yield depends on exposure conditions (orbit, energy); ground-facility and ISS-orbit values differ',
  },
};

/** Recession depth in cm for yield (cm^3/atom) and fluence (atoms/cm^2). */
export const recessionCm = (yieldCm3PerAtom: number, fluencePerCm2: number): number => yieldCm3PerAtom * fluencePerCm2;

/** Mass loss in g for density (g/cm^3), exposed area (cm^2), yield (cm^3/atom) and fluence (atoms/cm^2). */
export const massLossG = (densityGPerCm3: number, areaCm2: number, yieldCm3PerAtom: number, fluencePerCm2: number): number =>
  densityGPerCm3 * areaCm2 * yieldCm3PerAtom * fluencePerCm2;
