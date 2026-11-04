/** Stable `STA_*` codes of the plant-structures plugin (06 STA §7) with their one-line fixes. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION = {
  STA_RULESET_UNKNOWN: 'Call list_access_rules to see the loaded rulesets (iso_14122, osha_1910).',
  STA_UNKNOWN_ELEMENT:
    'Pass ids of building elements of the right kind (describe_building, find_entities): check_access takes stairs, steel stairs, slabs, gratings, railings and ladders, check_grating and update_grating gratings, update_railing railings.',
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
  STA_NO_ARRIVAL_SURFACE:
    'Give climbHeight so that base + climbHeight reaches the top of a slab or grating within 50 mm and within 600 mm in plan of the ladder, or attachTo = the id of that surface.',
  STA_LADDER_PITCH_INFEASIBLE:
    'No uniform pitch satisfies every requested ruleset for this height: change climbHeight (or attachTo), pass rulesets with one ruleset, or give rungPitch and accept the finding.',
  STA_LADDER_PITCH_OUT_OF_RANGE: 'update_ladder { rungPitchMax } re-spaces the rungs so the pitch is uniform within the range.',
  STA_LADDER_WIDTH: 'update_ladder { clearWidth } to at least the limit.',
  STA_LADDER_BACK_CLEARANCE:
    'Move the ladder away from the object behind it (delete_building_element, add_ladder with another base), or move the object.',
  STA_LADDER_RAIL_EXTENSION: 'update_ladder { railExtension } to at least the limit.',
  STA_LADDER_FALL_PROTECTION_MISSING: 'update_ladder { fallProtection } cage, ladder_safety_system or pfas as the rulesets allow.',
  STA_LADDER_CAGE_NOT_PRIMARY: 'update_ladder { fallProtection: "ladder_safety_system" } (or "pfas").',
  STA_LADDER_CAGE_RETROFIT:
    'Plan the retrofit of the existing cage before 2036-11-18 (the date is under a proposed repeal); a reviewer decides, nothing to change in the model.',
  STA_LADDER_CAGE_START: 'update_ladder { cage: { startHeight } } inside the allowed band.',
  STA_LADDER_CAGE_GEOMETRY: 'update_ladder { cage: { hoopSpacing, diameter } } inside the limits.',
  STA_LADDER_LANDING_INTERVAL: 'update_ladder { landings } so no stretch between landings is longer than the limit.',
  STA_EQUIPMENT_NOT_VESSEL:
    'Pass the id of a vertical vessel (add_equipment shape vertical_vessel, or a plant vertical vessel); for any other deck use add_access_platform.',
  STA_OUTSIDE_SHELL: 'Give an elevation above the vessel base (level-relative) and not above its top: 0 < elevation <= the vessel height.',
  STA_PLATFORM_OVERLAP:
    'Move or reshape the platform (update_access_platform) so it does not overlap the named platform at the same elevation, or change its topOffset / elevation.',
  STA_PLATFORM_STALE:
    'The vessel or the beams the platform was derived from changed: update_access_platform { assemblyId } re-derives it (ids kept); the reason is in the finding.',
  STA_RACK_SPACING:
    'Give the rack a length with a bentSpacing (0 < bentSpacing <= length, bays wider than the column section) or ascending stations; widths and bays across likewise. Check the unit: lengths are DOCUMENT UNITS.',
  STA_RACK_TIERS:
    'Give tiers as strictly ascending top-of-steel elevations above grade (level-relative, document units), each more than the tier beam depth above the level and more than the beam depth apart.',
  STA_RACK_BRACING:
    'bracingBays are 1-based bay numbers (bay k lies between bent k and k + 1), each once, with a bracingProfile and struts other than none (the chords of a braced panel).',
  STA_RACK_STALE:
    'The pipe rack no longer matches the parameters it was derived from (a part was changed outside the generator): update_pipe_rack { assemblyId } re-derives it (ids kept); the reason is in the finding.',
  STA_STAIR_BLONDEL:
    'Change riserCount or treadDepth of the stair (a steel stair: update_steel_stair { riserMax, going }) so that 2 x riser + going is within the ISO range.',
  STA_STAIR_RISER: 'Increase riserCount (steel stair: lower riserMax) so the riser height drops under the limit.',
  STA_STAIR_TREAD: 'Increase treadDepth (steel stair: going) to at least the limit.',
  STA_STAIR_ANGLE: 'Change riserCount or treadDepth (steel stair: riserMax / going) so the pitch angle is within the limit.',
  STA_STAIR_WIDTH: 'Increase the stair width to at least the limit (steel stair: update_steel_stair { width }).',
  STA_STAIR_HEADROOM:
    'Raise the obstruction named in the finding location above the stair, or lower the stair (delete it and add_steel_stair again with another start or toSurfaceId): the free height over the pitch line must reach the limit.',
  STA_STAIR_FLIGHT_RISE:
    'Add an intermediate landing (add_stair landingAt, add_steel_stair landingEvery) so no flight rises more than the limit.',
  STA_EDGE_UNPROTECTED:
    'Protect the edge: add_railing { hostId, edges } (a railing below the top-rail minimum does not count: update_railing { height }) or a guard wall of at least 1100 mm.',
  STA_EDGE_RULE_UNSET: 'Pass edgeDropThresholdMm with its source (edgeDropSource): there is no graded drop-height rule to default to.',
  STA_NO_GRADE: 'The access graph starts at grade, the lowest building level: add_level first.',
  STA_ACCESS_GRAPH_LIMIT:
    'The model is larger than the access graph handles (surfaces, connectors, targets or contact tests): check fewer targets at a time, or reduce the number of loose grating panels (a platform assembly counts as one node).',
  STA_TARGETS_INVALID:
    'Give targets (explicit { tag, kind, point } in document units) and/or targetsFrom, and an operatingHeightMm band with min <= max and its source; targetsFrom needs a millimetre document.',
  STA_TARGET_DUPLICATE: 'Give every target a unique tag (the tag selects the target in the answer).',
  STA_TARGET_UNLOCATED:
    'The target has no operating point (a valve whose catalogue row has no stem height or stem direction): pass it as an explicit target with its point, or complete the catalogue row.',
  STA_OPERATING_HEIGHT:
    'Add a platform, stair or ladder so that the operating point is within the band above a walking surface, or move the operating point (the band is the project rule given as operatingHeightMm).',
  STA_REACH:
    'No walking surface lies at or below the operating point within maxHorizontalReachMm in plan: add a platform under it, or move the operating point.',
  STA_ACCESS_NO_EGRESS:
    'The walking surface has no route to grade (or fewer routes than egressRoutesRequired): add a ladder (add_ladder attachTo), a steel stair (add_steel_stair toSurfaceId) or a stair that reaches it.',
  STA_PLATFORM_WIDTH:
    'Widen the platform (update_access_platform { boundary } for a deck, { width } for a circular platform) to at least the limit.',
  STA_PLATFORM_HEADROOM:
    'Raise the obstruction above the platform, or lower the platform (update_access_platform { elevation }), to at least the limit.',
  STA_NOTHING_TO_DRAW:
    'Add access elements (platforms, gratings, ladders, steel stairs, railings) on the level, or drop the levelId filter.',
  STA_RULE_UNVERIFIED: 'The rule is grade B (not confirmed against the full standard): a reviewer confirms it against the standard text.',
} as const;

export type StaCode = keyof typeof REMEDIATION;

export const remediationOf = (code: StaCode): string => REMEDIATION[code];

export const refuse = tableRejection(REMEDIATION);
