import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import { fromMm, toMm } from '@core/model/units';
import type { BuildingModel, RailingElement, SteelStairElement, SteelStairLanding, SteelStairTread } from '@aec/building/types';
import { elementsOf, getBuilding, withElement } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import { refuse } from '../codes';
import { findGratingType } from '../grating/gratingTypes';
import { distanceToRing, walkingSurfaces } from '../ladder/ladderSurface';
import { railingProblem } from '../railing/railingValidate';
import { ruleById } from '../rules/ruleTable';
import { handrailPath, stairFlights } from './steelStairLayout';
import { stairGeometryMm, stairSizes } from './steelStairMeasure';

const MAX_RISERS = 200;
/** Plan reach from the top of the stair to its arrival surface, mm (as in add_steel_stair). */
const ARRIVAL_REACH_MM = 600;

/** The hand-rails hosted on `stairId` (add_steel_stair railings), with the side each follows (+1 left, -1 right of the climb direction). */
function handrailsOf(building: BuildingModel, stairId: string): Array<{ railing: RailingElement; side: 1 | -1 }> {
  return elementsOf(building, 'railing').flatMap((railing) =>
    railing.host?.hostId === stairId && railing.role === 'handrail'
      ? [{ railing, side: railing.host.edges[0] === 1 ? (-1 as const) : (1 as const) }]
      : [],
  );
}

/**
 * @affects replaces the given fields of one steel stair in place (same id, mark, start, angle, rise and arrival surface), regenerates its stringers, treads and landings and re-lays the hand-rails hosted on it (same ids)
 * @invariant n = ceil(rise / riserMax) equal risers of rise / n; the foot, the direction and the rise are unchanged; each hand-rail keeps its side and its fields and follows the nosing line of the new layout
 * @failure id that is not a steel stair -> STA_UNKNOWN_ELEMENT; unknown profile / grating, bad landings or riser count, top further than 600 mm from the arrival surface in plan, a hand-rail that no longer validates -> STA_INVALID_GEOMETRY / STA_GRATING_TYPE_UNKNOWN / STA_NO_ARRIVAL_SURFACE; no field changes -> no-op
 */
export const updateSteelStair = defineCommand({
  name: 'update_steel_stair',
  description:
    'Change fields of an existing steel stair (add_steel_stair id) in place: the id, mark, start, angle, rise and arrival surface stay, and so do its hand-rail elements, which are re-laid along the new nosing line (to move the stair or change its rise, delete it and add a new one). ' +
    'Lengths in DOCUMENT UNITS. Use it to fix check_access findings: riserMax (the riser count becomes ceil(rise / riserMax), all risers equal: STA_STAIR_RISER, STA_STAIR_BLONDEL, STA_STAIR_ANGLE), going (STA_STAIR_TREAD, STA_STAIR_BLONDEL), ' +
    'width (STA_STAIR_WIDTH), landings or landingEvery (STA_STAIR_FLIGHT_RISE: explicit [{afterRiser, length?}] or one landing between equal flights), landingLength, stringerProfile, tread. ' +
    'Omitted fields stay; a change of riserMax or going that leaves a landing past the last riser, or a flight of fewer than 2 risers, is refused with the reason. The top must stay within 600 mm in plan of the arrival surface. ' +
    'Result data: riserCount, riserHeightMm, goingMm, blondelMm, pitchDeg, runMm, widthMm, flights, railingIds, changed.',
  params: z.object({
    id: z.string().describe('Steel stair element id.'),
    riserMax: z
      .number()
      .positive()
      .optional()
      .describe('Largest riser height, DOCUMENT UNITS; the riser count becomes ceil(rise / riserMax).'),
    going: z.number().positive().optional().describe('Tread depth (nosing to nosing), DOCUMENT UNITS.'),
    width: z.number().positive().optional().describe('Clear width between the stringers, DOCUMENT UNITS.'),
    stringerProfile: z.string().optional().describe('Steel catalogue name of the stringers (list_steel_profiles).'),
    tread: z
      .object({
        kind: z.enum(['grating', 'checker_plate']).describe('"grating" needs gratingType, "checker_plate" needs thickness.'),
        gratingType: z.string().optional().describe('Catalogue key from list_grating_types (kind "grating").'),
        thickness: z.number().positive().optional().describe('Plate thickness, DOCUMENT UNITS (kind "checker_plate").'),
      })
      .optional()
      .describe('Tread and landing surface: { kind: "grating", gratingType } or { kind: "checker_plate", thickness }.'),
    landings: z
      .array(
        z.object({
          afterRiser: z
            .number()
            .int()
            .min(2)
            .describe('The landing follows this riser (from 1 at the bottom); each flight needs 2+ risers.'),
          length: z.number().positive().optional().describe('Landing length along the climb, DOCUMENT UNITS. Default landingLength.'),
        }),
      )
      .optional()
      .describe('Explicit landings, ascending, replacing the current ones; [] = none. Exclusive with landingEvery.'),
    landingEvery: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest rise of one flight, DOCUMENT UNITS: the stair is split into ceil(rise / landingEvery) equal flights, replacing the current landings.',
      ),
    landingLength: z
      .number()
      .positive()
      .optional()
      .describe('Length of the landings that come without their own, DOCUMENT UNITS. Default max(width, the OSHA landing row 762 mm).'),
  }),
  run: (doc, params): CommandResult => {
    const { id } = params;
    const building = getBuilding(doc);
    const stair = building.elements[id];
    const fail = (code: Parameters<typeof refuse>[2], message: string, paths: string[] = [], ids: string[] = [id]): CommandResult =>
      refuse(doc, 'update_steel_stair', code, message, ids, paths);
    if (stair?.category !== 'steelStair')
      return refuse(doc, 'update_steel_stair', 'STA_UNKNOWN_ELEMENT', `${id} is not a steel stair`, [id], ['id']);
    if (params.landings !== undefined && params.landingEvery !== undefined)
      return fail('STA_INVALID_GEOMETRY', 'give landings or landingEvery, not both', ['landings', 'landingEvery']);
    const mm = (value: number): number => fromMm(doc, value);

    const stringerProfile = params.stringerProfile ?? stair.stringerProfile;
    if (findProfile(stringerProfile) === undefined)
      return fail('STA_INVALID_GEOMETRY', `unknown stringer profile '${stringerProfile}' (list_steel_profiles)`, ['stringerProfile']);
    let tread: SteelStairTread = stair.tread;
    if (params.tread !== undefined) {
      if (params.tread.kind === 'grating' && params.tread.gratingType !== undefined && params.tread.thickness === undefined)
        tread = { kind: 'grating', gratingType: params.tread.gratingType };
      else if (params.tread.kind === 'checker_plate' && params.tread.thickness !== undefined && params.tread.gratingType === undefined)
        tread = { kind: 'checker_plate', thickness: params.tread.thickness };
      else return fail('STA_INVALID_GEOMETRY', 'tread: "grating" takes gratingType only, "checker_plate" takes thickness only', ['tread']);
    }
    if (tread.kind === 'grating' && findGratingType(tread.gratingType) === undefined)
      return fail('STA_GRATING_TYPE_UNKNOWN', `unknown grating type '${tread.gratingType}' (list_grating_types)`, ['tread']);

    const riserCount = params.riserMax === undefined ? stair.riserCount : Math.ceil(stair.rise / params.riserMax - 1e-9);
    if (riserCount < 2)
      return fail('STA_INVALID_GEOMETRY', `riserMax ${params.riserMax} gives ${riserCount} riser(s): a stair needs 2+`, ['riserMax']);
    if (riserCount > MAX_RISERS) return fail('STA_INVALID_GEOMETRY', `${riserCount} risers: check the units of riserMax`, ['riserMax']);
    const width = params.width ?? stair.width;
    const going = params.going ?? stair.going;
    const oshaLanding = ruleById('OSHA-STR-LANDING').min ?? 0;
    const landingLength = params.landingLength ?? Math.max(width, mm(oshaLanding));

    let landings: SteelStairLanding[] = stair.landings;
    if (params.landings !== undefined)
      landings = params.landings.map((landing) => ({ afterRiser: landing.afterRiser, length: landing.length ?? landingLength }));
    else if (params.landingEvery !== undefined) {
      const flights = Math.ceil(stair.rise / params.landingEvery - 1e-9);
      const perFlight = Math.ceil(riserCount / flights);
      landings = Array.from({ length: flights - 1 }, (_, index) => ({ afterRiser: (index + 1) * perFlight, length: landingLength }));
    } else if (params.landingLength !== undefined)
      landings = landings.map((landing) => ({ afterRiser: landing.afterRiser, length: params.landingLength as number }));
    if (
      landings.some(
        (landing, index) =>
          landing.afterRiser >= riserCount || (index > 0 && landing.afterRiser <= (landings[index - 1] as SteelStairLanding).afterRiser),
      ) ||
      stairFlights(riserCount, landings).some((flight) => flight.lastRiser - flight.firstRiser + 1 < 2)
    )
      return fail(
        'STA_INVALID_GEOMETRY',
        `landings ${landings.map((landing) => landing.afterRiser).join(', ') || '(none)'} are not ascending, are past the last riser or leave a flight of fewer than 2 of ${riserCount} risers: give landings or landingEvery`,
        ['landings', 'riserMax'],
      );

    const edited: SteelStairElement = {
      ...stair,
      riserCount,
      riserHeight: stair.rise / riserCount,
      going,
      width,
      stringerProfile,
      tread,
      landings,
    };
    if (JSON.stringify(edited) === JSON.stringify(stair))
      return noop(doc, `update_steel_stair: ${stair.id} already has these values; nothing changed.`);

    const level = building.levels[stair.levelId];
    const run = (riserCount - 1 - landings.length) * going + landings.reduce((sum, landing) => sum + landing.length, 0);
    const top: [number, number] = [stair.start[0] + Math.cos(stair.angle) * run, stair.start[1] + Math.sin(stair.angle) * run];
    const arrival = walkingSurfaces(building).find((surface) => surface.id === stair.arrivalSurfaceId);
    if (level !== undefined && arrival !== undefined && distanceToRing(top, arrival.ring) > mm(ARRIVAL_REACH_MM))
      return fail(
        'STA_NO_ARRIVAL_SURFACE',
        `the top of the stair would be ${round(toMm(doc, distanceToRing(top, arrival.ring)), 1)} mm from ${arrival.id} in plan (limit ${ARRIVAL_REACH_MM} mm): the run changed by these values, adjust going / landings or delete the stair and add it again`,
        ['going', 'landings', 'riserMax'],
        [id, arrival.id],
      );

    const sizes = stairSizes(doc, { stringerProfile });
    let model = withElement(building, edited);
    const railingIds: string[] = [];
    for (const { railing, side } of handrailsOf(building, id)) {
      const next: RailingElement = { ...railing, path: handrailPath(edited, sizes, side) };
      const problem = railingProblem(doc, next);
      if (problem !== null) return fail(problem.code, `hand-rail ${railing.id}: ${problem.message}`, problem.paths, [id, railing.id]);
      model = withElement(model, next);
      railingIds.push(railing.id);
    }
    const names = (Object.keys(params) as Array<keyof typeof params>).filter((key) => key !== 'id' && params[key] !== undefined);
    const result = commitBuilding(doc, model, [id, ...railingIds], (document) => {
      const geometry = stairGeometryMm(document, edited);
      return `Updated steel stair ${stair.mark} (${id}): ${names.join(', ')}; ${riserCount} risers of ${round(geometry.riser, 3)} mm, going ${round(geometry.going, 1)} mm, 2h+g ${round(geometry.blondel, 2)} mm, pitch ${round(geometry.pitchDeg, 2)} deg${railingIds.length > 0 ? `, hand-rails ${railingIds.join(', ')} re-laid` : ''}. Run check_access.`;
    });
    const geometry = stairGeometryMm(result.document, edited);
    return {
      ...result,
      data: {
        elementIds: [id, ...railingIds],
        railingIds,
        changed: names,
        riserCount,
        riserHeightMm: round(geometry.riser, 4),
        goingMm: round(geometry.going, 4),
        blondelMm: round(geometry.blondel, 4),
        pitchDeg: round(geometry.pitchDeg, 4),
        runMm: round(geometry.run, 4),
        widthMm: round(toMm(doc, width), 3),
        flights: stairFlights(riserCount, landings).map((flight) => flight.lastRiser - flight.firstRiser + 1),
      },
    };
  },
});
