/** Stable `STA_*` codes of the plant-structures plugin (06 STA §7) with their one-line fixes. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION = {
  STA_RULESET_UNKNOWN: 'Call list_access_rules to see the loaded rulesets (iso_14122, osha_1910).',
  STA_UNKNOWN_ELEMENT:
    'Pass ids of building elements of the right kind (describe_building, find_entities): check_access takes stairs, slabs, gratings and railings, check_grating and update_grating gratings, update_railing railings.',
  STA_INVALID_GEOMETRY:
    'Fix the geometry: finite numbers, a convex grating boundary of 3+ points or a railing path of 2+ distinct points, a non-zero bar direction.',
  STA_GRATING_TYPE_UNKNOWN: 'Call list_grating_types for the catalogue names.',
  STA_NO_SUPPORT_FOUND:
    'Put a beam under each end edge of the bars (add_grid_beams with topOffset = minus the grating depth), or pass the member ids in supportedBy.',
  STA_GRATING_TYPE_UNVERIFIED:
    'The type is not checked against a manufacturer table: a reviewer confirms mass and load tables with the manufacturer.',
  STA_GRATING_OVERSTRESS: 'Use deeper bars (update_grating gratingType) or add a support beam to shorten the span.',
  STA_GRATING_DEFLECTION:
    'Use deeper bars (update_grating gratingType), add a support beam, or relax the deflection limit with its source.',
  STA_GRATING_SPAN_DIRECTION: 'The bars are not perpendicular to a support: add_grating again with a bearingBarDirection across the beams.',
  STA_RAIL_OPENING:
    'Give openings as { from, to, gate } distances along the path (document units), inside 0..path length, ascending and not overlapping.',
  STA_RAIL_HEIGHT_LOW: 'update_railing { height } to at least the limit.',
  STA_RAIL_HEIGHT_HIGH:
    'update_railing { height } to at most the limit (a reviewer may accept a higher guard if every other criterion is met).',
  STA_RAIL_GAP: 'update_railing { kneeRails } adds rails until the clear space between rails, toe plate and top rail is within the limit.',
  STA_TOE_PLATE_MISSING: 'update_railing { toePlate } to at least the limit.',
  STA_STAIR_BLONDEL: 'Change riserCount or treadDepth of the stair so that 2 x riser + going is within the ISO range.',
  STA_STAIR_RISER: 'Increase riserCount so the riser height drops under the limit.',
  STA_STAIR_TREAD: 'Increase treadDepth to at least the limit.',
  STA_STAIR_ANGLE: 'Change riserCount or treadDepth so the pitch angle is within the limit.',
  STA_STAIR_WIDTH: 'Increase the stair width to at least the limit.',
  STA_STAIR_FLIGHT_RISE: 'Add an intermediate landing (add_stair landingAt) so no flight rises more than the limit.',
  STA_EDGE_UNPROTECTED:
    'Protect the edge: add_railing { hostId, edges } (a railing below the top-rail minimum does not count: update_railing { height }) or a guard wall of at least 1100 mm.',
  STA_EDGE_RULE_UNSET: 'Pass edgeDropThresholdMm with its source (edgeDropSource): there is no graded drop-height rule to default to.',
  STA_RULE_UNVERIFIED: 'The rule is grade B (not confirmed against the full standard): a reviewer confirms it against the standard text.',
} as const;

export type StaCode = keyof typeof REMEDIATION;

export const remediationOf = (code: StaCode): string => REMEDIATION[code];

export const refuse = tableRejection(REMEDIATION);
