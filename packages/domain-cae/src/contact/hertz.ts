/** Hertz contact formulas (PHY-06 §5.2), operation for operation as validation/generate_cnt_reference.py (TR-CNT-20). Units N, mm, MPa. */

/** 1/E* = (1 - nu1^2)/E1 + (1 - nu2^2)/E2. */
export const effectiveModulus = (E1: number, nu1: number, E2: number, nu2: number): number =>
  1 / ((1 - nu1 ** 2) / E1 + (1 - nu2 ** 2) / E2);

/** 1/R = 1/R1 + 1/R2; an absent R2 is a plane (1/R2 = 0). */
export const effectiveRadius = (R1: number, R2: number | undefined): number => 1 / (1 / R1 + (R2 === undefined ? 0 : 1 / R2));

/** Line contact under P' per length: half-width b and peak pressure p0. */
export function hertzLine(loadPerLength: number, R: number, Es: number): { readonly b: number; readonly p0: number } {
  const b = Math.sqrt((4 * loadPerLength * R) / (Math.PI * Es));
  return { b, p0: (2 * loadPerLength) / (Math.PI * b) };
}

/** Point contact under force P: radius a, peak pressure p0, approach delta. */
export function hertzPointForce(P: number, R: number, Es: number): { readonly a: number; readonly p0: number; readonly approach: number } {
  const a = ((3 * P * R) / (4 * Es)) ** (1 / 3);
  return { a, p0: (3 * P) / (2 * Math.PI * a * a), approach: (a * a) / R };
}

/** Point contact under approach delta: radius a, peak pressure p0, force P. */
export function hertzPointApproach(
  delta: number,
  R: number,
  Es: number,
): { readonly a: number; readonly p0: number; readonly force: number } {
  const a = Math.sqrt(R * delta);
  const p0 = ((2 * Es) / Math.PI) * Math.sqrt(delta / R);
  return { a, p0, force: (4 / 3) * Es * Math.sqrt(R) * delta ** 1.5 };
}

/** Max shear / p0 on the axis below a sphere contact at depth z/a (Johnson 1985 eq. 3.45, not fetched). */
function sphereAxisShear(z: number, nu: number): number {
  const sz = -1 / (1 + z * z);
  const sr = -((1 + nu) * (1 - z * Math.atan(1 / z)) - 0.5 / (1 + z * z));
  return 0.5 * Math.abs(sr - sz);
}

/** Max shear / p0 on the axis below a plane-strain line contact at depth z/b. */
function lineAxisShear(z: number): number {
  const s = Math.sqrt(1 + z * z);
  const sx = -((1 + 2 * z * z) / s - 2 * z);
  const sz = -1 / s;
  return 0.5 * Math.abs(sx - sz);
}

/** Grid search (4000 cells) then 200 golden-section steps on [lo, hi]: the generator's `argmax`. */
function argmax(f: (x: number) => number, lo: number, hi: number, n = 4000): { readonly x: number; readonly value: number } {
  let best = { x: lo, value: Number.NEGATIVE_INFINITY };
  for (let i = 1; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    const value = f(x);
    if (value > best.value) best = { x, value };
  }
  let a = best.x - (hi - lo) / n;
  let b = best.x + (hi - lo) / n;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 200; k++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (f(c) > f(d)) b = d;
    else a = c;
  }
  const x = 0.5 * (a + b);
  return { x, value: f(x) };
}

/** Subsurface max shear on the axis: tauMax / p0 and its depth / (a or b), searched on z in [0.01, 3]. Unverified source (Johnson 1985). */
export function subsurfaceShear(
  contact: 'point' | 'line',
  nu: number,
): { readonly tauMaxOverP0: number; readonly depthOverHalfWidth: number } {
  const found = contact === 'point' ? argmax((z) => sphereAxisShear(z, nu), 0.01, 3) : argmax(lineAxisShear, 0.01, 3);
  return { tauMaxOverP0: found.value, depthOverHalfWidth: found.x };
}
