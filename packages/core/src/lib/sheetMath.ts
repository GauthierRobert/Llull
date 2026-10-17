/**
 * Pure sheet-metal bend mathematics (aerospace 07 FTR §5.1, §5.4). Every value is returned with the id of the formula that produced it
 * (TR-FTR-09), so a number cannot reach a result without its provenance. Angles in radians, lengths in any one consistent unit.
 * @layer lib
 */

import { clamp } from './clamp';

/** A computed value and the formula that produced it. */
export interface Formulaed {
  readonly value: number;
  readonly formula: string;
}

export const FORMULAS = {
  ba: 'theta*(R+K*T)',
  baFaa: '(0.01743*R+0.0078*T)*theta_deg',
  ossb: 'tan(theta/2)*(R+T)',
  issb: 'tan(theta/2)*R',
  bd: '2*ossb-ba',
  kChart: 'tan(theta/2)',
  rOverT: 'R/T',
  kDinToAnsi: 'K_ansi=K_din/2',
  kTable: 'linear interpolation in r/T, clamped at both ends',
  joggleStraight: 's=(h-2*rm*(1-cos(phi)))/sin(phi), rm=R+T/2',
  joggleRun: 'run=2*rm*sin(phi)+s*cos(phi)',
  joggleDeveloped: 'Ldev=2*BA(phi)+s',
  joggleAllowance: 'dL=Ldev-run',
  hemAllowance: 'BA_hem=pi*(gap/2+K*T)',
  hemDeveloped: 'Ldev_hem=BA_hem+leg',
} as const;

/** FAA empirical K-equivalent: 0.0078 / 0.01743. */
export const FAA_K_EQUIVALENT = 0.0078 / 0.01743;

const withFormula = (value: number, formula: string): Formulaed => ({ value, formula });

/** K_ansi of a DIN K-factor (FreeCAD convention K_din = 2 * K_ansi). */
export const dinToAnsiK = (kDin: number): Formulaed => withFormula(kDin / 2, FORMULAS.kDinToAnsi);

export interface BendQuantities {
  readonly ba: Formulaed;
  readonly ossb: Formulaed;
  readonly issb: Formulaed;
  readonly bd: Formulaed;
  readonly kChart: Formulaed;
  readonly rOverT: Formulaed;
}

/** Bend allowance, setbacks, bend deduction and K-chart value of one bend (K-factor model, ANSI K). */
export function bendQuantities(input: {
  readonly theta: number;
  readonly insideRadius: number;
  readonly thickness: number;
  readonly k: number;
}): BendQuantities {
  const { theta, insideRadius: r, thickness: t, k } = input;
  const kChart = Math.tan(theta / 2);
  const ba = theta * (r + k * t);
  const ossb = kChart * (r + t);
  return {
    ba: withFormula(ba, FORMULAS.ba),
    ossb: withFormula(ossb, FORMULAS.ossb),
    issb: withFormula(kChart * r, FORMULAS.issb),
    bd: withFormula(2 * ossb - ba, FORMULAS.bd),
    kChart: withFormula(kChart, FORMULAS.kChart),
    rOverT: withFormula(r / t, FORMULAS.rOverT),
  };
}

/** FAA empirical bend allowance BA = (0.01743 R + 0.0078 T) * theta_deg, with its setbacks (K-equivalent `FAA_K_EQUIVALENT`). */
export function faaBendQuantities(input: {
  readonly theta: number;
  readonly insideRadius: number;
  readonly thickness: number;
}): BendQuantities {
  const base = bendQuantities({ ...input, k: FAA_K_EQUIVALENT });
  const thetaDeg = (input.theta * 180) / Math.PI;
  const ba = (0.01743 * input.insideRadius + 0.0078 * input.thickness) * thetaDeg;
  return { ...base, ba: withFormula(ba, FORMULAS.baFaa), bd: withFormula(2 * base.ossb.value - ba, FORMULAS.bd) };
}

export interface KTableRow {
  readonly rOverT: number;
  readonly k: number;
}

/**
 * K at `rOverT` by linear interpolation of a table (any row order), clamped to the first and last row.
 * @failure empty table -> NaN
 */
export function kFromTable(table: ReadonlyArray<KTableRow>, rOverT: number): Formulaed {
  const rows = [...table].sort((a, b) => a.rOverT - b.rOverT);
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return withFormula(NaN, FORMULAS.kTable);
  if (rOverT <= first.rOverT) return withFormula(first.k, FORMULAS.kTable);
  if (rOverT >= last.rOverT) return withFormula(last.k, FORMULAS.kTable);
  const upper = rows.findIndex((row) => row.rOverT >= rOverT);
  const high = rows[upper] as KTableRow;
  const low = rows[upper - 1] as KTableRow;
  const span = high.rOverT - low.rOverT;
  const k = span === 0 ? high.k : low.k + ((high.k - low.k) * (rOverT - low.rOverT)) / span;
  return withFormula(k, FORMULAS.kTable);
}

export interface JoggleQuantities {
  readonly inclinedStraight: Formulaed;
  readonly run: Formulaed;
  readonly developed: Formulaed;
  readonly allowance: Formulaed;
  /** Bend allowance of ONE joggle bend of angle phi. */
  readonly bendAllowance: Formulaed;
}

/**
 * Two reverse bends of angle `phi` and inside radius R offsetting a flat by `offset` (§5.4).
 * @failure phi outside (0, pi/2], non-positive thickness, or inclined straight s < 0 (offset too small, JG-04) -> null
 */
export function joggleQuantities(input: {
  readonly thickness: number;
  readonly insideRadius: number;
  readonly k: number;
  readonly phi: number;
  readonly offset: number;
}): JoggleQuantities | null {
  const { thickness: t, insideRadius: r, k, phi, offset } = input;
  if (!(phi > 0 && phi <= Math.PI / 2) || !(t > 0) || !(offset > 0)) return null;
  const rm = r + t / 2;
  const s = (offset - 2 * rm * (1 - Math.cos(clamp(phi, 0, Math.PI)))) / Math.sin(phi);
  if (s < -1e-12) return null;
  const straight = Math.max(0, s);
  const ba = phi * (r + k * t);
  const run = 2 * rm * Math.sin(phi) + straight * Math.cos(phi);
  const developed = 2 * ba + straight;
  return {
    inclinedStraight: withFormula(straight, FORMULAS.joggleStraight),
    run: withFormula(run, FORMULAS.joggleRun),
    developed: withFormula(developed, FORMULAS.joggleDeveloped),
    allowance: withFormula(developed - run, FORMULAS.joggleAllowance),
    bendAllowance: withFormula(ba, FORMULAS.ba),
  };
}

/** Smallest joggle offset valid for the angle and radius: 2*(R+T/2)*(1-cos(phi)). */
export function minJoggleOffset(thickness: number, insideRadius: number, phi: number): number {
  return 2 * (insideRadius + thickness / 2) * (1 - Math.cos(phi));
}

export interface HemQuantities {
  readonly bendAllowance: Formulaed;
  readonly developed: Formulaed;
}

/**
 * 180 degree hem: neutral-surface bend allowance pi*(R + K*T) with R = gap/2 (0 for a closed hem) plus the straight return leg. The setback
 * (tan(theta/2)) is undefined at 180 degrees, so a hem has no OSSB/BD of its own.
 * UNVERIFIED: the neutral-surface model extended to 180 degrees; no published hem allowance table was checked.
 * @failure non-positive thickness, negative gap or leg -> null
 */
export function hemQuantities(input: {
  readonly thickness: number;
  readonly gap: number;
  readonly k: number;
  readonly leg: number;
}): HemQuantities | null {
  const { thickness: t, gap, k, leg } = input;
  if (!(t > 0) || !(gap >= 0) || !(leg >= 0)) return null;
  const ba = Math.PI * (gap / 2 + k * t);
  return { bendAllowance: withFormula(ba, FORMULAS.hemAllowance), developed: withFormula(ba + leg, FORMULAS.hemDeveloped) };
}
