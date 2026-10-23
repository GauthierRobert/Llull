/** Rule evaluation of the existing concrete `stair` element (06 STA M1; steel stairs come with M5). */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { StairElement } from '@aec/building/types';
import type { StaCode } from '../codes';
import { ruleById, type AccessRule, type RulesetName } from '../rules/ruleTable';
import { breachFinding, type Finding } from './finding';

/** Stair quantities in mm / degrees. */
interface StairMeasures {
  readonly riser: number;
  readonly going: number;
  readonly width: number;
  readonly pitchDeg: number;
  readonly blondel: number;
  readonly flightRise: number;
}

export function stairMeasures(doc: CadDocument, stair: StairElement): StairMeasures {
  const riser = toMm(doc, stair.riserHeight);
  const going = toMm(doc, stair.treadDepth);
  const landingAt = stair.landingAt ?? 0;
  const longestFlight = landingAt > 0 ? Math.max(landingAt, stair.riserCount - landingAt) : stair.riserCount;
  return {
    riser,
    going,
    width: toMm(doc, stair.width),
    pitchDeg: (Math.atan2(riser, going) * 180) / Math.PI,
    blondel: 2 * riser + going,
    flightRise: longestFlight * riser,
  };
}

interface StairCheck {
  readonly ruleId: string;
  readonly code: StaCode;
  readonly measure: (measures: StairMeasures) => number;
}

// prettier-ignore
const STAIR_CHECKS: readonly StairCheck[] = [
  { ruleId: 'ISO-STR-BLONDEL', code: 'STA_STAIR_BLONDEL', measure: (m) => m.blondel },
  { ruleId: 'ISO-STR-WIDTH', code: 'STA_STAIR_WIDTH', measure: (m) => m.width },
  { ruleId: 'ISO-STR-FLIGHT-RISE', code: 'STA_STAIR_FLIGHT_RISE', measure: (m) => m.flightRise },
  { ruleId: 'OSHA-STR-RISER', code: 'STA_STAIR_RISER', measure: (m) => m.riser },
  { ruleId: 'OSHA-STR-TREAD', code: 'STA_STAIR_TREAD', measure: (m) => m.going },
  { ruleId: 'OSHA-STR-ANGLE', code: 'STA_STAIR_ANGLE', measure: (m) => m.pitchDeg },
  { ruleId: 'OSHA-STR-WIDTH', code: 'STA_STAIR_WIDTH', measure: (m) => m.width },
];

/** Rows that need data M1 does not have, reported as not evaluated rather than silently passed. */
export const STAIR_RULES_NOT_EVALUATED: ReadonlyArray<{ readonly ruleId: string; readonly reason: string }> = [
  { ruleId: 'ISO-STR-HEADROOM', reason: 'headroom over the pitch line is not evaluated in M1 (use check_model for stair/slab headroom)' },
  { ruleId: 'OSHA-STR-LANDING', reason: 'landing depth and width are not evaluated in M1' },
  { ruleId: 'OSHA-STR-UNIFORM', reason: 'a concrete stair has equal risers and treads by construction' },
];

/** Rows evaluated for the requested rulesets. */
export const stairRules = (rulesets: readonly RulesetName[]): AccessRule[] =>
  STAIR_CHECKS.map((check) => ruleById(check.ruleId)).filter((rule) => rulesets.includes(rule.ruleset));

export function checkStair(doc: CadDocument, stair: StairElement, rulesets: readonly RulesetName[]): Finding[] {
  const measures = stairMeasures(doc, stair);
  return STAIR_CHECKS.flatMap((check) => {
    const rule = ruleById(check.ruleId);
    if (!rulesets.includes(rule.ruleset)) return [];
    const finding = breachFinding(rule, check.code, stair.id, check.measure(measures));
    return finding === null ? [] : [finding];
  });
}
