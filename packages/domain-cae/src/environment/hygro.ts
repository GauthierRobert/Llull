/** Hygroscopic strain eps = beta dM and the equivalent-temperature analogy alpha dT_eq = beta dM (PHY-14 §5.3). Pure. */

/** Relative tolerance under which two beta/alpha ratios count as equal (TR-ENV-07). */
const PROPORTIONAL_TOLERANCE = 1e-9;

/** Equivalent temperature change per direction, or null when some alpha is zero. */
export function equivalentTemperatures(strains: readonly number[], alphas: readonly number[]): number[] | null {
  if (alphas.some((alpha) => alpha === 0)) return null;
  if (alphas.length !== strains.length) return null;
  return strains.map((strain, index) => strain / Number(alphas[index]));
}

/** True when every direction needs the same temperature change (one equivalent temperature reproduces the strain field). */
export function proportional(values: readonly number[]): boolean {
  const first = values[0];
  if (first === undefined) return false;
  const scale = Math.max(...values.map(Math.abs));
  return values.every((value) => Math.abs(value - first) <= PROPORTIONAL_TOLERANCE * scale);
}
