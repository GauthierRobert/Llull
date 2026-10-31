/** A `check_access` finding (06 STA §5.10) and its construction from a rule row. */

import { remediationOf, type StaCode } from '../codes';
import { breach, limitOf, severityOf, type AccessRule } from '../rules/ruleTable';

export interface Finding {
  readonly code: StaCode;
  readonly ruleId: string;
  readonly ruleset: string;
  readonly clause: string;
  readonly severity: 'fail' | 'warn';
  readonly grade: AccessRule['grade'];
  readonly ids: readonly string[];
  readonly measured: { readonly value: number; readonly unit: string };
  readonly limit: { readonly min?: number; readonly max?: number; readonly unit: string };
  readonly remediation: string;
  readonly source: string;
  /** Where on the element the finding is (slab edge). */
  readonly location?: string;
}

/** A finding of `rule` for `value` with an explicit severity (rules whose trigger is not a plain range). */
export function ruleFinding(rule: AccessRule, code: StaCode, id: string, value: number, severity: 'fail' | 'warn', note?: string): Finding {
  const unit = rule.unit ?? 'mm';
  return {
    code,
    ruleId: rule.id,
    ruleset: rule.ruleset,
    clause: rule.clause,
    severity,
    grade: rule.grade,
    ids: [id],
    measured: { value, unit },
    limit: { ...limitOf(rule), unit },
    remediation: remediationOf(code),
    source: note === undefined ? rule.source : `${rule.source}; ${note}`,
  };
}

/** A measurement checked against one row: the finding of the breach, or null when the value complies. */
export function breachFinding(rule: AccessRule, code: StaCode, id: string, value: number): Finding | null {
  const side = breach(rule, value);
  return side === null ? null : ruleFinding(rule, code, id, value, severityOf(rule, side));
}

/** The `STA_RULE_UNVERIFIED` warning of every grade B row that was breached, listing all elements concerned. */
export function unverifiedFindings(breaches: readonly Finding[], rules: readonly AccessRule[]): Finding[] {
  return rules.flatMap((rule) => {
    const hits = breaches.filter((finding) => finding.ruleId === rule.id);
    const first = hits[0];
    if (rule.grade !== 'B' || first === undefined) return [];
    return [
      {
        ...first,
        code: 'STA_RULE_UNVERIFIED' as const,
        severity: 'warn' as const,
        ids: hits.flatMap((finding) => finding.ids),
        remediation: remediationOf('STA_RULE_UNVERIFIED'),
      },
    ];
  });
}
