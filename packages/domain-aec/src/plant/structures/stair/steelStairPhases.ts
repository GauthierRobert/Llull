/** add_steel_stair phases: stringer and tread, the rise and risers, width and landings, and the arrival surface. */

import type { Vec2 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import type { SteelStairLanding, SteelStairTread, SteelStairTurn } from '@aec/building/types';
import type { resolveLevel } from '../../../building/model';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import type { refuse } from '../codes';
import { findGratingType } from '../grating/gratingTypes';
import { arrivalSurface, distanceToRing, namedSurfaces, nearestSurface, walkingSurfaces } from '../ladder/ladderSurface';
import { ruleById, RULESET_NAMES, type RulesetName } from '../rules/ruleTable';
import { stairFlights } from './steelStairLayout';
import type { StairParams } from './steelStairParams';

const DEFAULT_STRINGER = 'UPN200';
const DEFAULT_GRATING = '19-W-4 1-1/4x3/16';
/** Largest rise (30 m, a unit mistake beyond it), most risers, and the plan reach / vertical tolerance of the arrival surface, mm. */
const MAX_RISE_MM = 30_000;
const MAX_RISERS = 200;
const ARRIVAL_REACH_MM = 600;
const ARRIVAL_Z_MM = 50;

export type Fail = (code: Parameters<typeof refuse>[2], message: string, paths?: string[], ids?: string[]) => CommandResult;

type Resolved = Extract<ReturnType<typeof resolveLevel>, { readonly ok: true }>;
type Surface = NonNullable<ReturnType<typeof nearestSurface>>;

export type Phase<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: CommandResult };
const proceed = <T>(value: T): Phase<T> => ({ ok: true, value });
const stop = (result: CommandResult): Phase<never> => ({ ok: false, result });

/** Largest of the active rulesets' stair width (ISO preferred, OSHA minimum), with the rows that decided it. */
export function defaultWidthMm(rulesets: ReadonlyArray<RulesetName>): { value: number; basis: string } {
  const rows = [
    ...(rulesets.includes('iso_14122')
      ? [{ value: ruleById('ISO-STR-WIDTH').preferred ?? ruleById('ISO-STR-WIDTH').min ?? 0, id: 'ISO-STR-WIDTH preferred' }]
      : []),
    ...(rulesets.includes('osha_1910') ? [{ value: ruleById('OSHA-STR-WIDTH').min ?? 0, id: 'OSHA-STR-WIDTH minimum' }] : []),
  ];
  const best = rows.reduce((top, row) => (row.value > top.value ? row : top));
  return { value: best.value, basis: best.id };
}

/** The stringer profile and tread surface (named defaults recorded on `defaulted`), or the refusal for an unknown or contradictory one. */
export function stringerAndTread(
  params: Pick<StairParams, 'stringerProfile' | 'tread'>,
  fail: Fail,
  defaulted: string[],
): Phase<{ stringerProfile: string; tread: SteelStairTread }> {
  const stringerProfile = params.stringerProfile ?? DEFAULT_STRINGER;
  if (params.stringerProfile === undefined) defaulted.push(`stringerProfile ${DEFAULT_STRINGER}`);
  if (findProfile(stringerProfile) === undefined)
    return stop(fail('STA_INVALID_GEOMETRY', `unknown stringer profile '${stringerProfile}' (list_steel_profiles)`, ['stringerProfile']));
  let tread: SteelStairTread;
  if (params.tread === undefined) {
    tread = { kind: 'grating', gratingType: DEFAULT_GRATING };
    defaulted.push(`tread grating ${DEFAULT_GRATING}`);
  } else if (params.tread.kind === 'grating' && params.tread.gratingType !== undefined && params.tread.thickness === undefined)
    tread = { kind: 'grating', gratingType: params.tread.gratingType };
  else if (params.tread.kind === 'checker_plate' && params.tread.thickness !== undefined && params.tread.gratingType === undefined)
    tread = { kind: 'checker_plate', thickness: params.tread.thickness };
  else
    return stop(fail('STA_INVALID_GEOMETRY', 'tread: "grating" takes gratingType only, "checker_plate" takes thickness only', ['tread']));
  if (tread.kind === 'grating' && findGratingType(tread.gratingType) === undefined)
    return stop(fail('STA_GRATING_TYPE_UNKNOWN', `unknown grating type '${tread.gratingType}' (list_grating_types)`, ['tread']));
  return proceed({ stringerProfile, tread });
}

export interface RiseSetup {
  readonly surfaces: ReturnType<typeof walkingSurfaces>;
  readonly named: ReturnType<typeof namedSurfaces>;
  readonly target: Surface | undefined;
  readonly riseValue: number;
  readonly riserCount: number;
  readonly riserHeight: number;
}

/** The total rise (given, or up to the named surface), the equal risers it needs and their height, or a refusal. */
export function riseOf(doc: Parameters<typeof fromMm>[0], params: StairParams, resolution: Resolved, fail: Fail): Phase<RiseSetup> {
  const { level } = resolution;
  const model = resolution.building;
  const [sx, sy, sz] = params.start;
  const surfaces = walkingSurfaces(model);
  let rise = params.rise;
  let target: Surface | undefined;
  const named = params.toSurfaceId === undefined ? [] : namedSurfaces(model, surfaces, params.toSurfaceId);
  if (params.toSurfaceId !== undefined) {
    target = nearestSurface(named, [sx, sy]);
    if (target === undefined)
      return stop(
        fail('STA_UNKNOWN_ELEMENT', `${params.toSurfaceId} is not a slab, grating or platform`, ['toSurfaceId'], [params.toSurfaceId]),
      );
    rise = target.top - (level.elevation + sz);
    if (!(rise > 0))
      return stop(
        fail(
          'STA_NO_ARRIVAL_SURFACE',
          `${target.id} is not above the start (rise ${round(toMm(doc, rise), 1)} mm)`,
          ['toSurfaceId', 'start'],
          [target.id],
        ),
      );
  }
  const riseValue = rise as number;
  if (toMm(doc, riseValue) > MAX_RISE_MM)
    return stop(fail('STA_INVALID_GEOMETRY', `rise ${round(toMm(doc, riseValue), 1)} mm is above 30 m: check the units`, ['rise']));
  const riserCount = Math.ceil(riseValue / params.riserMax - 1e-9);
  if (riserCount < 2)
    return stop(
      fail('STA_INVALID_GEOMETRY', `rise ${riseValue} with riserMax ${params.riserMax} gives ${riserCount} riser(s): a stair needs 2+`, [
        'riserMax',
      ]),
    );
  if (riserCount > MAX_RISERS)
    return stop(fail('STA_INVALID_GEOMETRY', `${riserCount} risers: check the units of rise / riserMax`, ['riserMax']));
  return proceed({ surfaces, named, target, riseValue, riserCount, riserHeight: riseValue / riserCount });
}

/** A landing record from its parameters: the length defaults to `fallback`, `turn` is kept only when given. */
export const landingOf = (
  landing: { afterRiser: number; length?: number | undefined; turn?: SteelStairTurn | undefined },
  fallback: number,
): SteelStairLanding => ({
  afterRiser: landing.afterRiser,
  length: landing.length ?? fallback,
  ...(landing.turn === undefined ? {} : { turn: landing.turn }),
});

/** The landings `landingEvery` generates: ceil(rise / landingEvery) equal flights with `length` landings between them, turned per `landingTurn`; or the refusal. */
export function everyLandings(
  rise: number,
  riserCount: number,
  landingEvery: number,
  length: number,
  landingTurn: StairParams['landingTurn'],
  fail: Fail,
): Phase<SteelStairLanding[]> {
  const flights = Math.ceil(rise / landingEvery - 1e-9);
  const perFlight = Math.ceil(riserCount / flights);
  const count = flights - 1;
  if (Array.isArray(landingTurn) && landingTurn.length !== count)
    return stop(
      fail(
        'STA_INVALID_GEOMETRY',
        `landingTurn lists ${landingTurn.length} turn(s) but landingEvery gives ${flights} flight(s), ${count} landing(s)`,
        ['landingTurn', 'landingEvery'],
      ),
    );
  if (typeof landingTurn === 'string' && count === 0)
    return stop(
      fail('STA_INVALID_GEOMETRY', `landingTurn ${landingTurn} but landingEvery gives 1 flight, no landing to turn`, ['landingTurn']),
    );
  const cuts = Array.from({ length: count }, (_, index): SteelStairLanding => {
    const turn = Array.isArray(landingTurn) ? landingTurn[index] : landingTurn;
    return { afterRiser: (index + 1) * perFlight, length, ...(turn === undefined || turn === 'straight' ? {} : { turn }) };
  });
  return proceed(cuts);
}

/** The clear width and the landings (explicit, or splitting the rise into equal flights); named defaults go on `defaulted`; bad landings are refused. */
export function landingsOf(
  doc: Parameters<typeof fromMm>[0],
  params: StairParams,
  rise: RiseSetup,
  fail: Fail,
  defaulted: string[],
): Phase<{ width: number; cuts: SteelStairLanding[] }> {
  const { riseValue, riserCount } = rise;
  const mm = (value: number): number => fromMm(doc, value);
  const rulesets = params.rulesets ?? RULESET_NAMES;
  const widthPick = defaultWidthMm(rulesets);
  const width = params.width ?? mm(widthPick.value);
  if (params.width === undefined) defaulted.push(`width ${widthPick.value} mm (${widthPick.basis})`);
  const oshaLanding = rulesets.includes('osha_1910') ? (ruleById('OSHA-STR-LANDING').min ?? 0) : 0;
  const landingLength = params.landingLength ?? Math.max(width, mm(oshaLanding));

  let cuts: SteelStairLanding[] = [];
  if (params.landingTurn !== undefined && params.landingEvery === undefined)
    return stop(
      fail('STA_INVALID_GEOMETRY', 'landingTurn turns the landings of landingEvery: give landingEvery, or put turn on each landings[]', [
        'landingTurn',
      ]),
    );
  if (params.landings !== undefined) cuts = params.landings.map((landing) => landingOf(landing, landingLength));
  else if (params.landingEvery !== undefined) {
    const every = everyLandings(riseValue, riserCount, params.landingEvery, landingLength, params.landingTurn, fail);
    if (!every.ok) return every;
    cuts = every.value;
  }
  if (cuts.some((landing) => landing.length === landingLength) && cuts.length > 0 && params.landingLength === undefined)
    defaulted.push(`landing length ${round(toMm(doc, landingLength), 1)} mm (max of width and the OSHA landing row)`);
  const narrow = cuts.find((landing) => landing.turn !== undefined && landing.length < width);
  if (narrow !== undefined)
    return stop(
      fail(
        'STA_INVALID_GEOMETRY',
        `the ${narrow.turn} landing after riser ${narrow.afterRiser} is ${round(toMm(doc, narrow.length), 1)} mm long, less than the stair width ${round(toMm(doc, width), 1)} mm: a turning landing needs length >= width`,
        ['landings'],
      ),
    );
  const flights = stairFlights(riserCount, cuts);
  if (
    cuts.some((landing, index) => index > 0 && landing.afterRiser <= (cuts[index - 1] as SteelStairLanding).afterRiser) ||
    flights.some((flight) => flight.lastRiser - flight.firstRiser + 1 < 2)
  )
    return stop(
      fail(
        'STA_INVALID_GEOMETRY',
        `landings ${cuts.map((landing) => landing.afterRiser).join(', ')} are not ascending or leave a flight of fewer than 2 of ${riserCount} risers`,
        ['landings'],
      ),
    );
  return proceed({ width, cuts });
}

/** The surface the stair top arrives on and the number of treads; a named surface that the top misses in plan is refused. */
export function arrivalOf(
  doc: Parameters<typeof fromMm>[0],
  params: StairParams,
  resolution: Resolved,
  rise: RiseSetup,
  cuts: readonly SteelStairLanding[],
  top: Vec2,
  fail: Fail,
): Phase<{ arrival: Surface | undefined; runPlan: number }> {
  const { level } = resolution;
  const sz = params.start[2];
  const mm = (value: number): number => fromMm(doc, value);
  const runPlan = rise.riserCount - 1 - cuts.length;
  const departure = level.elevation + sz;
  const reached = nearestSurface(rise.named, top);
  if (rise.target !== undefined && reached !== undefined && distanceToRing(top, reached.ring) > mm(ARRIVAL_REACH_MM))
    return stop(
      fail(
        'STA_NO_ARRIVAL_SURFACE',
        `the top of the stair is ${round(toMm(doc, distanceToRing(top, reached.ring)), 1)} mm from ${params.toSurfaceId} in plan (limit ${ARRIVAL_REACH_MM} mm): move start / angle`,
        ['start', 'angle', 'toSurfaceId'],
        [rise.target.id],
      ),
    );
  const arrival = reached ?? arrivalSurface(rise.surfaces, top, departure + rise.riseValue, mm(ARRIVAL_Z_MM), mm(ARRIVAL_REACH_MM));
  return proceed({ arrival, runPlan });
}
