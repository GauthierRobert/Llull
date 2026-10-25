/** Rule evaluation of a railing (06 STA M3): top-rail height, clear space between rails and toe plate, per ruleset. */

import type { CadDocument } from '@core/model/types';
import type { RailingElement } from '@aec/building/types';
import { toMm } from '@core/model/units';
import type { StaCode } from '../codes';
import { breach, ruleById, type AccessRule, type RulesetName } from '../rules/ruleTable';
import { railingQuantities } from '../railing/railingMeasure';
import { breachFinding, type Finding } from './finding';

/** Rail quantities in mm. */
interface RailingMeasures {
  readonly height: number;
  readonly clearGap: number;
  readonly toePlate: number;
}

export function railingMeasures(doc: CadDocument, railing: RailingElement): RailingMeasures | null {
  const quantities = railingQuantities(doc, railing);
  return quantities === null
    ? null
    : { height: toMm(doc, railing.height), clearGap: quantities.clearGapMm, toePlate: toMm(doc, railing.toePlate) };
}

interface RailingCheck {
  readonly ruleId: string;
  readonly code: (side: 'below' | 'above') => StaCode;
  readonly measure: (measures: RailingMeasures) => number;
}

const HEIGHT = (side: 'below' | 'above'): StaCode => (side === 'below' ? 'STA_RAIL_HEIGHT_LOW' : 'STA_RAIL_HEIGHT_HIGH');

// prettier-ignore
const GUARD_CHECKS: readonly RailingCheck[] = [
  { ruleId: 'ISO-GRD-TOP', code: HEIGHT, measure: (m) => m.height },
  { ruleId: 'OSHA-GRD-TOP', code: HEIGHT, measure: (m) => m.height },
  { ruleId: 'ISO-GRD-GAP', code: () => 'STA_RAIL_GAP', measure: (m) => m.clearGap },
  { ruleId: 'OSHA-GRD-MID', code: () => 'STA_RAIL_GAP', measure: (m) => m.clearGap },
  { ruleId: 'ISO-TOE-HEIGHT', code: () => 'STA_TOE_PLATE_MISSING', measure: (m) => m.toePlate },
  { ruleId: 'OSHA-TOE-HEIGHT', code: () => 'STA_TOE_PLATE_MISSING', measure: (m) => m.toePlate },
];

/** Rows that need data or a test M3 does not have, reported as not evaluated rather than silently passed. */
export const RAILING_RULES_NOT_EVALUATED: ReadonlyArray<{ readonly ruleId: string; readonly reason: string }> = [
  { ruleId: 'OSHA-GRD-LOAD', reason: 'the 200 lbf top-rail test is a structural proof, not a geometric check' },
  { ruleId: 'OSHA-GRD-DEFL', reason: 'top-rail deflection under load is a structural proof, not a geometric check' },
  { ruleId: 'OSHA-GRD-MIDLOAD', reason: 'the 150 lbf midrail test is a structural proof, not a geometric check' },
  { ruleId: 'ISO-TOE-GAP', reason: 'the gap under the toe plate is not modelled (toe plates stand on the walking surface)' },
  { ruleId: 'ISO-GRD-POST-SPACING', reason: 'grade C row: not loaded; postSpacingMax is an explicit parameter' },
];

/** Rows evaluated for the requested rulesets (guard-rails only: hand-rails have no rule rows). */
export const railingRules = (rulesets: readonly RulesetName[]): AccessRule[] =>
  GUARD_CHECKS.map((check) => ruleById(check.ruleId)).filter((rule) => rulesets.includes(rule.ruleset));

export function checkRailing(doc: CadDocument, railing: RailingElement, rulesets: readonly RulesetName[]): Finding[] {
  const measures = railing.role === 'guardrail' ? railingMeasures(doc, railing) : null;
  if (measures === null) return [];
  return GUARD_CHECKS.flatMap((check) => {
    const rule = ruleById(check.ruleId);
    if (!rulesets.includes(rule.ruleset)) return [];
    const value = check.measure(measures);
    const side = breach(rule, value);
    if (side === null) return [];
    const found = breachFinding(rule, check.code(side), railing.id, value);
    return found === null ? [] : [found];
  });
}
