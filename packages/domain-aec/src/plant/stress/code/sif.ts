/**
 * Stress intensification and flexibility factors of the code appendix D formulas (07 PST §5.7). B31.1 has one SIF for both planes: it is
 * returned as ii = io. Every component has one rule row (grade named in the result); components with no row in a read source are refused.
 */

import type { RuleGrade, RuleSet } from './ruleSets';
import { pow } from '@lib/pow';

export const SIF_COMPONENTS = [
  'elbow',
  'bend',
  'welding_tee',
  'unreinforced_tee',
  'reinforced_tee',
  'weldolet',
  'sweepolet',
  'reducer',
  'butt_weld',
] as const;

export type SifComponent = (typeof SIF_COMPONENTS)[number];

export interface SifInput {
  readonly component: SifComponent;
  readonly odMm: number;
  readonly wallMm: number;
  readonly bendRadiusMm?: number | undefined;
  readonly padMm?: number | undefined;
  /** Bend / elbow only: ends of the bend that are flanged (0, 1 or 2); the flange stiffening correction c = h^(1/6) / h^(1/3) multiplies h (PSI b311.py note 3, B31.1 App. D). */
  readonly flangedEnds?: 0 | 1 | 2 | undefined;
}

export interface SifValues {
  readonly h: number | null;
  readonly k: number;
  readonly ii: number;
  readonly io: number;
  readonly ruleRow: string;
  readonly grade: RuleGrade;
  readonly formula: string;
  /** Elbow / bend only: a factor was raised to its floor of 1, or h > 1 (outside the range the formulas were fitted for). */
  readonly clamped?: string;
}

export interface SifRefusal {
  readonly reason: string;
  readonly path: string;
}

const atLeastOne = (value: number): number => Math.max(1, value);
const power = (h: number): number => pow(h, 2 / 3);

/** The tee / branch family: h differs by fitting, io = 0.9 / h^(2/3), ii = 0.75 io + 0.25 (B31.1: one value, io). */
function branchValues(set: RuleSet, h: number, ruleRow: string, formula: string): SifValues {
  const io = atLeastOne(0.9 / power(h));
  const ii = set.code === 'B31.1' ? io : atLeastOne(0.75 * io + 0.25);
  return { h, k: 1, ii, io, ruleRow, grade: 'B', formula };
}

/**
 * @failure bend / elbow without bendRadiusMm, reinforced tee without padMm, sweepolet / reducer (no read source), non-physical wall -> SifRefusal
 */
export function computeSif(set: RuleSet, input: SifInput): SifValues | SifRefusal {
  const { component, odMm, wallMm } = input;
  if (!(odMm > 0) || !(wallMm > 0) || 2 * wallMm >= odMm) {
    return { reason: `OD ${odMm} mm and wall ${wallMm} mm are not a physical pipe (need 0 < wall < OD / 2)`, path: 'wallMm' };
  }
  const meanRadius = (odMm - wallMm) / 2;
  switch (component) {
    case 'elbow':
    case 'bend': {
      const radius = input.bendRadiusMm;
      if (radius === undefined) return { reason: `${component} needs bendRadiusMm (the centreline bend radius R1)`, path: 'bendRadiusMm' };
      if (radius < meanRadius)
        return {
          reason: `bendRadiusMm ${radius} is below the pipe mean radius ${meanRadius.toFixed(2)} mm: not a bend`,
          path: 'bendRadiusMm',
        };
      const plain = (wallMm * radius) / meanRadius ** 2;
      const flanged = input.flangedEnds === undefined ? 0 : input.flangedEnds;
      const h = flanged === 0 ? plain : plain * (flanged === 1 ? pow(plain, 1 / 6) : pow(plain, 1 / 3));
      const raw = [1.65 / h, 0.9 / power(h), 0.75 / power(h)];
      const clamped =
        h > 1 ? `h = ${h.toFixed(3)} > 1` : raw.some((value) => value < 1) ? 'a factor was raised to its floor of 1.0' : undefined;
      const ii = atLeastOne(0.9 / power(h));
      const io = set.code === 'B31.1' ? ii : atLeastOne(0.75 / power(h));
      return {
        h,
        k: atLeastOne(1.65 / h),
        ii,
        io,
        ruleRow: flanged === 0 ? 'SIF-BEND' : 'SIF-BEND-FLANGED',
        grade: flanged === 0 ? 'A' : 'B',
        ...(clamped === undefined ? {} : { clamped }),
        formula:
          'h = T R1 / r2^2; k = 1.65 / h; ii = 0.9 / h^(2/3); io = 0.75 / h^(2/3) (B31.1: i = 0.9 / h^(2/3) for both); each >= 1' +
          (flanged === 0 ? '' : `; flanged ends ${flanged}: h = h0 x h0^(${flanged === 1 ? '1/6' : '1/3'}), h0 = T R1 / r2^2`),
      };
    }
    case 'unreinforced_tee':
      return branchValues(
        set,
        wallMm / meanRadius,
        'SIF-TEE-UNREINFORCED',
        'h = T / r2; io = 0.9 / h^(2/3); ii = 0.75 io + 0.25; each >= 1',
      );
    case 'welding_tee':
      return branchValues(
        set,
        (3.1 * wallMm) / meanRadius,
        'SIF-TEE-WELDING',
        'h = 3.1 T / r2; io = 0.9 / h^(2/3); ii = 0.75 io + 0.25; each >= 1 (B31.1 crotch-radius variant h = 4.4 T / r2 is not used)',
      );
    case 'weldolet':
      return branchValues(
        set,
        (3.3 * wallMm) / meanRadius,
        'SIF-BRANCH-WELDOLET',
        'h = 3.3 T / r2; io = 0.9 / h^(2/3); ii = 0.75 io + 0.25; each >= 1',
      );
    case 'reinforced_tee': {
      const pad = input.padMm;
      if (pad === undefined) return { reason: 'reinforced_tee needs padMm (the pad or saddle thickness tr)', path: 'padMm' };
      const h = pow(wallMm + pad / 2, 2.5) / (pow(wallMm, 1.5) * meanRadius);
      return branchValues(
        set,
        h,
        'SIF-TEE-REINFORCED',
        'h = (T + tr/2)^2.5 / (T^1.5 r2); io = 0.9 / h^(2/3); ii = 0.75 io + 0.25; each >= 1',
      );
    }
    case 'butt_weld':
      return { h: null, k: 1, ii: 1, io: 1, ruleRow: 'SIF-BUTT-WELD', grade: 'B', formula: 'i = 1.0' };
    case 'sweepolet':
    case 'reducer':
      return {
        reason: `${component} has no factor in a read source yet (grade C); give the factors with rule "user" (manufacturer or B31J value)`,
        path: 'component',
      };
  }
}

export const isSifRefusal = (value: SifValues | SifRefusal): value is SifRefusal => 'reason' in value;
