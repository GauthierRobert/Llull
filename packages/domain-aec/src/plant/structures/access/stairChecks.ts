/** Rule evaluation of stairs (06 STA M1 concrete `stair`, M5 `steelStair`): Blondel, riser, tread, pitch, width, flight rise. */

import type { CadDocument } from '@core/model/types';
import { toMm } from '@core/model/units';
import type { StairElement, SteelStairElement } from '@aec/building/types';
import type { StaCode } from '../codes';
import { ruleById, type AccessRule, type RulesetName } from '../rules/ruleTable';
import { stairGeometryMm } from '../stair/steelStairMeasure';
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

/** Measures of a steel stair; the longest flight is the largest gap between landings. */
function steelStairMeasures(doc: CadDocument, stair: SteelStairElement): StairMeasures {
  const geometry = stairGeometryMm(doc, stair);
  const cuts = [0, ...stair.landings.map((landing) => landing.afterRiser), stair.riserCount];
  const longestFlight = Math.max(...cuts.slice(1).map((cut, index) => cut - (cuts[index] as number)));
  return {
    riser: geometry.riser,
    going: geometry.going,
    width: toMm(doc, stair.width),
    pitchDeg: geometry.pitchDeg,
    blondel: geometry.blondel,
    flightRise: longestFlight * geometry.riser,
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

/** Rows that need data the stair checks do not have, reported as not evaluated rather than silently passed. */
export const STAIR_RULES_NOT_EVALUATED: ReadonlyArray<{ readonly ruleId: string; readonly reason: string }> = [
  { ruleId: 'ISO-STR-HEADROOM', reason: 'headroom over the pitch line is not evaluated (use check_model for stair/slab headroom)' },
  { ruleId: 'OSHA-STR-LANDING', reason: 'landing depth and width are not evaluated' },
  { ruleId: 'OSHA-STR-UNIFORM', reason: 'a stair has equal risers and treads by construction' },
];

/** Rows evaluated for the requested rulesets. */
export const stairRules = (rulesets: readonly RulesetName[]): AccessRule[] =>
  STAIR_CHECKS.map((check) => ruleById(check.ruleId)).filter((rule) => rulesets.includes(rule.ruleset));

function findingsOf(measures: StairMeasures, id: string, rulesets: readonly RulesetName[]): Finding[] {
  return STAIR_CHECKS.flatMap((check) => {
    const rule = ruleById(check.ruleId);
    if (!rulesets.includes(rule.ruleset)) return [];
    const finding = breachFinding(rule, check.code, id, check.measure(measures));
    return finding === null ? [] : [finding];
  });
}

export const checkStair = (doc: CadDocument, stair: StairElement, rulesets: readonly RulesetName[]): Finding[] =>
  findingsOf(stairMeasures(doc, stair), stair.id, rulesets);

export const checkSteelStair = (doc: CadDocument, stair: SteelStairElement, rulesets: readonly RulesetName[]): Finding[] =>
  findingsOf(steelStairMeasures(doc, stair), stair.id, rulesets);
