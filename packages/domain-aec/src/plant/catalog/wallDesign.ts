/**
 * Pressure design thickness of straight pipe under internal pressure (TR-PSC-08, spec 5.7): ASME B31.3 para. 304.1.2 eq. (3a),
 * t = P D / (2 (S E W + P Y)), then tm = t + c and the required nominal wall tm / (1 - mill tolerance). Pure; every input is explicit (AF-31)
 * and each is gated to the range in which the formula is defined: outside it the result is a coded refusal, never a number.
 * @invariant valid only for t < D/6 and P / (S E) <= 0.385 (B31.3 304.1.2(a)); E, W in (0, 1]; Y in [0, 0.7] (Table 304.1.1); mill tolerance in [0, 0.5)
 */

/** Largest coefficient Y of B31.3 Table 304.1.1 (ferritic steel at or above 621 degC). */
export const MAX_COEFFICIENT_Y = 0.7;
/** Eq. (3a) is not valid for P / (S E) above this (B31.3 304.1.2(a): thick-wall pipe needs special consideration). */
export const MAX_PRESSURE_STRESS_RATIO = 0.385;
/** Eq. (3a) is valid for t below D / this. */
export const THIN_WALL_DIVISOR = 6;
/** Largest mill under-tolerance accepted (fraction of the nominal wall): 12.5 % is seamless pipe, 0.5 is a gross-error gate. */
export const MAX_MILL_TOLERANCE = 0.5;

export interface WallInputs {
  readonly outsideDiameterMm: number;
  /** Internal design gauge pressure and allowable stress, in the same unit (MPa here). */
  readonly pressureMPa: number;
  readonly allowableStressMPa: number;
  readonly jointFactorE: number;
  readonly weldStrengthW: number;
  readonly coefficientY: number;
  readonly corrosionAllowanceMm: number;
  /** Fraction of the nominal wall the mill may under-deliver (0.125 = 12.5 %). */
  readonly millTolerance: number;
}

export interface WallDesign {
  readonly pressureThicknessMm: number;
  readonly minimumThicknessMm: number;
  readonly requiredNominalMm: number;
  readonly thinWallLimitMm: number;
  readonly pressureStressRatio: number;
}

export type WallOutcome =
  | { readonly ok: true; readonly design: WallDesign }
  | { readonly ok: false; readonly code: 'PSC_WALL_INPUT_RANGE' | 'PSC_WALL_THICK_PIPE'; readonly message: string; readonly path: string };

const bad = (path: string, message: string): WallOutcome => ({ ok: false, code: 'PSC_WALL_INPUT_RANGE', message, path });

/** Eq. (3a) for `inputs`, or the coded reason it does not apply. */
export function pressureDesignWall(inputs: WallInputs): WallOutcome {
  const finite: ReadonlyArray<readonly [keyof WallInputs, number]> = (Object.keys(inputs) as Array<keyof WallInputs>).map((key) => [
    key,
    inputs[key],
  ]);
  const broken = finite.find(([, value]) => !Number.isFinite(value));
  if (broken !== undefined) return bad(broken[0], `${broken[0]} must be a finite number`);
  if (!(inputs.outsideDiameterMm > 0)) return bad('outsideDiameterMm', 'the outside diameter must be > 0 mm');
  if (!(inputs.pressureMPa > 0))
    return bad('pressure', 'the internal design pressure must be > 0 (gauge); external pressure is not covered');
  if (!(inputs.allowableStressMPa > 0)) return bad('allowableStress', 'the allowable stress S must be > 0');
  if (!(inputs.jointFactorE > 0 && inputs.jointFactorE <= 1)) return bad('jointFactorE', 'the quality factor E must be in (0, 1]');
  if (!(inputs.weldStrengthW > 0 && inputs.weldStrengthW <= 1))
    return bad('weldStrengthW', 'the weld strength reduction factor W must be in (0, 1]');
  if (!(inputs.coefficientY >= 0 && inputs.coefficientY <= MAX_COEFFICIENT_Y))
    return bad('coefficientY', `the coefficient Y must be in [0, ${MAX_COEFFICIENT_Y}] (B31.3 Table 304.1.1)`);
  if (!(inputs.corrosionAllowanceMm >= 0)) return bad('corrosionAllowance', 'the corrosion allowance c must be >= 0');
  if (!(inputs.millTolerance >= 0 && inputs.millTolerance < MAX_MILL_TOLERANCE))
    return bad('millTolerance', `the mill tolerance is a fraction in [0, ${MAX_MILL_TOLERANCE}) (0.125 for seamless pipe)`);
  const ratio = inputs.pressureMPa / (inputs.allowableStressMPa * inputs.jointFactorE);
  const thinWallLimitMm = inputs.outsideDiameterMm / THIN_WALL_DIVISOR;
  if (ratio > MAX_PRESSURE_STRESS_RATIO)
    return {
      ok: false,
      code: 'PSC_WALL_THICK_PIPE',
      path: 'pressure',
      message: `P / (S E) = ${ratio.toFixed(4)} exceeds ${MAX_PRESSURE_STRESS_RATIO}: eq. (3a) is not valid (thick-wall pipe)`,
    };
  const t =
    (inputs.pressureMPa * inputs.outsideDiameterMm) /
    (2 * (inputs.allowableStressMPa * inputs.jointFactorE * inputs.weldStrengthW + inputs.pressureMPa * inputs.coefficientY));
  if (!(t < thinWallLimitMm))
    return {
      ok: false,
      code: 'PSC_WALL_THICK_PIPE',
      path: 'pressure',
      message: `t = ${t.toFixed(4)} mm is not below D/6 = ${thinWallLimitMm.toFixed(4)} mm: eq. (3a) is not valid (thick-wall pipe)`,
    };
  const minimumThicknessMm = t + inputs.corrosionAllowanceMm;
  return {
    ok: true,
    design: {
      pressureThicknessMm: t,
      minimumThicknessMm,
      requiredNominalMm: minimumThicknessMm / (1 - inputs.millTolerance),
      thinWallLimitMm,
      pressureStressRatio: ratio,
    },
  };
}
