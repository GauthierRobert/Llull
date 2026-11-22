import type { Vec3 } from '@core/model/types';
import { defineCommand } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import type { RailingElement, SteelStairElement } from '@aec/building/types';
import { appendElements, getBuilding, resolveLevel } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { findTwin, samePoint } from '../../../shared/duplicates';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import { refuse } from '../codes';
import { DEFAULT_POST_SPACING_MM, railingDefaults } from '../railing/railingDefaults';
import { railingProblem } from '../railing/railingValidate';
import { RULESET_NAMES } from '../rules/ruleTable';
import { handrailPath, stairEnd } from './steelStairLayout';
import { stairGeometryMm, stairQuantities, stairSizes } from './steelStairMeasure';
import { stairParams } from './steelStairParams';
import { arrivalOf, landingsOf, riseOf, stringerAndTread, type Fail } from './steelStairPhases';

const DEFAULT_RAIL = 'CHS48.3x3.2';

/**
 * @affects creates 1 steel stair (stringers, treads, landings as entities on layer S-STAR) and one hand-rail element per requested side, hosted on it
 * @invariant n = ceil(rise / riserMax) equal risers of rise / n; treads = n - 1 - landings; run = treads x going + landing lengths; 2h + g is reported
 * @failure unknown toSurfaceId -> STA_UNKNOWN_ELEMENT; the top does not reach the surface -> STA_NO_ARRIVAL_SURFACE; unknown grating type -> STA_GRATING_TYPE_UNKNOWN; bad landings / profile / rise -> STA_INVALID_GEOMETRY
 */
export const addSteelStair = defineCommand({
  name: 'add_steel_stair',
  description:
    'Add a steel stringer stair (two stringers outside the clear width, grating or checker-plate treads, optional landings, optional hand-rails on either or both sides). Lengths in DOCUMENT UNITS, angle in RADIANS. ' +
    '`start` = [x, y, z] middle of the foot of the first riser (z relative to the level); the stair climbs toward `angle` (0 = +X). Give `rise` OR `toSurfaceId` (slab, grating or platform assembly id: the rise is computed and its top must be within 600 mm of the surface (a platform: of one of its panels) in plan). ' +
    'Risers: n = ceil(rise / riserMax), all equal (h = rise / n); treads = n - 1 - landings; run = treads x going + landing lengths; 2h + g (Blondel) and the pitch are returned. ' +
    'Landings: `landings` [{afterRiser, length?}] explicit, or `landingEvery` (maximum rise of a flight) which splits the stair into equal flights (`landingTurn`: one turn for all generated landings, or one per landing); every flight needs at least 2 risers. A landing may turn the stair: `turn` quarter_left / quarter_right (90 degrees, the next flight leaves through the side edge) or half_left / half_right (180 degrees, the next flight returns beside this one; the landing spans both), length >= width; run and flights stay path lengths, the hand-rails follow the landing, the top of the stair is where the last flight ends (data.runMm is the path length). ' +
    'Unset values are named in data.defaults: width = the largest of ISO preferred 800 mm / OSHA minimum, stringerProfile UPN200, tread grating 19-W-4 1-1/4x3/16, landing length = max(width, OSHA landing 762 mm with osha_1910), railings none; ' +
    'hand-rail height = the highest top-rail row of the rulesets (1100 mm with both) with the fewest knee rails, no toe plate. Hand-rails are railing elements of role handrail, they follow the stair (move / delete) and check_access lists them as not evaluated. ' +
    'Stringers run first to last nosing of each flight (no base plates or end cuts). Result data: riserCount, treadCount, riserHeightMm, blondelMm, pitchDeg, runMm, widthMm, flights, landings, steelKg, railingIds, defaults. Run check_access.',
  params: stairParams,
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, paths = [], ids = []) => refuse(doc, 'add_steel_stair', code, message, ids, paths);
    const building = getBuilding(doc);
    const resolution = resolveLevel(doc, building, params.levelId);
    if (!resolution.ok) return fail('STA_INVALID_GEOMETRY', resolution.reason, ['levelId']);
    const { level } = resolution;
    const model = resolution.building;
    if ((params.rise === undefined) === (params.toSurfaceId === undefined))
      return fail('STA_INVALID_GEOMETRY', 'give exactly one of rise or toSurfaceId', ['rise', 'toSurfaceId']);
    if (params.landings !== undefined && params.landingEvery !== undefined)
      return fail('STA_INVALID_GEOMETRY', 'give landings or landingEvery, not both', ['landings', 'landingEvery']);
    const mm = (value: number): number => fromMm(doc, value);
    const rulesets = params.rulesets ?? RULESET_NAMES;
    const defaulted: string[] = [];
    const [sx, sy, sz] = params.start;
    const angle = params.angle ?? 0;

    const parts = stringerAndTread(params, fail, defaulted);
    if (!parts.ok) return parts.result;
    const { stringerProfile, tread } = parts.value;
    const rise = riseOf(doc, params, resolution, fail);
    if (!rise.ok) return rise.result;
    const { riseValue, riserCount, riserHeight } = rise.value;
    const plan = landingsOf(doc, params, rise.value, fail, defaulted);
    if (!plan.ok) return plan.result;
    const { width, cuts } = plan.value;

    const base = { start: [sx, sy, sz] as Vec3, angle, width, riserCount, riserHeight, going: params.going, landings: cuts };
    const sizes = stairSizes(doc, { stringerProfile });
    const reached = arrivalOf(doc, params, resolution, rise.value, cuts, stairEnd(base, sizes), fail);
    if (!reached.ok) return reached.result;
    const { arrival, runPlan } = reached.value;

    const twin = findTwin(
      model,
      'steelStair',
      level.id,
      (element) => element.angle === angle && element.rise === riseValue && samePoint(element.start, base.start),
    );
    if (twin !== undefined)
      return fail(
        'STA_INVALID_GEOMETRY',
        `a steel stair from this start, angle and rise already exists as ${twin.id} (${twin.mark})`,
        [],
        [twin.id],
      );

    const sides = params.railings ?? 'none';
    const railDepthMm = findProfile(DEFAULT_RAIL)?.h ?? 0;
    const railDefaults = railingDefaults(rulesets, railDepthMm, false);
    const railingHeight = params.railingHeight ?? mm(railDefaults.heightMm);
    if (sides !== 'none') {
      if (params.railingHeight === undefined) defaulted.push(`railingHeight ${railDefaults.basis[0]}`);
      defaulted.push(`railing kneeRails ${railDefaults.kneeRails}, no toe plate, posts <= ${DEFAULT_POST_SPACING_MM} mm, ${DEFAULT_RAIL}`);
    }

    const added = appendElements(
      model,
      [0],
      'steelStair',
      (_, id, mark): SteelStairElement => ({
        id,
        category: 'steelStair',
        mark,
        entityIds: [],
        levelId: level.id,
        start: base.start,
        angle,
        rise: riseValue,
        width,
        riserCount,
        riserHeight,
        going: params.going,
        stringerProfile,
        tread,
        landings: cuts,
        ...(arrival === undefined ? {} : { arrivalSurfaceId: arrival.id }),
      }),
    );
    const stairId = added.ids[0] as string;
    const wanted: ReadonlyArray<1 | -1> = sides === 'both' ? [1, -1] : sides === 'left' ? [1] : sides === 'right' ? [-1] : [];
    const railingOf = (side: 1 | -1): Omit<RailingElement, 'id' | 'mark' | 'entityIds' | 'category' | 'levelId'> => ({
      path: handrailPath(base, sizes, side),
      height: railingHeight,
      kneeRails: railDefaults.kneeRails,
      toePlate: 0,
      postProfile: DEFAULT_RAIL,
      railProfile: DEFAULT_RAIL,
      postSpacingMax: mm(DEFAULT_POST_SPACING_MM),
      openings: [],
      role: 'handrail',
      host: { hostId: stairId, ring: 'boundary', edges: [side === 1 ? 0 : 1] },
    });
    for (const side of wanted) {
      const problem = railingProblem(doc, railingOf(side));
      if (problem !== null) return fail(problem.code, `hand-rail: ${problem.message}`, ['railingHeight']);
    }
    const withRails = appendElements(
      added.building,
      wanted,
      'railing',
      (side, id, mark): RailingElement => ({ id, category: 'railing', mark, entityIds: [], levelId: level.id, ...railingOf(side) }),
    );
    const result = commitBuilding(doc, withRails.building, [stairId, ...withRails.ids], (document) => {
      const mark = document.building?.elements[stairId]?.mark;
      const blondel = round(2 * toMm(doc, riserHeight) + toMm(doc, params.going), 2);
      return `Added steel stair ${mark} (${stairId}): ${round(toMm(doc, riseValue), 1)} mm rise, ${riserCount} risers of ${round(toMm(doc, riserHeight), 3)} mm, ${runPlan} tread(s) of ${round(toMm(doc, params.going), 1)} mm, 2h+g ${blondel} mm${cuts.length > 0 ? `, ${cuts.length} landing(s)` : ''}${withRails.ids.length > 0 ? `, hand-rails ${withRails.ids.join(', ')}` : ''}. ${defaulted.length > 0 ? `Defaults: ${defaulted.join('; ')}. ` : ''}Run check_access.`;
    });
    const element = result.document.building?.elements[stairId];
    if (element?.category !== 'steelStair') return result;
    const quantities = stairQuantities(result.document, element);
    const geometry = stairGeometryMm(result.document, element);
    return {
      ...result,
      data: {
        elementIds: [stairId, ...withRails.ids],
        stairId,
        railingIds: withRails.ids,
        riserCount,
        treadCount: quantities.treads,
        riserHeightMm: round(geometry.riser, 4),
        goingMm: round(geometry.going, 4),
        blondelMm: round(geometry.blondel, 4),
        pitchDeg: round(geometry.pitchDeg, 4),
        runMm: round(geometry.run, 4),
        widthMm: round(toMm(doc, width), 3),
        flights: quantities.layout.flights.map((flight) => flight.lastRiser - flight.firstRiser + 1),
        landings: cuts.map((landing) => ({ afterRiser: landing.afterRiser, lengthMm: round(toMm(doc, landing.length), 3) })),
        stringerKg: round(quantities.stringerKg, 3),
        treadKg: round(quantities.treadKg, 3),
        steelKg: round(quantities.steelKg, 3),
        arrivalSurfaceId: arrival?.id ?? null,
        defaults: defaulted,
      },
    };
  },
});
