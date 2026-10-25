import type { Vec3 } from '@core/model/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { fromMm, toMm } from '@core/model/units';
import type { RailingElement, RailingHost } from '@aec/building/types';
import { appendElements, getBuilding, resolveLevel } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { levelIdParam } from '../../../building/levelParams';
import { findTwin, samePath } from '../../../shared/duplicates';
import { round } from '../../../shared/numeric';
import { findProfile } from '../../../steel/profiles';
import { refuse } from '../codes';
import { RULESET_NAMES } from '../rules/ruleTable';
import { DEFAULT_POST_SPACING_MM, railingDefaults } from './railingDefaults';
import { hostPaths } from './railingPath';
import { railingQuantities } from './railingMeasure';
import { railingProblem } from './railingValidate';

const DEFAULT_PROFILE = 'CHS48.3x3.2';

export const openingParam = z
  .array(
    z.object({
      from: z.number().min(0).describe('Start of the gap, distance along the path from its first point, DOCUMENT UNITS.'),
      to: z.number().positive().describe('End of the gap, distance along the path, DOCUMENT UNITS (> from).'),
      gate: z
        .boolean()
        .optional()
        .describe('true = a self-closing gate closes the gap (a ladder exit); false/omitted = open, an unprotected edge.'),
    }),
  )
  .describe('Gaps in the rails and toe plate, ascending and not overlapping. Posts stand at both ends of every gap.');

/**
 * @affects creates 1 railing element per path (posts, rails, toe plate and gate entities on layer S-RAIL)
 * @invariant posts at the ends, corners and gap ends, equal spacing <= postSpacingMax inside each interval; clear space between rails = (height - toePlate - (k+1) rail depth) / (k+1)
 * @failure path < 2 points / repeated point / rails do not fit -> STA_INVALID_GEOMETRY; unknown host -> STA_UNKNOWN_ELEMENT; gap outside the path -> STA_RAIL_OPENING; same railing again -> no-op
 */
export const addRailing = defineCommand({
  name: 'add_railing',
  description:
    'Add a guard-rail (or hand-rail) along a 3D polyline or along edges of a slab / grating panel: posts at the ends, corners and gap ends and at equal spacing ' +
    '<= postSpacingMax in between, a top rail, kneeRails intermediate rails and a toe plate. Lengths in DOCUMENT UNITS. ' +
    'Give `path` [[x, y, z], ...] (z = walking surface above the level elevation) OR `hostId` (slab or grating id) with `edges` ("all" or edge indices: edge i runs from boundary point i to point i+1; ' +
    '`opening` = index of a slab opening to guard that void instead of the outer boundary): one railing per run of consecutive edges, one closed railing for "all". ' +
    'Unset values follow the rulesets (default both iso_14122 and osha_1910) and are named in data.defaults: height = highest nominal top rail (1100 mm with both), toe plate = highest minimum (100 mm), ' +
    'kneeRails = fewest that keep the clear space within the smallest limit, postSpacingMax 1500 mm (a named default: its ISO row is grade C), posts and rails CHS48.3x3.2. ' +
    'role "handrail" (stairs) has no rule table, so give its height; it gets no knee rails or toe plate unless you ask. `openings` cut gaps; a gap with gate: true is closed by a gate (ladder exit) and counts as guarded by check_access. ' +
    'Result data: railings[] with id, lengthM, posts, postSpacingMm, clearGapMm, steelKg; posts is the total. check_access checks height, clear space and toe plate and credits the railing to slab open edges.',
  params: z.object({
    path: z
      .array(vec3('Path point [x, y, z], DOCUMENT UNITS; z = walking surface relative to the level.'))
      .min(2)
      .optional()
      .describe('Railing polyline. Give path or hostId.'),
    hostId: z
      .string()
      .optional()
      .describe('Slab or grating element id whose edges the railing follows (it is deleted with the host and moves with it).'),
    edges: z
      .union([z.literal('all'), z.array(z.number().int().min(0)).min(1)])
      .optional()
      .describe('With hostId: "all" or edge indices. Default "all".'),
    opening: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('With a slab host: index of the slab opening to guard instead of its outer boundary.'),
    height: z
      .number()
      .positive()
      .optional()
      .describe(
        'Top of the top rail above the walking surface, DOCUMENT UNITS. Default from the rulesets (guard-rail); required for a handrail.',
      ),
    kneeRails: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Intermediate rails, equally spaced. Default: the fewest within the ruleset gap limit (guard-rail), 0 for a handrail.'),
    toePlate: z
      .number()
      .min(0)
      .optional()
      .describe('Toe-plate height, DOCUMENT UNITS; 0 = none. Default: the ruleset minimum (guard-rail), 0 for a handrail.'),
    postProfile: z.string().optional().describe('Steel catalogue name of the posts (list_steel_profiles). Default CHS48.3x3.2.'),
    railProfile: z.string().optional().describe('Steel catalogue name of the rails. Default CHS48.3x3.2.'),
    postSpacingMax: z.number().positive().optional().describe('Largest distance between posts, DOCUMENT UNITS. Default 1500 mm.'),
    openings: openingParam.optional(),
    role: z.enum(['guardrail', 'handrail']).optional().describe('"guardrail" (default) protects a drop; "handrail" is a stair hand rail.'),
    rulesets: z.array(z.enum(RULESET_NAMES)).min(1).optional().describe('Rulesets that decide the unset values. Default both.'),
    levelId: levelIdParam.describe('Level id for a path railing. Default: the active level. A hosted railing takes its host level.'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    if ((params.path === undefined) === (params.hostId === undefined))
      return refuse(doc, 'add_railing', 'STA_INVALID_GEOMETRY', 'give exactly one of path or hostId', [], ['path', 'hostId']);
    const role = params.role ?? 'guardrail';
    let levelId: string;
    let runs: Array<{ path: Vec3[]; host?: RailingHost }>;
    let nextBuilding = building;
    if (params.hostId !== undefined) {
      const host = building.elements[params.hostId];
      if (host === undefined)
        return refuse(doc, 'add_railing', 'STA_UNKNOWN_ELEMENT', `no element ${params.hostId}`, [params.hostId], ['hostId']);
      const found = hostPaths(host, params.edges ?? 'all', params.opening);
      if (!found.ok) return refuse(doc, 'add_railing', 'STA_INVALID_GEOMETRY', found.reason, [host.id], ['hostId', 'edges', 'opening']);
      levelId = found.levelId;
      runs = found.paths;
    } else {
      const resolution = resolveLevel(doc, building, params.levelId);
      if (!resolution.ok) return refuse(doc, 'add_railing', 'STA_INVALID_GEOMETRY', resolution.reason, [], ['levelId']);
      levelId = resolution.level.id;
      nextBuilding = resolution.building;
      runs = [{ path: params.path as Vec3[] }];
    }

    const rail = findProfile(params.railProfile ?? DEFAULT_PROFILE);
    if (rail === undefined)
      return refuse(
        doc,
        'add_railing',
        'STA_INVALID_GEOMETRY',
        `unknown rail profile '${params.railProfile}' (list_steel_profiles)`,
        [],
        ['railProfile'],
      );
    if (role === 'handrail' && params.height === undefined)
      return refuse(
        doc,
        'add_railing',
        'STA_INVALID_GEOMETRY',
        'a handrail needs an explicit height: no handrail height rule is loaded',
        [],
        ['height'],
      );
    const defaults = railingDefaults(params.rulesets ?? RULESET_NAMES, rail.h);
    const defaulted: string[] = [];
    const pick = <T>(value: T | undefined, fallback: T, name: string, basis: string): T => {
      if (value === undefined) defaulted.push(`${name} ${basis}`);
      return value ?? fallback;
    };
    const guard = role === 'guardrail';
    const height = params.height ?? fromMm(doc, defaults.heightMm);
    if (guard && params.height === undefined) defaulted.push(defaults.basis[0] as string);
    const toePlate = guard ? (params.toePlate ?? fromMm(doc, defaults.toePlateMm)) : (params.toePlate ?? 0);
    if (guard && params.toePlate === undefined) defaulted.push(defaults.basis[1] as string);
    const kneeRails = guard ? (params.kneeRails ?? defaults.kneeRails) : (params.kneeRails ?? 0);
    if (guard && params.kneeRails === undefined) defaulted.push(defaults.basis[2] as string);
    const postSpacingMax = pick(
      params.postSpacingMax,
      fromMm(doc, DEFAULT_POST_SPACING_MM),
      'postSpacingMax',
      `${DEFAULT_POST_SPACING_MM} mm (ISO-GRD-POST-SPACING is grade C: a default, not a gate)`,
    );
    const postProfile = pick(params.postProfile, DEFAULT_PROFILE, 'postProfile', DEFAULT_PROFILE);
    const railProfile = pick(params.railProfile, DEFAULT_PROFILE, 'railProfile', DEFAULT_PROFILE);

    const definitions = runs.map((run) => ({
      path: run.path,
      height,
      kneeRails,
      toePlate,
      postProfile,
      railProfile,
      postSpacingMax,
      openings: (params.openings ?? []).map((opening) => ({ from: opening.from, to: opening.to, gate: opening.gate === true })),
      role,
      ...(run.host === undefined ? {} : { host: run.host }),
    }));
    for (const definition of definitions) {
      const problem = railingProblem(doc, definition);
      if (problem !== null) return refuse(doc, 'add_railing', problem.code, problem.message, [], problem.paths);
    }
    const twin = definitions
      .map((definition) =>
        findTwin(
          nextBuilding,
          'railing',
          levelId,
          (element) => element.height === height && element.role === role && samePath(element.path, definition.path),
        ),
      )
      .find((found) => found !== undefined);
    if (twin !== undefined)
      return refuse(
        doc,
        'add_railing',
        'STA_INVALID_GEOMETRY',
        `a railing on this path already exists as ${twin.id} (${twin.mark}); use update_railing`,
        [twin.id],
      );

    const added = appendElements(
      nextBuilding,
      definitions,
      'railing',
      (definition, id, mark): RailingElement => ({ id, category: 'railing', mark, entityIds: [], levelId, ...definition }),
    );
    const document = commitBuilding(doc, added.building, added.ids, '');
    const rows = added.ids.map((id) => {
      const element = document.document.building?.elements[id];
      const quantities = element?.category === 'railing' ? railingQuantities(document.document, element) : null;
      return {
        id,
        mark: element?.mark ?? '',
        lengthM: round(quantities?.lengthM ?? 0, 4),
        posts: quantities?.posts ?? 0,
        postSpacingMm: round(quantities?.postSpacingMm ?? 0, 3),
        clearGapMm: round(quantities?.clearGapMm ?? 0, 3),
        gates: quantities?.gates ?? 0,
        steelKg: round(quantities?.steelKg ?? 0, 3),
      };
    });
    const posts = rows.reduce((sum, row) => sum + row.posts, 0);
    const lengthM = rows.reduce((sum, row) => sum + row.lengthM, 0);
    return {
      ...document,
      summary:
        `Added ${role} ${rows.map((row) => row.mark).join(', ')} (${added.ids.join(', ')}): ${round(lengthM, 3)} m, ${posts} post(s) at <= ${round(toMm(doc, postSpacingMax), 1)} mm, ` +
        `top ${round(toMm(doc, height), 1)} mm, ${kneeRails} knee rail(s), toe plate ${round(toMm(doc, toePlate), 1)} mm, clear space ${rows[0]?.clearGapMm} mm. ` +
        (defaulted.length > 0 ? `Defaults: ${defaulted.join('; ')}. ` : '') +
        'Run check_access.',
      data: { elementIds: added.ids, railings: rows, posts, lengthM: round(lengthM, 4), defaults: defaulted },
    };
  },
});
