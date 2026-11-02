/**
 * Stress intensification and flexibility factors of the code appendix D formulas (07 PST §5.7). B31.1 has one SIF for both planes: it is
 * returned as ii = io. Every component has one rule row (grade named in the result); components with no row in a read source are refused.
 */

import type { RuleGrade, RuleSet } from './ruleSets';

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
}

export interface SifValues {
  readonly h: number | null;
  readonly k: number;
  readonly ii: number;
  readonly io: number;
  readonly ruleRow: string;
  readonly grade: RuleGrade;
  readonly formula: string;
}

export interface SifRefusal {
  readonly reason: string;
  readonly path: string;
}

const atLeastOne = (value: number): number => Math.max(1, value);
const power = (h: number): number => h ** (2 / 3);

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
      const h = (wallMm * radius) / meanRadius ** 2;
      const ii = atLeastOne(0.9 / power(h));
      const io = set.code === 'B31.1' ? ii : atLeastOne(0.75 / power(h));
      return {
        h,
        k: atLeastOne(1.65 / h),
        ii,
        io,
        ruleRow: 'SIF-BEND',
        grade: 'A',
        formula: 'h = T R1 / r2^2; k = 1.65 / h; ii = 0.9 / h^(2/3); io = 0.75 / h^(2/3) (B31.1: i = 0.9 / h^(2/3) for both); each >= 1',
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
      const h = (wallMm + pad / 2) ** 2.5 / (wallMm ** 1.5 * meanRadius);
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
