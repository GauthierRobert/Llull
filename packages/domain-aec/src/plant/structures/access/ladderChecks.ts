/** Rule evaluation of a fixed ladder (06 STA M4): pitch, width, back clearance, stile extension, fall protection, cage, landings. */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { LadderElement } from '@aec/building/types';
import { ruleFlag, breach, ruleById, type AccessRule, type RulesetName } from '../rules/ruleTable';
import type { StaCode } from '../codes';
import { OSHA_CAGE_RETROFIT_DATE, installedAfterRuleDate } from '../ladder/ladderDefaults';
import { breachFinding, ruleFinding, type Finding } from './finding';

interface LadderMeasures {
  readonly height: number;
  readonly pitch: number;
  readonly clearWidth: number;
  readonly backClearance: number;
  readonly railExtension: number;
  /** Longest stretch between departure, landings and arrival, mm. */
  readonly section: number;
}

const measuresOf = (doc: CadDocument, ladder: LadderElement): LadderMeasures => {
  const heights = [0, ...ladder.landings, ladder.climbHeight];
  const section = Math.max(...heights.slice(1).map((height, index) => height - (heights[index] as number)));
  return {
    height: toMm(doc, ladder.climbHeight),
    pitch: toMm(doc, ladder.rungPitch),
    clearWidth: toMm(doc, ladder.clearWidth),
    backClearance: toMm(doc, ladder.backClearance),
    railExtension: toMm(doc, ladder.railExtension),
    section: toMm(doc, section),
  };
};

interface RangeCheck {
  readonly ruleId: string;
  readonly code: StaCode;
  readonly measure: (measures: LadderMeasures) => number;
}

// prettier-ignore
const RANGE_CHECKS: readonly RangeCheck[] = [
  { ruleId: 'ISO-LAD-PITCH', code: 'STA_LADDER_PITCH_OUT_OF_RANGE', measure: (m) => m.pitch },
  { ruleId: 'OSHA-LAD-RUNG-PITCH', code: 'STA_LADDER_PITCH_OUT_OF_RANGE', measure: (m) => m.pitch },
  { ruleId: 'ISO-LAD-WIDTH', code: 'STA_LADDER_WIDTH', measure: (m) => m.clearWidth },
  { ruleId: 'OSHA-LAD-CLEAR-WIDTH', code: 'STA_LADDER_WIDTH', measure: (m) => m.clearWidth },
  { ruleId: 'OSHA-LAD-BACK-CLEAR', code: 'STA_LADDER_BACK_CLEARANCE', measure: (m) => m.backClearance },
  { ruleId: 'ISO-LAD-STILE-EXT', code: 'STA_LADDER_RAIL_EXTENSION', measure: (m) => m.railExtension },
  { ruleId: 'OSHA-LAD-RAIL-EXT', code: 'STA_LADDER_RAIL_EXTENSION', measure: (m) => m.railExtension },
];

const CAGE_ROWS = ['ISO-LAD-CAGE-START', 'ISO-LAD-CAGE-HOOP', 'ISO-LAD-CAGE-DIAM', 'OSHA-LAD-CAGE-LANDING'];
const LSS_ROWS = ['OSHA-LAD-LSS-REST'];
const FALL_ROWS = ['ISO-LAD-FALLPROT-HEIGHT', 'OSHA-LAD-FALLPROT-HEIGHT'];

/** Rows evaluated for these ladders and rulesets (for the grade B list `unverifiedRulesUsed`). */
export function ladderRules(ladders: readonly LadderElement[], rulesets: readonly RulesetName[]): AccessRule[] {
  const ids = [
    ...RANGE_CHECKS.map((check) => check.ruleId),
    ...FALL_ROWS,
    ...(ladders.some((ladder) => ladder.fallProtection === 'cage') ? CAGE_ROWS : []),
    ...(ladders.some((ladder) => ladder.fallProtection === 'ladder_safety_system' || ladder.fallProtection === 'pfas') ? LSS_ROWS : []),
  ];
  return ids.map(ruleById).filter((rule) => rulesets.includes(rule.ruleset));
}

/** Rows of the ladder rules that no check reads, listed in `notEvaluated`. */
export const LADDER_RULES_NOT_EVALUATED: ReadonlyArray<{ readonly ruleId: string; readonly reason: string }> = [
  { ruleId: 'ISO-LAD-FLIGHT', reason: 'grade C row: not loaded; the sources disagree on the flight height' },
  {
    ruleId: 'ladder-back-clearance',
    reason: 'measured once when the ladder was added (rays from the rung centre); a moved obstacle is not re-measured',
  },
];

function fallProtectionFindings(ladder: LadderElement, measures: LadderMeasures, rulesets: readonly RulesetName[]): Finding[] {
  const found: Finding[] = [];
  const caged = ladder.fallProtection === 'cage';
  if (rulesets.includes('iso_14122')) {
    const rule = ruleById('ISO-LAD-FALLPROT-HEIGHT');
    const protectedByIso = caged || ladder.fallProtection === 'ladder_safety_system';
    if (measures.height >= (rule.min ?? Infinity) && !protectedByIso)
      found.push(
        ruleFinding(
          rule,
          'STA_LADDER_FALL_PROTECTION_MISSING',
          ladder.id,
          measures.height,
          'fail',
          'needs a cage or a ladder safety system',
        ),
      );
  }
  if (rulesets.includes('osha_1910')) {
    const rule = ruleById('OSHA-LAD-FALLPROT-HEIGHT');
    if (measures.height > (rule.maxWithout ?? Infinity)) {
      if (ladder.fallProtection === 'none')
        found.push(
          ruleFinding(
            rule,
            'STA_LADDER_FALL_PROTECTION_MISSING',
            ladder.id,
            measures.height,
            'fail',
            'needs a ladder safety system or PFAS',
          ),
        );
      else if (caged && installedAfterRuleDate(ladder.installedOn))
        found.push(
          ruleFinding(
            rule,
            'STA_LADDER_CAGE_NOT_PRIMARY',
            ladder.id,
            measures.height,
            'fail',
            'a cage alone is not acceptable from 2018-11-19',
          ),
        );
      else if (caged)
        found.push(
          ruleFinding(
            rule,
            'STA_LADDER_CAGE_RETROFIT',
            ladder.id,
            measures.height,
            'warn',
            `existing cage allowed until ${OSHA_CAGE_RETROFIT_DATE}; ${ruleFlag(rule.id) ?? ''}`.trim(),
          ),
        );
    }
  }
  return found;
}

function cageFindings(ladder: LadderElement, doc: CadDocument, rulesets: readonly RulesetName[]): Finding[] {
  if (ladder.cage === undefined) return [];
  const checks: Array<{ ruleId: string; code: StaCode; value: number }> = [
    { ruleId: 'ISO-LAD-CAGE-START', code: 'STA_LADDER_CAGE_START', value: toMm(doc, ladder.cage.startHeight) },
    { ruleId: 'ISO-LAD-CAGE-HOOP', code: 'STA_LADDER_CAGE_GEOMETRY', value: toMm(doc, ladder.cage.hoopSpacing) },
    { ruleId: 'ISO-LAD-CAGE-DIAM', code: 'STA_LADDER_CAGE_GEOMETRY', value: toMm(doc, ladder.cage.diameter) },
  ];
  return checks.flatMap((check) => {
    const rule = ruleById(check.ruleId);
    const found = rulesets.includes(rule.ruleset) ? breachFinding(rule, check.code, ladder.id, check.value) : null;
    return found === null ? [] : [found];
  });
}

export function checkLadder(doc: CadDocument, ladder: LadderElement, rulesets: readonly RulesetName[]): Finding[] {
  const measures = measuresOf(doc, ladder);
  const found: Finding[] = RANGE_CHECKS.flatMap((check) => {
    const rule = ruleById(check.ruleId);
    const finding = rulesets.includes(rule.ruleset) ? breachFinding(rule, check.code, ladder.id, check.measure(measures)) : null;
    return finding === null ? [] : [finding];
  });
  found.push(...fallProtectionFindings(ladder, measures, rulesets), ...cageFindings(ladder, doc, rulesets));
  if (
    rulesets.includes('osha_1910') &&
    (ladder.fallProtection === 'cage' || ladder.fallProtection === 'ladder_safety_system' || ladder.fallProtection === 'pfas')
  ) {
    const rule = ruleById(ladder.fallProtection === 'cage' ? 'OSHA-LAD-CAGE-LANDING' : 'OSHA-LAD-LSS-REST');
    if (breach(rule, measures.section) === 'above')
      found.push(ruleFinding(rule, 'STA_LADDER_LANDING_INTERVAL', ladder.id, measures.section, rule.grade === 'A' ? 'fail' : 'warn'));
  }
  return found;
}
