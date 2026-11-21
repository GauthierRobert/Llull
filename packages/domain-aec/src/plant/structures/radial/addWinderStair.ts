import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import { levelIdParam } from '../../../building/levelParams';
import { round } from '../../../shared/numeric';
import { refuse } from '../codes';
import { RULESET_NAMES } from '../rules/ruleTable';
import { defaultWidthMm, stringerAndTread, type Fail } from '../stair/steelStairPhases';
import { stairSizes } from '../stair/steelStairMeasure';
import { secondFlightTreads, winderGeometry } from './radialLayout';
import { commitRadial, riseFor } from './radialCommit';

/**
 * @affects creates 1 radialStair element (form winder): treads and stringer runs as entities on layer S-STAR
 * @invariant n = ceil(rise / riserMax) equal risers; treads = n - 1 = straightTreads + winders + second-flight treads; the winders turn 90 degrees round the inner corner of a width x width square, each by 90 / winders degrees; no rule is checked (none cited)
 * @failure bad rise / riserMax / going / width / counts, no tread left for the second flight, unknown profile or grating -> STA_INVALID_GEOMETRY / STA_GRATING_TYPE_UNKNOWN
 */
export const addWinderStair = defineCommand({
  name: 'add_winder_stair',
  description:
    'Add a steel quarter-turn stair whose corner is winder (wedge) treads instead of a landing: a straight first flight, `winders` wedge treads turning 90 degrees round the inner corner of a width x width square, then a straight second flight leaving through the side edge. Lengths in DOCUMENT UNITS, angle in RADIANS. ' +
    '`start` = [x, y, z] middle of the foot of the first riser (z relative to the level); the first flight climbs toward `angle` (0 = +X) and the stair turns `turn` (left / right). Give `rise` and `riserMax`: n = ceil(rise / riserMax) equal risers, treads = n - 1 = straightTreads + winders + second-flight treads (the rest, at least 1). Tread i tops at i x h. ' +
    'Stringers: both sides of each straight flight and a sloped outer-edge run round the winder corner; the inner corner has no stringer joint (not modelled). Treads and stringer section as add_steel_stair (grating or checker_plate; stringerProfile default UPN200; width default = the largest of ISO preferred / OSHA minimum). ' +
    'No winder going, rise or walkline rule is cited in the repo sources, so none is checked: the result reports the winder angle and, with walklineOffset, the going on that walkline, without a verdict. Not a model of landings or hand-rails (add_railing on the edges). ' +
    'Result data: stairId, riserCount, treadCount, winders[] (index, angleDeg, goingAtWalklineMm), straightTreads, secondFlightTreads, steelKg, rules { evaluated: false }, defaults.',
  params: z.object({
    start: vec3('Middle of the foot of the first riser [x, y, z], DOCUMENT UNITS; z relative to the level elevation.'),
    angle: z.number().optional().describe('Plan direction of the first flight in RADIANS from +X, counter-clockwise. Default 0.'),
    rise: z.number().positive().describe('Total rise from the foot to the top walking surface, DOCUMENT UNITS.'),
    riserMax: z.number().positive().describe('Largest riser height, DOCUMENT UNITS; the riser count is the smallest that respects it.'),
    going: z.number().positive().describe('Depth of each straight tread (nosing to nosing), DOCUMENT UNITS.'),
    straightTreads: z.number().int().min(1).describe('Straight treads of the first flight, before the winders (integer, 1+).'),
    winders: z
      .number()
      .int()
      .min(2)
      .describe('Wedge treads that make the 90 degree turn (integer, 2+; one tread is a landing: use add_steel_stair).'),
    turn: z.enum(['left', 'right']).describe('Direction of the turn seen from above going up.'),
    width: z
      .number()
      .positive()
      .optional()
      .describe('Clear width of both flights = side of the winder square, DOCUMENT UNITS. Default from the rulesets (800 mm with both).'),
    walklineOffset: z
      .number()
      .positive()
      .optional()
      .describe(
        'Distance from the inner corner of the turn to the walkline, DOCUMENT UNITS (<= the width): reports the going of each winder on that arc. No limit is applied to it.',
      ),
    stringerProfile: z.string().optional().describe('Steel catalogue name of the stringers (list_steel_profiles). Default UPN200.'),
    tread: z
      .object({
        kind: z.enum(['grating', 'checker_plate']).describe('"grating" needs gratingType, "checker_plate" needs thickness.'),
        gratingType: z.string().optional().describe('Catalogue key from list_grating_types (kind "grating").'),
        thickness: z.number().positive().optional().describe('Plate thickness, DOCUMENT UNITS (kind "checker_plate").'),
      })
      .optional()
      .describe(
        'Tread surface: { kind: "grating", gratingType } or { kind: "checker_plate", thickness }. Default grating 19-W-4 1-1/4x3/16.',
      ),
    rulesets: z.array(z.enum(RULESET_NAMES)).min(1).optional().describe('Rulesets that decide the default width. Default both.'),
    levelId: levelIdParam.describe('Level of the foot. Default: the active level.'),
  }),
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, paths = [], ids = []) => refuse(doc, 'add_winder_stair', code, message, ids, paths);
    const invalid = (message: string, paths: string[] = []): CommandResult => fail('STA_INVALID_GEOMETRY', message, paths);
    const defaulted: string[] = [];
    const parts = stringerAndTread(params, fail, defaulted);
    if (!parts.ok) return parts.result;
    const { stringerProfile, tread } = parts.value;
    const rise = riseFor(doc, params.rise, params.riserMax, 2, invalid);
    if (!rise.ok) return rise.result;
    const { riserCount, riserHeight } = rise;
    const second = secondFlightTreads(riserCount, params.straightTreads, params.winders);
    if (second < 1)
      return invalid(
        `${riserCount} risers leave ${second} straight tread(s) for the second flight after ${params.straightTreads} + ${params.winders} winders: lower riserMax, straightTreads or winders`,
        ['straightTreads', 'winders'],
      );
    let width = params.width;
    if (width === undefined) {
      const basis = defaultWidthMm(params.rulesets ?? RULESET_NAMES);
      width = fromMm(doc, basis.value);
      defaulted.push(`width ${basis.value} mm (${basis.basis})`);
    }
    if (params.walklineOffset !== undefined && params.walklineOffset > width)
      return invalid(`walklineOffset ${params.walklineOffset} is wider than the stair (${width})`, ['walklineOffset']);
    const sizes = stairSizes(doc, { stringerProfile });
    const angle = params.angle === undefined ? 0 : params.angle;
    const geometry = winderGeometry({
      start: params.start,
      angle,
      sign: params.turn === 'left' ? 1 : -1,
      width,
      going: params.going,
      riserCount,
      riserHeight,
      straightTreads: params.straightTreads,
      winders: params.winders,
      stringerWeb: sizes.stringerWeb,
      stringerDepth: sizes.stringerDepth,
    });
    const sweepDeg = 90 / params.winders;
    const winders = Array.from({ length: params.winders }, (_, index) => ({
      index: index + 1,
      angleDeg: round(sweepDeg, 4),
      ...(params.walklineOffset === undefined
        ? {}
        : { goingAtWalklineMm: round(toMm(doc, params.walklineOffset) * ((sweepDeg * Math.PI) / 180), 3) }),
    }));
    return commitRadial(doc, {
      form: 'winder',
      name: 'add_winder_stair',
      start: params.start,
      angle,
      rise: params.rise,
      riserCount,
      riserHeight,
      width,
      turn: params.turn,
      profile: stringerProfile,
      tread,
      levelId: params.levelId,
      geometry,
      defaulted,
      extra: { winders, straightTreads: params.straightTreads, secondFlightTreads: second },
      extraSummary: `${params.straightTreads} straight + ${params.winders} winder (${round(sweepDeg, 2)} deg each, turn ${params.turn}) + ${second} straight treads`,
    });
  },
});
