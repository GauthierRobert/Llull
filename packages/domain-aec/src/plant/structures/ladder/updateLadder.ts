import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import { fromMm, toMm } from '@core/model/units';
import type { LadderCage, LadderElement } from '@aec/building/types';
import { getBuilding, withElement } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { round } from '../../../shared/numeric';
import { refuse } from '../codes';
import { RULESET_NAMES } from '../rules/ruleTable';
import { MAX_RUNGS, isIsoDate, ladderCageParam } from './addLadder';
import { liveBackClearance } from './ladderClearance';
import { defaultCageMm, pitchRange, planPitch } from './ladderDefaults';
import { cutRailingGate } from './ladderGate';
import { ladderSizes } from './ladderMeasure';
import { walkingSurfaces } from './ladderSurface';

/** Plan reach of the railing search for a through-exit gate, as in add_ladder (§5.7), mm. */
const GATE_REACH_MM = 600;

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
    const fail = (code: Parameters<typeof refuse>[2], message: string, paths: string[] = []): CommandResult =>
      refuse(doc, 'update_ladder', code, message, [id], paths);
    if (ladder?.category !== 'ladder') return refuse(doc, 'update_ladder', 'STA_UNKNOWN_ELEMENT', `${id} is not a ladder`, [id], ['id']);
    if (params.rungPitch !== undefined && params.rungPitchMax !== undefined)
      return fail('STA_INVALID_GEOMETRY', 'give rungPitch or rungPitchMax, not both', ['rungPitch', 'rungPitchMax']);
    if (params.installedOn !== undefined && !isIsoDate(params.installedOn))
      return fail('STA_INVALID_GEOMETRY', `installedOn '${params.installedOn}' is not a YYYY-MM-DD date`, ['installedOn']);
    const mm = (value: number): number => fromMm(doc, value);

    let { rungPitch, rungCount } = ladder;
    if (params.rungPitch !== undefined) {
      rungPitch = params.rungPitch;
      rungCount = Math.max(0, Math.ceil(ladder.climbHeight / rungPitch - 1e-9) - 1);
    } else if (params.rungPitchMax !== undefined) {
      const range = pitchRange(params.rulesets ?? RULESET_NAMES);
      const plan = planPitch(toMm(doc, ladder.climbHeight), toMm(doc, params.rungPitchMax), range.min, range.basis);
      if (!plan.ok) return fail('STA_LADDER_PITCH_INFEASIBLE', plan.reason, ['rungPitchMax']);
      rungPitch = mm(plan.pitchMm);
      rungCount = plan.spaces - 1;
    }
    if (rungCount > MAX_RUNGS) return fail('STA_INVALID_GEOMETRY', `${rungCount} rungs: check the units of rungPitch`, ['rungPitch']);

    const fallProtection = params.fallProtection ?? ladder.fallProtection;
    if (params.cage !== undefined && fallProtection !== 'cage')
      return fail('STA_INVALID_GEOMETRY', `cage options need fallProtection "cage" (it is "${fallProtection}")`, [
        'cage',
        'fallProtection',
      ]);
    let cage: LadderCage | undefined;
    if (fallProtection === 'cage') {
      const named = defaultCageMm();
      const current = ladder.cage;
      const given = params.cage ?? {};
      cage = {
        startHeight: given.startHeight ?? current?.startHeight ?? mm(named.startHeight),
        hoopSpacing: given.hoopSpacing ?? current?.hoopSpacing ?? mm(named.hoopSpacing),
        diameter: given.diameter ?? current?.diameter ?? mm(named.diameter),
        bars: given.bars ?? current?.bars ?? named.bars,
      };
    }
    const landings = params.landings ?? ladder.landings;
    if (landings.some((value, index) => !(value < ladder.climbHeight) || (index > 0 && !(value > (landings[index - 1] as number)))))
      return fail('STA_INVALID_GEOMETRY', 'landings must be ascending heights below the climb height', ['landings']);

    const changes: Partial<Pick<LadderElement, 'clearWidth' | 'exit' | 'railExtension' | 'installedOn'>> = {
      ...(params.clearWidth === undefined ? {} : { clearWidth: params.clearWidth }),
      ...(params.exit === undefined ? {} : { exit: params.exit }),
      ...(params.railExtension === undefined ? {} : { railExtension: params.railExtension }),
      ...(params.installedOn === undefined ? {} : { installedOn: params.installedOn }),
    };
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

    let model = withElement(building, next);
    let gate: ReturnType<typeof cutRailingGate> = { building: model, status: 'none' };
    const arrival = walkingSurfaces(model).find((surface) => surface.id === ladder.arrivalSurfaceId);
    if (next.exit === 'through' && (params.exit !== undefined || params.clearWidth !== undefined) && arrival !== undefined) {
      gate = cutRailingGate(
        doc,
        model,
        {
          base: [next.base[0], next.base[1]],
          facing: next.facing,
          clearWidth: next.clearWidth,
          stileThickness: ladderSizes(doc).stileThickness,
        },
        arrival,
        mm(GATE_REACH_MM),
      );
      model = gate.building;
    }
    const names = Object.keys(changes).concat(
      params.rungPitchMax === undefined ? [] : ['rungPitchMax'],
      params.cage === undefined ? [] : ['cage'],
    );
    const result = commitBuilding(
      doc,
      model,
      gate.status === 'cut' && gate.railingId !== undefined ? [id, gate.railingId] : [id],
      `Updated ladder ${ladder.mark} (${id}): ${names.join(', ')}; ${rungCount} rung(s) at ${round(toMm(doc, rungPitch), 3)} mm, ${fallProtection}, back clearance ${round(toMm(doc, next.backClearance), 1)} mm. Gate: ${gate.status}${gate.reason === undefined ? '' : ` (${gate.reason})`}. Run check_access.`,
    );
    return {
      ...result,
      data: {
        elementIds: [id],
        changed: names,
        rungCount,
        rungPitchMm: round(toMm(doc, rungPitch), 4),
        clearWidthMm: round(toMm(doc, next.clearWidth), 3),
        fallProtection,
        backClearanceMm: round(toMm(doc, next.backClearance), 3),
        gate: {
          status: gate.status,
          ...(gate.railingId === undefined ? {} : { railingId: gate.railingId }),
          ...(gate.reason === undefined ? {} : { reason: gate.reason }),
        },
      },
    };
  },
});
