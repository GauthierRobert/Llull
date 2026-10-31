import type { Vec2, Vec3 } from '@core/model/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import type { RailingElement, SteelStairElement, SteelStairLanding, SteelStairTread } from '@aec/building/types';
import { appendElements, getBuilding, resolveLevel } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { levelIdParam } from '../../../building/levelParams';
import { findTwin, samePoint } from '../../../shared/duplicates';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import { refuse } from '../codes';
import { findGratingType } from '../grating/gratingTypes';
import { arrivalSurface, distanceToRing, walkingSurfaces } from '../ladder/ladderSurface';
import { DEFAULT_POST_SPACING_MM, railingDefaults } from '../railing/railingDefaults';
import { railingProblem } from '../railing/railingValidate';
import { RULESET_NAMES, ruleById, type RulesetName } from '../rules/ruleTable';
import { handrailPath, stairFlights } from './steelStairLayout';
import { stairGeometryMm, stairQuantities, stairSizes } from './steelStairMeasure';

const DEFAULT_STRINGER = 'UPN200';
const DEFAULT_GRATING = '19-W-4 1-1/4x3/16';
const DEFAULT_RAIL = 'CHS48.3x3.2';
/** Largest rise (30 m, a unit mistake beyond it), most risers, and the plan reach / vertical tolerance of the arrival surface, mm. */
const MAX_RISE_MM = 30_000;
const MAX_RISERS = 200;
const ARRIVAL_REACH_MM = 600;
const ARRIVAL_Z_MM = 50;

/** Largest of the active rulesets' stair width (ISO preferred, OSHA minimum), with the rows that decided it. */
function defaultWidthMm(rulesets: ReadonlyArray<RulesetName>): { value: number; basis: string } {
  const rows = [
    ...(rulesets.includes('iso_14122')
      ? [{ value: ruleById('ISO-STR-WIDTH').preferred ?? ruleById('ISO-STR-WIDTH').min ?? 0, id: 'ISO-STR-WIDTH preferred' }]
      : []),
    ...(rulesets.includes('osha_1910') ? [{ value: ruleById('OSHA-STR-WIDTH').min ?? 0, id: 'OSHA-STR-WIDTH minimum' }] : []),
  ];
  const best = rows.reduce((top, row) => (row.value > top.value ? row : top));
  return { value: best.value, basis: best.id };
}

/**
 * @affects creates 1 steel stair (stringers, treads, landings as entities on layer S-STAR) and one hand-rail element per requested side, hosted on it
 * @invariant n = ceil(rise / riserMax) equal risers of rise / n; treads = n - 1 - landings; run = treads x going + landing lengths; 2h + g is reported
 * @failure unknown toSurfaceId -> STA_UNKNOWN_ELEMENT; the top does not reach the surface -> STA_NO_ARRIVAL_SURFACE; unknown grating type -> STA_GRATING_TYPE_UNKNOWN; bad landings / profile / rise -> STA_INVALID_GEOMETRY
 */
export const addSteelStair = defineCommand({
  name: 'add_steel_stair',
  description:
    'Add a steel stringer stair (two stringers outside the clear width, grating or checker-plate treads, optional landings, optional hand-rails on either or both sides). Lengths in DOCUMENT UNITS, angle in RADIANS. ' +
    '`start` = [x, y, z] middle of the foot of the first riser (z relative to the level); the stair climbs toward `angle` (0 = +X). Give `rise` OR `toSurfaceId` (slab / grating id: the rise is computed and its top must be within 600 mm of the surface in plan). ' +
    'Risers: n = ceil(rise / riserMax), all equal (h = rise / n); treads = n - 1 - landings; run = treads x going + landing lengths; 2h + g (Blondel) and the pitch are returned. ' +
    'Landings: `landings` [{afterRiser, length?}] explicit, or `landingEvery` (maximum rise of a flight) which splits the stair into equal flights; every flight needs at least 2 risers. ' +
    'Unset values are named in data.defaults: width = the largest of ISO preferred 800 mm / OSHA minimum, stringerProfile UPN200, tread grating 19-W-4 1-1/4x3/16, landing length = max(width, OSHA landing 762 mm with osha_1910), railings none; ' +
    'hand-rail height = the highest top-rail row of the rulesets (1100 mm with both) with the fewest knee rails, no toe plate. Hand-rails are railing elements of role handrail, they follow the stair (move / delete) and check_access lists them as not evaluated. ' +
    'Stringers run first to last nosing of each flight (no base plates or end cuts). Result data: riserCount, treadCount, riserHeightMm, blondelMm, pitchDeg, runMm, widthMm, flights, landings, steelKg, railingIds, defaults. Run check_access.',
  params: z.object({
    start: vec3('Middle of the foot of the first riser [x, y, z], DOCUMENT UNITS; z relative to the level elevation.'),
    angle: z.number().optional().describe('Plan direction of the climb in RADIANS from +X, counter-clockwise. Default 0.'),
    rise: z
      .number()
      .positive()
      .optional()
      .describe('Total rise from the foot to the top walking surface, DOCUMENT UNITS. Give rise or toSurfaceId.'),
    toSurfaceId: z.string().optional().describe('Slab or grating element id at the top: the rise is computed from its top.'),
    width: z
      .number()
      .positive()
      .optional()
      .describe('Clear width between the stringers, DOCUMENT UNITS. Default from the rulesets (800 mm with both).'),
    riserMax: z
      .number()
      .positive()
      .describe(
        'Largest riser height, DOCUMENT UNITS; the riser count is the smallest that respects it (no default: choose it for the active rulesets).',
      ),
    going: z.number().positive().describe('Tread depth (nosing to nosing), DOCUMENT UNITS.'),
    stringerProfile: z.string().optional().describe('Steel catalogue name of the stringers (list_steel_profiles). Default UPN200.'),
    tread: z
      .object({
        kind: z.enum(['grating', 'checker_plate']).describe('"grating" needs gratingType, "checker_plate" needs thickness.'),
        gratingType: z.string().optional().describe('Catalogue key from list_grating_types (kind "grating").'),
        thickness: z.number().positive().optional().describe('Plate thickness, DOCUMENT UNITS (kind "checker_plate").'),
      })
      .optional()
      .describe(
        'Tread and landing surface: { kind: "grating", gratingType } or { kind: "checker_plate", thickness }. Default grating 19-W-4 1-1/4x3/16.',
      ),
    landings: z
      .array(
        z.object({
          afterRiser: z
            .number()
            .int()
            .min(2)
            .describe('The landing follows this riser (counted from 1 at the bottom); each flight needs 2+ risers.'),
          length: z.number().positive().optional().describe('Landing length along the climb, DOCUMENT UNITS. Default landingLength.'),
        }),
      )
      .optional()
      .describe('Explicit landings, ascending. Exclusive with landingEvery.'),
    landingEvery: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest rise of one flight, DOCUMENT UNITS: the stair is split into ceil(rise / landingEvery) equal flights with a landing between them.',
      ),
    landingLength: z
      .number()
      .positive()
      .optional()
      .describe('Length of landings without their own length, DOCUMENT UNITS. Default max(width, 762 mm with osha_1910).'),
    railings: z
      .enum(['none', 'left', 'right', 'both'])
      .optional()
      .describe('Hand-rails, left / right of the climb direction. Default none.'),
    railingHeight: z
      .number()
      .positive()
      .optional()
      .describe('Top of the hand-rail above the nosing line, DOCUMENT UNITS. Default from the rulesets.'),
    rulesets: z.array(z.enum(RULESET_NAMES)).min(1).optional().describe('Rulesets that decide the unset values. Default both.'),
    levelId: levelIdParam.describe('Level of the foot. Default: the active level.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
      refuse(doc, 'add_steel_stair', code, message, ids, paths);
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

    const stringerProfile = params.stringerProfile ?? DEFAULT_STRINGER;
    if (params.stringerProfile === undefined) defaulted.push(`stringerProfile ${DEFAULT_STRINGER}`);
    if (findProfile(stringerProfile) === undefined)
      return fail('STA_INVALID_GEOMETRY', `unknown stringer profile '${stringerProfile}' (list_steel_profiles)`, ['stringerProfile']);
    let tread: SteelStairTread;
    if (params.tread === undefined) {
      tread = { kind: 'grating', gratingType: DEFAULT_GRATING };
      defaulted.push(`tread grating ${DEFAULT_GRATING}`);
    } else if (params.tread.kind === 'grating' && params.tread.gratingType !== undefined && params.tread.thickness === undefined)
      tread = { kind: 'grating', gratingType: params.tread.gratingType };
    else if (params.tread.kind === 'checker_plate' && params.tread.thickness !== undefined && params.tread.gratingType === undefined)
      tread = { kind: 'checker_plate', thickness: params.tread.thickness };
    else return fail('STA_INVALID_GEOMETRY', 'tread: "grating" takes gratingType only, "checker_plate" takes thickness only', ['tread']);
    if (tread.kind === 'grating' && findGratingType(tread.gratingType) === undefined)
      return fail('STA_GRATING_TYPE_UNKNOWN', `unknown grating type '${tread.gratingType}' (list_grating_types)`, ['tread']);

    const surfaces = walkingSurfaces(model);
    let rise = params.rise;
    let target;
    if (params.toSurfaceId !== undefined) {
      target = surfaces.find((surface) => surface.id === params.toSurfaceId);
      if (target === undefined)
        return fail('STA_UNKNOWN_ELEMENT', `${params.toSurfaceId} is not a slab or grating`, ['toSurfaceId'], [params.toSurfaceId]);
      rise = target.top - (level.elevation + sz);
      if (!(rise > 0))
        return fail(
          'STA_NO_ARRIVAL_SURFACE',
          `${target.id} is not above the start (rise ${round(toMm(doc, rise), 1)} mm)`,
          ['toSurfaceId', 'start'],
          [target.id],
        );
    }
    const riseValue = rise as number;
    if (toMm(doc, riseValue) > MAX_RISE_MM)
      return fail('STA_INVALID_GEOMETRY', `rise ${round(toMm(doc, riseValue), 1)} mm is above 30 m: check the units`, ['rise']);
    const riserCount = Math.ceil(riseValue / params.riserMax - 1e-9);
    if (riserCount < 2)
      return fail(
        'STA_INVALID_GEOMETRY',
        `rise ${riseValue} with riserMax ${params.riserMax} gives ${riserCount} riser(s): a stair needs 2+`,
        ['riserMax'],
      );
    if (riserCount > MAX_RISERS)
      return fail('STA_INVALID_GEOMETRY', `${riserCount} risers: check the units of rise / riserMax`, ['riserMax']);
    const riserHeight = riseValue / riserCount;

    const widthPick = defaultWidthMm(rulesets);
    const width = params.width ?? mm(widthPick.value);
    if (params.width === undefined) defaulted.push(`width ${widthPick.value} mm (${widthPick.basis})`);
    const oshaLanding = rulesets.includes('osha_1910') ? (ruleById('OSHA-STR-LANDING').min ?? 0) : 0;
    const landingLength = params.landingLength ?? Math.max(width, mm(oshaLanding));

    let cuts: SteelStairLanding[] = [];
    if (params.landings !== undefined)
      cuts = params.landings.map((landing) => ({ afterRiser: landing.afterRiser, length: landing.length ?? landingLength }));
    else if (params.landingEvery !== undefined) {
      const flights = Math.ceil(riseValue / params.landingEvery - 1e-9);
      const perFlight = Math.ceil(riserCount / flights);
      for (let flight = 1; flight < flights; flight++) cuts.push({ afterRiser: flight * perFlight, length: landingLength });
    }
    if (cuts.some((landing) => landing.length === landingLength) && cuts.length > 0 && params.landingLength === undefined)
      defaulted.push(`landing length ${round(toMm(doc, landingLength), 1)} mm (max of width and the OSHA landing row)`);
    const flights = stairFlights(riserCount, cuts);
    if (
      cuts.some((landing, index) => index > 0 && landing.afterRiser <= (cuts[index - 1] as SteelStairLanding).afterRiser) ||
      flights.some((flight) => flight.lastRiser - flight.firstRiser + 1 < 2)
    )
      return fail(
        'STA_INVALID_GEOMETRY',
        `landings ${cuts.map((landing) => landing.afterRiser).join(', ')} are not ascending or leave a flight of fewer than 2 of ${riserCount} risers`,
        ['landings'],
      );

    const base = { start: [sx, sy, sz] as Vec3, angle, width, riserCount, riserHeight, going: params.going, landings: cuts };
    const sizes = stairSizes(doc, { stringerProfile });
    const runPlan = riserCount - 1 - cuts.length;
    const run = runPlan * params.going + cuts.reduce((sum, landing) => sum + landing.length, 0);
    const top: Vec2 = [sx + Math.cos(angle) * run, sy + Math.sin(angle) * run];
    const departure = level.elevation + sz;
    if (target !== undefined && distanceToRing(top, target.ring) > mm(ARRIVAL_REACH_MM))
      return fail(
        'STA_NO_ARRIVAL_SURFACE',
        `the top of the stair is ${round(toMm(doc, distanceToRing(top, target.ring)), 1)} mm from ${target.id} in plan (limit ${ARRIVAL_REACH_MM} mm): move start / angle`,
        ['start', 'angle', 'toSurfaceId'],
        [target.id],
      );
    const arrival = target ?? arrivalSurface(surfaces, top, departure + riseValue, mm(ARRIVAL_Z_MM), mm(ARRIVAL_REACH_MM));

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
