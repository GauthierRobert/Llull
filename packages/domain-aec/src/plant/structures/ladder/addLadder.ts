import type { Vec2 } from '@core/model/types';
import { defineCommand, vec2, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import type { LadderCage, LadderElement, LadderFallProtection } from '@aec/building/types';
import { appendElements, getBuilding, resolveLevel } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { levelIdParam } from '../../../building/levelParams';
import { findTwin, samePoint } from '../../../shared/duplicates';
import { round } from '../../../shared/numeric';
import { refuse } from '../codes';
import { RULESET_NAMES } from '../rules/ruleTable';
import { backClearance, BACK_SEARCH_MM } from './ladderClearance';
import {
  defaultCageMm,
  defaultClearWidthMm,
  defaultFallProtection,
  defaultLandingsMm,
  defaultRailExtensionMm,
  pitchRange,
  planPitch,
} from './ladderDefaults';
import { cutRailingGate } from './ladderGate';
import { ladderQuantities, ladderSizes } from './ladderMeasure';
import { arrivalSurface, distanceToRing, walkingSurfaces } from './ladderSurface';

/** Vertical tolerance between the top of the climb and the arrival surface, and plan reach from the ladder to it, mm (§5.7). */
const ARRIVAL_Z_MM = 50;
const ARRIVAL_REACH_MM = 600;
/** More rungs than this is a unit mistake (a pitch in metres), not a ladder. */
const MAX_RUNGS = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (text: string): boolean => ISO_DATE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`));

/**
 * @affects creates 1 ladder element (stiles, rungs, cage hoops / bars and landing plates as entities on layer S-LADR) and, for a through exit, a gap with a gate in the railing in front of it
 * @invariant rungs at k x pitch, k = 1..rungCount; resolved pitch: spaces = ceil(H / pitchMax), pitch = H / spaces, rungCount = spaces - 1; the arrival level is the last step
 * @failure no arrival surface within 50 mm of the top and 600 mm in plan -> STA_NO_ARRIVAL_SURFACE; no uniform pitch in the requested rulesets -> STA_LADDER_PITCH_INFEASIBLE; unknown attachTo -> STA_UNKNOWN_ELEMENT; other bad input -> STA_INVALID_GEOMETRY
 */
export const addLadder = defineCommand({
  name: 'add_ladder',
  description:
    'Add a fixed vertical ladder (flat-bar stiles FL70x10, round rungs RD20) from `base` up to a slab or grating panel (the arrival surface). Lengths in DOCUMENT UNITS. ' +
    '`base` = [x, y, z] middle of the ladder at the departure level (z relative to the level; grade = the level elevation). `facing` = plan direction the climber faces, toward the structure ([0, 1] = +Y). ' +
    'Give `climbHeight` (the surface top must be within 50 mm of base z + climbHeight and within 600 mm in plan) OR `attachTo` (slab / grating id: the height is computed). ' +
    'Unset values follow the rulesets (default both iso_14122 and osha_1910) and are named in data.defaults: rungPitchMax = the smallest pitch maximum (300 mm with both) so spaces = ceil(H / pitchMax), pitch = H / spaces, rungCount = spaces - 1 ' +
    '(rungPitch instead keeps your pitch, rungs at k x pitch, and check_access judges it; the last step to the arrival may then be shorter); clearWidth and railExtension = the largest minimum; ' +
    'fallProtection = ladder_safety_system above 24 ft for OSHA ladders installed from 2018-11-19, else a cage from ISO 3000 mm, else none; a cage starts at 2200 mm with hoops at <= 1500 mm, 650 mm inside diameter, 5 bars (ISO 14122-4 rows, grade A/B); ' +
    'landings every <= 15 240 mm for a cage (OSHA 50 ft) or <= 45 720 mm for ladder_safety_system / pfas (OSHA, grade B), only with osha_1910. `installedOn` (ISO date) drives the OSHA 2018-11-19 rule; unset = checked as installed after it. ' +
    'exit "through" (default) cuts a gap with a self-closing gate in the guard-rail of the arrival level that is in front of the ladder (within 600 mm); "side_step" cuts none. ' +
    'The back clearance (rung centre to the nearest wall, column, steel member, equipment or other slab / grating behind it, searched up to 2000 mm) is measured now and stored. Landings are plates without railing. ' +
    'Result data: rungCount, rungPitchMm, clearWidthMm, fallProtection, cage { startHeightMm, hoopSpacingMm, diameterMm, bars }, landingsMm, railExtensionMm, backClearanceMm, steelKg, gate, defaults. Run check_access.',
  params: z.object({
    base: vec3('Middle of the ladder at the departure level [x, y, z], DOCUMENT UNITS; z relative to the level elevation.'),
    facing: vec2('Plan direction the climber faces, toward the structure, e.g. [0, 1]. Not zero.'),
    climbHeight: z
      .number()
      .positive()
      .optional()
      .describe('Height from base to the top of the arrival surface, DOCUMENT UNITS. Give climbHeight or attachTo.'),
    attachTo: z.string().optional().describe('Slab or grating element id the ladder arrives on; climbHeight is computed from its top.'),
    clearWidth: z
      .number()
      .positive()
      .optional()
      .describe('Clear width between the stiles, DOCUMENT UNITS. Default: the largest minimum of the rulesets (406.4 mm with both).'),
    rungPitch: z
      .number()
      .positive()
      .optional()
      .describe('Explicit rung pitch, DOCUMENT UNITS, kept as given and only checked. Exclusive with rungPitchMax.'),
    rungPitchMax: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest allowed pitch, DOCUMENT UNITS; the pitch is then H / ceil(H / rungPitchMax). Default: the smallest ruleset maximum.',
      ),
    exit: z
      .enum(['through', 'side_step'])
      .optional()
      .describe('"through" (default) cuts a railing gap with a gate in front of the ladder; "side_step" does not.'),
    fallProtection: z
      .enum(['none', 'cage', 'ladder_safety_system', 'pfas'])
      .optional()
      .describe('Fall protection. Default from the rulesets and the height (see the description).'),
    cage: z
      .object({
        startHeight: z
          .number()
          .positive()
          .optional()
          .describe('First hoop above the base, DOCUMENT UNITS. Default 2200 mm (ISO-LAD-CAGE-START minimum).'),
        hoopSpacing: z
          .number()
          .positive()
          .optional()
          .describe('Largest distance between hoops, DOCUMENT UNITS. Default 1500 mm (ISO-LAD-CAGE-HOOP, grade B).'),
        diameter: z
          .number()
          .positive()
          .optional()
          .describe('Inside cage diameter, DOCUMENT UNITS. Default 650 mm (ISO-LAD-CAGE-DIAM, grade B).'),
        bars: z.number().int().min(2).max(12).optional().describe('Vertical bars across the cage arc. Default 5.'),
      })
      .optional()
      .describe('Cage dimensions; only with fallProtection "cage".'),
    landings: z
      .array(z.number().positive())
      .optional()
      .describe(
        'Heights of rest landings above the base, DOCUMENT UNITS, ascending and below the climb height; [] = none. Default: generated from OSHA intervals.',
      ),
    railExtension: z
      .number()
      .positive()
      .optional()
      .describe(
        'Stile extension above the arrival level, DOCUMENT UNITS. Default: the largest minimum of the rulesets (1100 mm with both).',
      ),
    installedOn: z
      .string()
      .optional()
      .describe('Installation date YYYY-MM-DD; OSHA 1910.28(b)(9) depends on it. Unset = checked as installed after 2018-11-19.'),
    rulesets: z.array(z.enum(RULESET_NAMES)).min(1).optional().describe('Rulesets that decide the unset values. Default both.'),
    levelId: levelIdParam.describe('Level of the departure surface. Default: the active level.'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const fail = (code: Parameters<typeof refuse>[2], message: string, paths: string[] = [], ids: string[] = []): CommandResult =>
      refuse(doc, 'add_ladder', code, message, ids, paths);
    const resolution = resolveLevel(doc, building, params.levelId);
    if (!resolution.ok) return fail('STA_INVALID_GEOMETRY', resolution.reason, ['levelId']);
    const { level } = resolution;
    const model = resolution.building;
    const [fx, fy] = params.facing;
    if (!(Math.hypot(fx, fy) > 0)) return fail('STA_INVALID_GEOMETRY', 'facing must not be [0, 0]', ['facing']);
    if ((params.climbHeight === undefined) === (params.attachTo === undefined))
      return fail('STA_INVALID_GEOMETRY', 'give exactly one of climbHeight or attachTo', ['climbHeight', 'attachTo']);
    if (params.rungPitch !== undefined && params.rungPitchMax !== undefined)
      return fail('STA_INVALID_GEOMETRY', 'give rungPitch or rungPitchMax, not both', ['rungPitch', 'rungPitchMax']);
    if (params.installedOn !== undefined && !isIsoDate(params.installedOn))
      return fail('STA_INVALID_GEOMETRY', `installedOn '${params.installedOn}' is not a YYYY-MM-DD date`, ['installedOn']);

    const mm = (value: number): number => fromMm(doc, value);
    const rulesets = params.rulesets ?? RULESET_NAMES;
    const base = params.base;
    const basePoint: Vec2 = [base[0], base[1]];
    const departureTop = level.elevation + base[2];
    const surfaces = walkingSurfaces(model);
    let height = params.climbHeight;
    let arrival;
    if (params.attachTo !== undefined) {
      arrival = surfaces.find((surface) => surface.id === params.attachTo);
      if (arrival === undefined)
        return fail('STA_UNKNOWN_ELEMENT', `${params.attachTo} is not a slab or grating`, ['attachTo'], [params.attachTo]);
      height = arrival.top - departureTop;
      if (!(height > 0) || distanceToRing(basePoint, arrival.ring) > mm(ARRIVAL_REACH_MM))
        return fail(
          'STA_NO_ARRIVAL_SURFACE',
          `${arrival.id} is ${round(toMm(doc, height), 1)} mm above the base and ${round(toMm(doc, distanceToRing(basePoint, arrival.ring)), 1)} mm away in plan`,
          ['attachTo', 'base'],
          [arrival.id],
        );
    } else {
      arrival = arrivalSurface(surfaces, basePoint, departureTop + (height as number), mm(ARRIVAL_Z_MM), mm(ARRIVAL_REACH_MM));
      if (arrival === undefined)
        return fail(
          'STA_NO_ARRIVAL_SURFACE',
          `no slab or grating top within ${ARRIVAL_Z_MM} mm of z = ${round(toMm(doc, departureTop + (height as number)), 1)} mm and ${ARRIVAL_REACH_MM} mm of the base in plan`,
          ['climbHeight', 'base'],
        );
    }
    const climbHeight = height as number;
    const heightMm = toMm(doc, climbHeight);
    const defaulted: string[] = [];

    let rungPitch: number;
    let rungCount: number;
    if (params.rungPitch !== undefined) {
      rungPitch = params.rungPitch;
      rungCount = Math.max(0, Math.ceil(climbHeight / rungPitch - 1e-9) - 1);
    } else {
      const range = pitchRange(rulesets);
      const maxMm = params.rungPitchMax === undefined ? range.max : toMm(doc, params.rungPitchMax);
      if (params.rungPitchMax === undefined) defaulted.push(`rungPitchMax ${maxMm} mm (${range.basis})`);
      const plan = planPitch(heightMm, maxMm, range.min, range.basis);
      if (!plan.ok) return fail('STA_LADDER_PITCH_INFEASIBLE', plan.reason, ['climbHeight', 'rungPitchMax']);
      rungPitch = mm(plan.pitchMm);
      rungCount = plan.spaces - 1;
    }
    if (rungCount > MAX_RUNGS)
      return fail('STA_INVALID_GEOMETRY', `${rungCount} rungs: check the units of rungPitch / climbHeight`, ['rungPitch']);

    const pickMm = (value: number | undefined, fallback: { value: number; basis: string }, name: string): number => {
      if (value === undefined) defaulted.push(`${name} ${fallback.value} mm (${fallback.basis})`);
      return value ?? mm(fallback.value);
    };
    const clearWidth = pickMm(params.clearWidth, defaultClearWidthMm(rulesets), 'clearWidth');
    const railExtension = pickMm(params.railExtension, defaultRailExtensionMm(rulesets), 'railExtension');
    let fallProtection: LadderFallProtection;
    if (params.fallProtection === undefined) {
      const chosen = defaultFallProtection(heightMm, params.installedOn, rulesets);
      fallProtection = chosen.value;
      defaulted.push(`fallProtection ${chosen.value} (${chosen.basis})`);
    } else fallProtection = params.fallProtection;
    if (params.installedOn === undefined && fallProtection !== 'none')
      defaulted.push('installedOn unset: checked as installed after 2018-11-19 (the strictest reading)');

    let cage: LadderCage | undefined;
    if (params.cage !== undefined && fallProtection !== 'cage')
      return fail('STA_INVALID_GEOMETRY', `cage options need fallProtection "cage" (it is "${fallProtection}")`, [
        'cage',
        'fallProtection',
      ]);
    if (fallProtection === 'cage') {
      const named = defaultCageMm();
      const given = params.cage ?? {};
      const note = (name: string, value: number | undefined, fallback: number): void => {
        if (value === undefined) defaulted.push(`cage.${name} ${fallback} mm (ISO 14122-4 row)`);
      };
      note('startHeight', given.startHeight, named.startHeight);
      note('hoopSpacing', given.hoopSpacing, named.hoopSpacing);
      note('diameter', given.diameter, named.diameter);
      cage = {
        startHeight: given.startHeight ?? mm(named.startHeight),
        hoopSpacing: given.hoopSpacing ?? mm(named.hoopSpacing),
        diameter: given.diameter ?? mm(named.diameter),
        bars: given.bars ?? named.bars,
      };
    }

    let landings: number[];
    if (params.landings === undefined) {
      landings = defaultLandingsMm(heightMm, fallProtection, rulesets).map(mm);
      if (landings.length > 0) defaulted.push(`landings ${landings.length} (OSHA interval)`);
    } else landings = [...params.landings];
    if (landings.some((value, index) => !(value < climbHeight) || (index > 0 && !(value > (landings[index - 1] as number)))))
      return fail('STA_INVALID_GEOMETRY', 'landings must be ascending heights below the climb height', ['landings']);

    const rungHeights = Array.from(
      { length: Math.max(rungCount, 1) },
      (_, index) => departureTop + (rungCount === 0 ? climbHeight / 2 : (index + 1) * rungPitch),
    );
    const clearance = backClearance(doc, model, { base: basePoint, facing: Math.atan2(fy, fx), clearWidth }, rungHeights, arrival.id);
    const facing = Math.atan2(fy, fx);
    const twin = findTwin(
      model,
      'ladder',
      level.id,
      (element) => samePoint(element.base, base) && element.facing === facing && element.climbHeight === climbHeight,
    );
    if (twin !== undefined)
      return fail('STA_INVALID_GEOMETRY', `a ladder at this base and height already exists as ${twin.id} (${twin.mark})`, [], [twin.id]);

    const added = appendElements(
      model,
      [0],
      'ladder',
      (_, id, mark): LadderElement => ({
        id,
        category: 'ladder',
        mark,
        entityIds: [],
        levelId: level.id,
        base: [base[0], base[1], base[2]],
        facing,
        climbHeight,
        clearWidth,
        rungPitch,
        rungCount,
        exit: params.exit ?? 'through',
        fallProtection,
        ...(cage === undefined ? {} : { cage }),
        landings,
        railExtension,
        backClearance: clearance,
        ...(params.installedOn === undefined ? {} : { installedOn: params.installedOn }),
        arrivalSurfaceId: arrival.id,
      }),
    );
    const id = added.ids[0] as string;
    const gate =
      (params.exit ?? 'through') === 'through'
        ? cutRailingGate(
            doc,
            added.building,
            { base: basePoint, facing, clearWidth, stileThickness: ladderSizes(doc).stileThickness },
            arrival,
            mm(ARRIVAL_REACH_MM),
          )
        : { building: added.building, status: 'none' as const };
    const result = commitBuilding(
      doc,
      gate.building,
      gate.status === 'cut' && gate.railingId !== undefined ? [id, gate.railingId] : [id],
      (document) => {
        const element = document.building?.elements[id];
        return `Added ladder ${element?.mark} (${id}): ${round(heightMm, 1)} mm, ${rungCount} rung(s) at ${round(toMm(doc, rungPitch), 3)} mm, ${fallProtection}${landings.length > 0 ? `, ${landings.length} landing(s)` : ''}, back clearance ${round(toMm(doc, clearance), 1)} mm (${BACK_SEARCH_MM} = nothing nearer), arrival ${arrival.id}. Gate: ${gate.status}${gate.reason === undefined ? '' : ` (${gate.reason})`}. ${defaulted.length > 0 ? `Defaults: ${defaulted.join('; ')}. ` : ''}Run check_access.`;
      },
    );
    const element = result.document.building?.elements[id];
    const steelKg = element?.category === 'ladder' ? ladderQuantities(result.document, element).steelKg : 0;
    return {
      ...result,
      data: {
        elementIds: [id],
        rungCount,
        rungPitchMm: round(toMm(doc, rungPitch), 4),
        clearWidthMm: round(toMm(doc, clearWidth), 3),
        fallProtection,
        cage:
          cage === undefined
            ? null
            : {
                startHeightMm: round(toMm(doc, cage.startHeight), 3),
                hoopSpacingMm: round(toMm(doc, cage.hoopSpacing), 3),
                diameterMm: round(toMm(doc, cage.diameter), 3),
                bars: cage.bars,
              },
        landingsMm: landings.map((value) => round(toMm(doc, value), 3)),
        railExtensionMm: round(toMm(doc, railExtension), 3),
        backClearanceMm: round(toMm(doc, clearance), 3),
        arrivalSurfaceId: arrival.id,
        steelKg: round(steelKg, 3),
        gate: {
          status: gate.status,
          ...(gate.railingId === undefined ? {} : { railingId: gate.railingId }),
          ...(gate.reason === undefined ? {} : { reason: gate.reason }),
        },
        defaults: defaulted,
      },
    };
  },
});
