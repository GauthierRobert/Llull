/** Single-phase incompressible pipe flow: water properties, Colebrook-White friction, bend loss coefficients, material roughness. */

/** Water density (kg/m³) at `celsius` (Kell 1975, 0..100 °C, atmospheric pressure). */
export function waterDensity(celsius: number): number {
  const t = celsius;
  const numerator =
    999.83952 + 16.945176 * t - 7.9870401e-3 * t ** 2 - 46.170461e-6 * t ** 3 + 105.56302e-9 * t ** 4 - 280.54253e-12 * t ** 5;
  return numerator / (1 + 16.87985e-3 * t);
}

/** Water dynamic viscosity (Pa·s) at `celsius` (Vogel / Reid-Prausnitz-Poling fit, 0..100 °C): 2.414e-5 · 10^(247.8 / (T[K] − 140)). */
export function waterViscosity(celsius: number): number {
  return 2.414e-5 * 10 ** (247.8 / (celsius + 273.15 - 140));
}

/** Absolute roughness (mm) by pipe material text (Moody / Crane TP-410 typical values); carbon steel 0.045 for unrecognised materials. */
export function pipeRoughnessMm(material: string): { readonly mm: number; readonly basis: string } {
  const text = material.toLowerCase();
  const rows: ReadonlyArray<readonly [RegExp, number, string]> = [
    [/galvani[sz]ed/, 0.15, 'galvanised steel'],
    [/stainless|inox|316|304/, 0.015, 'stainless steel'],
    [/copper|brass/, 0.0015, 'copper / drawn tubing'],
    [/pvc|cpvc|pe\b|hdpe|pp\b|plastic|pex|frp|grp/, 0.0015, 'plastic'],
    [/ductile/, 0.12, 'ductile iron'],
    [/cast\s*iron|\bci\b/, 0.26, 'cast iron'],
    [/concrete/, 0.3, 'concrete'],
  ];
  const row = rows.find(([pattern]) => pattern.test(text));
  return row ? { mm: row[1], basis: row[2] } : { mm: 0.045, basis: 'commercial / carbon steel' };
}

export type BendType = 'long_radius' | 'standard' | 'mitre';

/** Loss coefficient K of a 90° bend by type (velocity-head basis, fully turbulent; Crane TP-410: 14, 20 and 60 fT at fT ≈ 0.015-0.02). */
export const K_90_DEGREES: Readonly<Record<BendType, number>> = { long_radius: 0.3, standard: 0.4, mitre: 1.1 };

/** K of a bend of `deflectionDegrees`: K90 · sin(θ/2) / sin 45° (45° elbow = 0.54 × K90, matching Crane's 16 fT / 30 fT ≈ 0.53). */
export function bendK(type: BendType, deflectionDegrees: number): number {
  return (K_90_DEGREES[type] * Math.sin((deflectionDegrees * Math.PI) / 360)) / Math.sin(Math.PI / 4);
}

/** Darcy friction factor: laminar 64/Re below Re 2300, else Colebrook-White solved by fixed-point iteration (Swamee-Jain start). */
export function frictionFactor(reynolds: number, relativeRoughness: number): { readonly f: number; readonly iterations: number } {
  if (reynolds < 2300) return { f: 64 / reynolds, iterations: 0 };
  let inverseRoot = -2 * Math.log10(relativeRoughness / 3.7 + 5.74 / reynolds ** 0.9);
  let iterations = 0;
  for (; iterations < 100; iterations++) {
    const next = -2 * Math.log10(relativeRoughness / 3.7 + 2.51 * (inverseRoot / reynolds));
    const converged = Math.abs(next - inverseRoot) < 1e-12;
    inverseRoot = next;
    if (converged) break;
  }
  return { f: 1 / inverseRoot ** 2, iterations };
}
