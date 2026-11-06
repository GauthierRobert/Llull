/** Equipment nozzle load rules (07 PST §5.9, FR-PST-14): NEMA SM 23 and API 617 per connection, API 610 Annex F F.1.2 a components, user limits. */

export const LBF_TO_N = 4.4482216152605;
export const FTLBF_TO_NM = 1.3558179483314;

/** NEMA SM 23 per connection: 3 F + M <= 500 De (lbf, ft.lbf, in). */
const NEMA_LIMIT_PER_DE = 500;
const NEMA_FORCE_WEIGHT = 3;
/** API 617 allows 1.85 times the NEMA SM 23 value. */
export const API617_NEMA_FACTOR = 1.85;
/** API 610 F.1.2 a: every component within 2 x the Table 5 value (the table is imported by the caller). */
export const API610_FACTOR = 2;

export type Vec3 = readonly [number, number, number];

export interface NozzleComponentCheck {
  readonly name: string;
  readonly value: number;
  readonly limit: number;
  readonly ratio: number;
}

/** Equivalent diameter De of NEMA SM 23: the nominal size up to 8 in, (16 + D) / 3 above (S20). */
export const nemaEquivalentDiameter = (nominalIn: number): number => (nominalIn <= 8 ? nominalIn : (16 + nominalIn) / 3);

export const resultant = (vector: Vec3): number => Math.hypot(vector[0], vector[1], vector[2]);

export const scaled = (vector: Vec3, factor: number): Vec3 => [vector[0] * factor, vector[1] * factor, vector[2] * factor];

export interface NemaCheck {
  readonly De: number;
  readonly lhs: number;
  readonly limit: number;
  readonly ratio: number;
}

/** 3 F + M <= factor x 500 De with F, M the resultants (lbf, ft.lbf); factor 1.85 for API 617. */
export function nemaCheck(forceLbf: Vec3, momentFtLbf: Vec3, nominalIn: number, factor = 1): NemaCheck {
  const De = nemaEquivalentDiameter(nominalIn);
  const lhs = NEMA_FORCE_WEIGHT * resultant(forceLbf) + resultant(momentFtLbf);
  const limit = factor * NEMA_LIMIT_PER_DE * De;
  return { De, lhs, limit, ratio: lhs / limit };
}

const COMPONENTS_F = ['Fx', 'Fy', 'Fz'] as const;
const COMPONENTS_M = ['Mx', 'My', 'Mz'] as const;

/** Component checks of a load against per-component limits (`null` = no limits of that kind), each limit multiplied by `factor`. */
export function componentChecks(
  force: Vec3,
  moment: Vec3,
  forceLimits: Vec3 | null,
  momentLimits: Vec3 | null,
  factor = 1,
): NozzleComponentCheck[] {
  const rows = (names: readonly string[], values: Vec3, limits: Vec3 | null): NozzleComponentCheck[] =>
    limits === null
      ? []
      : names.map((name, i) => {
          const limit = factor * (limits[i] as number);
          return { name, value: values[i] as number, limit, ratio: Math.abs(values[i] as number) / limit };
        });
  return [...rows(COMPONENTS_F, force, forceLimits), ...rows(COMPONENTS_M, moment, momentLimits)];
}
