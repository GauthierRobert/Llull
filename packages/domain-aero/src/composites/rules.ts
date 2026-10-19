/** Laminate design rules R1-R5 + disorientation (06 CMP §5.8, FR-CMP-20..22). Defaults are the commonly published guidelines, not CMH-17 clauses. */

import type { PlyDropRules, RuleConfig } from '@core/model/composites';
import { normalizeAngle } from './notation';

export const DEFAULT_RULES: RuleConfig = { symmetric: true, balanced: true, minFraction: 0.1, maxConsecutive: 4, outerPlusMinus45: true };

export const DEFAULT_DROP_RULES: PlyDropRules = { rampRatio: 20, minStagger: 3, staggerUnit: 'dropped_thickness', dropOrder: 'inner_first', coverPlies: 1 };

export type RuleCode =
  | 'CMP_RULE_R1_SYMMETRY'
  | 'CMP_RULE_R2_BALANCE'
  | 'CMP_RULE_R3_MIN_FRACTION'
  | 'CMP_RULE_R4_MAX_CONSECUTIVE'
  | 'CMP_RULE_R5_OUTER_PM45'
  | 'CMP_RULE_DISORIENTATION';

export interface RuleFinding {
  readonly code: RuleCode;
  readonly severity: 'fail';
  readonly rule: string;
  /** 0-based ply indices (bottom to top) the finding is about. */
  readonly plies: readonly number[];
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly remediation: string;
}

const RULE_OF: Readonly<Record<RuleCode, string>> = {
  CMP_RULE_R1_SYMMETRY: 'R1 symmetric',
  CMP_RULE_R2_BALANCE: 'R2 balanced',
  CMP_RULE_R3_MIN_FRACTION: 'R3 minimum fraction per 0 / +-45 / 90 family',
  CMP_RULE_R4_MAX_CONSECUTIVE: 'R4 maximum consecutive plies of one angle',
  CMP_RULE_R5_OUTER_PM45: 'R5 outer plies +-45',
  CMP_RULE_DISORIENTATION: 'maximum angle change between adjacent plies',
};

const finding = (
  code: RuleCode,
  plies: readonly number[],
  value: number,
  limit: number,
  unit: string,
  remediation: string,
): RuleFinding => ({ code, severity: 'fail', rule: RULE_OF[code], plies, value, limit, unit, remediation });

/** Name used by `RuleConfig.disabled[].rule` for each rule code. */
export const RULE_KEY: Readonly<Record<RuleCode, string>> = {
  CMP_RULE_R1_SYMMETRY: 'R1',
  CMP_RULE_R2_BALANCE: 'R2',
  CMP_RULE_R3_MIN_FRACTION: 'R3',
  CMP_RULE_R4_MAX_CONSECUTIVE: 'R4',
  CMP_RULE_R5_OUTER_PM45: 'R5',
  CMP_RULE_DISORIENTATION: 'DISORIENTATION',
};

/** Smallest rotation between two ply directions (degrees, 0..90). */
const angleChange = (a: number, b: number): number => {
  const difference = Math.abs(a - b) % 180;
  return Math.min(difference, 180 - difference);
};

/**
 * Rule findings for one stack (angles bottom to top).
 * @invariant angles are normalised to (-90, 90]; runs are counted on the normalised sequence; disabled rules are skipped
 */
export function checkStack(rawAngles: readonly number[], config: RuleConfig): RuleFinding[] {
  const angles = rawAngles.map(normalizeAngle);
  const n = angles.length;
  const disabled = new Set((config.disabled ?? []).map((entry) => entry.rule));
  const active = (code: RuleCode): boolean => !disabled.has(RULE_KEY[code]);
  const findings: RuleFinding[] = [];
  if (n === 0) return findings;
  if (config.symmetric && active('CMP_RULE_R1_SYMMETRY')) {
    const mismatched = angles.flatMap((angle, i) => (i < n - 1 - i && angle !== angles[n - 1 - i] ? [i, n - 1 - i] : []));
    if (mismatched.length > 0)
      findings.push(
        finding(
          'CMP_RULE_R1_SYMMETRY',
          mismatched,
          mismatched.length / 2,
          0,
          'mismatched ply pairs',
          'mirror the stack about its mid-plane (use [..]s)',
        ),
      );
  }
  if (config.balanced && active('CMP_RULE_R2_BALANCE')) {
    const unbalanced = [...new Set(angles.filter((a) => a !== 0 && a !== 90).map(Math.abs))].filter(
      (a) => angles.filter((x) => x === a).length !== angles.filter((x) => x === -a).length,
    );
    if (unbalanced.length > 0)
      findings.push(
        finding(
          'CMP_RULE_R2_BALANCE',
          angles.flatMap((a, i) => (unbalanced.includes(Math.abs(a)) ? [i] : [])),
          unbalanced.length,
          0,
          'unbalanced angle families',
          `add the missing -theta ply for ${unbalanced.map((a) => `+-${a}`).join(', ')} so each +theta has a -theta`,
        ),
      );
  }
  if (active('CMP_RULE_R3_MIN_FRACTION')) {
    const families: readonly [string, (a: number) => boolean][] = [
      ['0', (a) => a === 0],
      ['+-45', (a) => Math.abs(a) === 45],
      ['90', (a) => a === 90],
    ];
    for (const [name, member] of families) {
      const fraction = angles.filter(member).length / n;
      if (fraction < config.minFraction - 1e-12)
        findings.push(
          finding(
            'CMP_RULE_R3_MIN_FRACTION',
            angles.flatMap((a, i) => (member(a) ? [i] : [])),
            fraction,
            config.minFraction,
            `fraction of plies (${name} family)`,
            `use at least ${config.minFraction * 100}% of the ${name} family`,
          ),
        );
    }
  }
  if (active('CMP_RULE_R4_MAX_CONSECUTIVE')) {
    for (let start = 0; start < n; ) {
      let end = start + 1;
      while (end < n && angles[end] === angles[start]) end += 1;
      if (end - start > config.maxConsecutive)
        findings.push(
          finding(
            'CMP_RULE_R4_MAX_CONSECUTIVE',
            Array.from({ length: end - start }, (_, k) => start + k),
            end - start,
            config.maxConsecutive,
            'consecutive plies',
            `split the run of ${end - start} plies at ${angles[start]} degrees with plies of other angles`,
          ),
        );
      start = end;
    }
  }
  if (
    config.outerPlusMinus45 &&
    active('CMP_RULE_R5_OUTER_PM45') &&
    (Math.abs(angles[0] as number) !== 45 || Math.abs(angles[n - 1] as number) !== 45)
  )
    findings.push(
      finding(
        'CMP_RULE_R5_OUTER_PM45',
        [0, n - 1],
        Math.abs(angles[0] as number) === 45 ? (angles[n - 1] as number) : (angles[0] as number),
        45,
        'degrees (outer ply angle)',
        'make both outer plies +45 or -45',
      ),
    );
  if (config.maxAngleChange !== undefined && active('CMP_RULE_DISORIENTATION'))
    for (let i = 0; i + 1 < n; i++) {
      const change = angleChange(angles[i] as number, angles[i + 1] as number);
      if (change > config.maxAngleChange)
        findings.push(
          finding(
            'CMP_RULE_DISORIENTATION',
            [i, i + 1],
            change,
            config.maxAngleChange,
            'degrees',
            'reorder plies so adjacent angles differ by no more than the limit',
          ),
        );
    }
  return findings;
}

/** Fractions of the 0, +-45 and 90 families (0..1). */
export function familyFractions(rawAngles: readonly number[]): {
  readonly zero: number;
  readonly plusMinus45: number;
  readonly ninety: number;
} {
  const angles = rawAngles.map(normalizeAngle);
  const share = (member: (a: number) => boolean): number => (angles.length === 0 ? 0 : angles.filter(member).length / angles.length);
  return { zero: share((a) => a === 0), plusMinus45: share((a) => Math.abs(a) === 45), ninety: share((a) => a === 90) };
}
