/**
 * Access-rule table (06 STA §5.10): rows loaded from `accessRules.json` (a copy of `validation/data/access_rules.json`, kept identical by
 * a test). Check commands read rows by id and never use a literal limit.
 * Grade policy: A rows gate (fail), B rows only warn, C rows are never loaded.
 */

import table from './accessRules.json';

/** Date of the table; every finding reports it. Change it whenever a row changes (OSHA 2036 repeal, ISO rows promoted). */
export const RULE_TABLE_VERSION = '2026-10-18';

export const RULESET_NAMES = ['iso_14122', 'osha_1910'] as const;
export type RulesetName = (typeof RULESET_NAMES)[number];

export type RuleGrade = 'A' | 'B' | 'C';

/** One transcribed rule. Lengths in mm, forces in N, angles in degrees (`unit`); imperial originals in `original`. */
export interface AccessRule {
  readonly id: string;
  readonly ruleset: RulesetName;
  readonly clause: string;
  readonly quantity: string;
  readonly grade: RuleGrade;
  readonly source: string;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly nominal?: number;
  readonly preferred?: number;
  readonly maxWithout?: number;
  readonly maxOpening?: number;
  readonly minForceN?: number;
  readonly rule?: string;
  readonly maxSeverity?: 'warn';
  readonly original?: string;
  readonly detail?: string;
  readonly note?: string;
  readonly conflict?: string;
}

export const ALL_RULES: readonly AccessRule[] = table.rules as readonly AccessRule[];

/** Rows that can produce a finding (grade A and B). */
export const LOADED_RULES: readonly AccessRule[] = ALL_RULES.filter((rule) => rule.grade !== 'C');

/** Open caveats on a row that a reviewer must see wherever it is listed (plant README D10). */
const RULE_FLAGS: Readonly<Record<string, string>> = {
  'OSHA-LAD-FALLPROT-HEIGHT':
    'retrofit date 2036-11-18 for existing caged ladders is under a proposed repeal (Federal Register 2026-04-06); status unknown, a reviewer decides',
};

export const ruleFlag = (ruleId: string): string | undefined => RULE_FLAGS[ruleId];

export function ruleById(id: string): AccessRule {
  const rule = LOADED_RULES.find((row) => row.id === id);
  if (rule === undefined) throw new Error(`access rule ${id} is not in the loaded table`);
  return rule;
}

/** Comparison tolerance (mm, N or degrees): limits are original-unit values converted exactly. */
const TOLERANCE = 1e-6;

/** The lower and upper bound of a row (`maxWithout` and `maxOpening` are upper bounds, `minForceN` a lower bound). */
export const limitOf = (rule: AccessRule): { readonly min?: number; readonly max?: number } => {
  const min = rule.min ?? rule.minForceN;
  const max = rule.max ?? rule.maxWithout ?? rule.maxOpening;
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
};

/** Which side of the row's range `value` falls on, or null when it complies (or the row has no numeric limit). */
export function breach(rule: AccessRule, value: number): 'below' | 'above' | null {
  const { min, max } = limitOf(rule);
  if (min !== undefined && value < min - TOLERANCE) return 'below';
  if (max !== undefined && value > max + TOLERANCE) return 'above';
  return null;
}

/** `fail` for a grade A breach (capped at warn by `maxSeverity`), `warn` for grade B. */
export const severityOf = (rule: AccessRule): 'fail' | 'warn' => (rule.grade === 'A' && rule.maxSeverity !== 'warn' ? 'fail' : 'warn');
