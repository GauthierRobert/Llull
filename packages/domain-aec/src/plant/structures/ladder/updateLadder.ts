import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import type { LadderElement } from '@aec/building/types';
import { getBuilding, withElement } from '../../../building/model';
import { refuse } from '../codes';
import { RULESET_NAMES } from '../rules/ruleTable';
import { isIsoDate, ladderCageParam } from './addLadder';
import { liveBackClearance } from './ladderClearance';
import { type Fail, editedCage, editedRungs, ladderChanges, ladderUpdateResult, railingGate } from './updateLadderPhases';

/**
 * @affects replaces the given fields of one ladder in place (same id, mark and arrival surface) and regenerates its stiles, rungs, cage and landings; a through exit may cut or reuse a gated gap in the railing in front of it
 * @invariant base, facing, climbHeight, level and arrival surface are unchanged; rungs stay at k x pitch with rungCount = ceil(H / pitch) - 1; the back clearance is re-measured against the model; a cage that is switched on takes the ISO defaults for the values not given
 * @failure id that is not a ladder -> STA_UNKNOWN_ELEMENT; bad combination (cage options without a cage, both pitch fields, unascending landings, bad date, too many rungs, no feasible pitch) -> STA_INVALID_GEOMETRY / STA_LADDER_PITCH_INFEASIBLE; no field changes -> no-op
 */
export const updateLadder = defineCommand({
  name: 'update_ladder',
  description:
    'Change fields of an existing fixed ladder (add_ladder id) in place: the id, mark, position and arrival surface stay (to move it, delete it and add a new one). Lengths in DOCUMENT UNITS. ' +
    'Use it to fix check_access findings: clearWidth (STA_LADDER_WIDTH), railExtension (STA_LADDER_RAIL_EXTENSION), rungPitch or rungPitchMax (STA_LADDER_PITCH_OUT_OF_RANGE; the rungs are re-spaced: rungPitchMax gives pitch = H / ceil(H / max) with H the climb height), ' +
    'fallProtection (STA_LADDER_FALL_PROTECTION_MISSING; "cage" takes the ISO cage defaults for the values not in cage, any other value removes the cage), cage (start height, hoop spacing, diameter, bars: STA_LADDER_CAGE_*), landings (heights above the base; [] = none), exit, installedOn. ' +
    'Omitted fields stay. The back clearance is measured again. With exit "through" (given, or kept and clearWidth changed) the railing in front of the ladder gets its gated gap or keeps it (data.gate: cut / existing / none / skipped; a railing of a platform is read-only: the reason names update_access_platform). ' +
    'Result data: rungCount, rungPitchMm, clearWidthMm, fallProtection, backClearanceMm, changed, gate.',
  params: z.object({
    id: z.string().describe('Ladder element id.'),
    clearWidth: z.number().positive().optional().describe('Clear width between the stiles, DOCUMENT UNITS.'),
    rungPitch: z
      .number()
      .positive()
      .optional()
      .describe('Explicit rung pitch, DOCUMENT UNITS, kept as given and only checked. Exclusive with rungPitchMax.'),
    rungPitchMax: z
      .number()
      .positive()
      .optional()
      .describe('Largest allowed pitch, DOCUMENT UNITS; the pitch becomes H / ceil(H / rungPitchMax). Exclusive with rungPitch.'),
    exit: z
      .enum(['through', 'side_step'])
      .optional()
      .describe('"through" cuts / reuses a gated railing gap in front of the ladder; "side_step" does not (an existing gap stays).'),
    fallProtection: z
      .enum(['none', 'cage', 'ladder_safety_system', 'pfas'])
      .optional()
      .describe('Fall protection; a cage that is not there yet takes the ISO defaults, any other value drops the cage.'),
    cage: ladderCageParam,
    landings: z
      .array(z.number().positive())
      .optional()
      .describe('Heights of rest landings above the base, DOCUMENT UNITS, ascending and below the climb height; [] = none.'),
    railExtension: z.number().positive().optional().describe('Stile extension above the arrival level, DOCUMENT UNITS.'),
    installedOn: z.string().optional().describe('Installation date YYYY-MM-DD (OSHA 1910.28(b)(9)).'),
    rulesets: z
      .array(z.enum(RULESET_NAMES))
      .min(1)
      .optional()
      .describe('Rulesets whose pitch band rungPitchMax is planned in. Default both.'),
  }),
  run: (doc, params): CommandResult => {
    const { id } = params;
    const building = getBuilding(doc);
    const ladder = building.elements[id];
    const fail: Fail = (code, message, paths = []) => refuse(doc, 'update_ladder', code, message, [id], paths);
    if (ladder?.category !== 'ladder') return refuse(doc, 'update_ladder', 'STA_UNKNOWN_ELEMENT', `${id} is not a ladder`, [id], ['id']);
    if (params.rungPitch !== undefined && params.rungPitchMax !== undefined)
      return fail('STA_INVALID_GEOMETRY', 'give rungPitch or rungPitchMax, not both', ['rungPitch', 'rungPitchMax']);
    if (params.installedOn !== undefined && !isIsoDate(params.installedOn))
      return fail('STA_INVALID_GEOMETRY', `installedOn '${params.installedOn}' is not a YYYY-MM-DD date`, ['installedOn']);

    const rungs = editedRungs(doc, ladder, params, fail);
    if ('document' in rungs) return rungs;
    const { rungPitch, rungCount } = rungs;

    const fallProtection = params.fallProtection ?? ladder.fallProtection;
    if (params.cage !== undefined && fallProtection !== 'cage')
      return fail('STA_INVALID_GEOMETRY', `cage options need fallProtection "cage" (it is "${fallProtection}")`, [
        'cage',
        'fallProtection',
      ]);
    const cage = editedCage(doc, ladder, params, fallProtection);
    const landings = params.landings ?? ladder.landings;
    if (landings.some((value, index) => !(value < ladder.climbHeight) || (index > 0 && !(value > (landings[index - 1] as number)))))
      return fail('STA_INVALID_GEOMETRY', 'landings must be ascending heights below the climb height', ['landings']);

    const changes = ladderChanges(params);
    const { cage: _previousCage, ...rest } = ladder;
    const edited: LadderElement = {
      ...rest,
      ...changes,
      rungPitch,
      rungCount,
      fallProtection,
      landings,
      ...(cage === undefined ? {} : { cage }),
    };
    if (JSON.stringify(edited) === JSON.stringify(ladder))
      return noop(doc, `update_ladder: ${ladder.id} already has these values; nothing changed.`);
    const next: LadderElement = { ...edited, backClearance: liveBackClearance(doc, building, edited) };

    const gate = railingGate(doc, params, ladder, next, withElement(building, next));
    const names = Object.keys(changes).concat(
      params.rungPitchMax === undefined ? [] : ['rungPitchMax'],
      params.cage === undefined ? [] : ['cage'],
    );
    return ladderUpdateResult(doc, ladder, next, gate, names);
  },
});
