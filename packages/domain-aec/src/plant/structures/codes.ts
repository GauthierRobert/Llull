/** Stable `STA_*` codes of the plant-structures plugin (06 STA §7) with their one-line fixes. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION = {
  STA_RULESET_UNKNOWN: 'Call list_access_rules to see the loaded rulesets (iso_14122, osha_1910).',
  STA_UNKNOWN_ELEMENT: 'Pass ids of building elements (describe_building, find_entities); stairs and slabs are checked in M1.',
  STA_STAIR_BLONDEL: 'Change riserCount or treadDepth of the stair so that 2 x riser + going is within the ISO range.',
  STA_STAIR_RISER: 'Increase riserCount so the riser height drops under the limit.',
  STA_STAIR_TREAD: 'Increase treadDepth to at least the limit.',
  STA_STAIR_ANGLE: 'Change riserCount or treadDepth so the pitch angle is within the limit.',
  STA_STAIR_WIDTH: 'Increase the stair width to at least the limit.',
  STA_STAIR_FLIGHT_RISE: 'Add an intermediate landing (add_stair landingAt) so no flight rises more than the limit.',
  STA_EDGE_UNPROTECTED:
    'Protect the edge: a guard wall of at least 1100 mm now, add_railing { hostId, edges } once railings are available.',
  STA_EDGE_RULE_UNSET: 'Pass edgeDropThresholdMm with its source (edgeDropSource): there is no graded drop-height rule to default to.',
  STA_RULE_UNVERIFIED: 'The rule is grade B (not confirmed against the full standard): a reviewer confirms it against the standard text.',
} as const;

export type StaCode = keyof typeof REMEDIATION;

export const remediationOf = (code: StaCode): string => REMEDIATION[code];

export const refuse = tableRejection(REMEDIATION);
