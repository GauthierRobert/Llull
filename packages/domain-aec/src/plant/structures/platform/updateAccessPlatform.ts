import { defineCommand, vec2, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import { fromMm } from '@core/model/units';
import { getBuilding } from '../../../building/model';
import { refuse } from '../codes';
import { framingParam, DEFAULT_BEAM_PROFILE, DEFAULT_BEAM_SPACING_MM, ringOfBounds } from './addAccessPlatform';
import { generate, specOf } from './platformRegenerate';
import { sameAssembly } from '../assembly/definition';
import { commitPlatform, refusal } from './platformCommit';
import { railingFieldParams, resolveRailingFields } from './platformRailing';
import type { CircularSpec, PlatformSpec } from './platformSpec';

const DECK_ONLY = ['boundary', 'bounds', 'topOffset', 'bearingBarDirection', 'framing'] as const;
const CIRCULAR_ONLY = ['elevation', 'startAngleDeg', 'sweepDeg', 'gap', 'width', 'bracketProfile', 'bracketSpacingMax'] as const;

const edgeEntry = z.union([z.number().int().min(0), z.enum(['outer', 'inner', 'ends'])]);

/**
 * @affects regenerates the members, grating panels and railings of one platform assembly (ids and marks of the parts are kept, extra parts are added or removed)
 * @invariant the stored parameters change only by the given fields; the result is validated like the add command; with no field given the parts are re-derived from the current vessel
 * @failure id that is not a platform assembly -> STA_UNKNOWN_ELEMENT; a field of the other kind or an invalid result -> the add command's codes; nothing changes -> no-op
 */
export const updateAccessPlatform = defineCommand({
  name: 'update_access_platform',
  description:
    'Change a generated platform (add_access_platform / add_circular_access_platform `assemblyId`) and regenerate its members, grating panels and railings; part ids and marks are kept. ' +
    'Give only the fields to change (lengths in DOCUMENT UNITS, angles in DEGREES). Deck platform: boundary or bounds, topOffset, bearingBarDirection, framing. Circular platform: elevation, startAngleDeg, sweepDeg, gap, width, bracketProfile, bracketSpacingMax (the vessel itself cannot be changed: delete and add again). ' +
    'Both: gratingType, imposedLoadKPa and railing (an object merges into the current railing settings, null removes the guard-rails). With NO field it re-derives the platform from the current vessel and beams (after update_equipment or a move; access_platform_takeoff reports stale: true). ' +
    'Result data as the add commands.',
  params: z.object({
    assemblyId: z.string().describe('Assembly element id (the `assemblyId` of the add command).'),
    boundary: z.array(vec2('Plan point [x, y].')).min(3).optional().describe('Deck platform only: new convex boundary.'),
    bounds: z
      .tuple([vec2('Minimum corner.'), vec2('Maximum corner.')])
      .optional()
      .describe('Deck platform only: new rectangular boundary [[xmin, ymin], [xmax, ymax]].'),
    topOffset: z.number().optional().describe('Deck platform only: walking-surface height relative to the level elevation.'),
    bearingBarDirection: vec2('Deck platform only: new plan direction of the bars [x, y].').optional(),
    framing: framingParam.optional(),
    elevation: z
      .number()
      .optional()
      .describe('Circular platform only: walking-surface height above the vessel level elevation; 0 < elevation <= vessel height.'),
    startAngleDeg: z.number().optional().describe('Circular platform only: start of the sector, degrees.'),
    sweepDeg: z.number().positive().max(360).optional().describe('Circular platform only: angular extent, degrees.'),
    gap: z.number().min(0).optional().describe('Circular platform only: gap between the shell and the walkway.'),
    width: z.number().positive().optional().describe('Circular platform only: radial width of the walkway.'),
    bracketProfile: z.string().optional().describe('Circular platform only: steel catalogue name of the brackets.'),
    bracketSpacingMax: z
      .number()
      .positive()
      .optional()
      .describe('Circular platform only: largest arc distance between brackets at the outer radius.'),
    gratingType: z.string().optional().describe('New catalogue key from list_grating_types.'),
    imposedLoadKPa: z
      .number()
      .min(0)
      .optional()
      .describe(
        'Imposed (live) load on the walking surface, kN/m² (kPa), fed to check_steel_members with the grating self-weight. Unset keeps the current value.',
      ),
    railing: z
      .union([
        z.null(),
        z.object({
          edges: z
            .union([z.literal('all'), z.array(edgeEntry).min(1)])
            .optional()
            .describe('Deck platform: "all" or boundary edge indices. Circular platform: "outer", "inner" and/or "ends".'),
          ...railingFieldParams,
        }),
      ])
      .optional()
      .describe(
        'Object: merged into the current guard-rail settings (unset fields keep their value, or the ruleset default when there was no railing). null: remove the guard-rails.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const { assemblyId, ...fields } = params;
    const building = getBuilding(doc);
    const assembly = building.elements[assemblyId];
    if (assembly?.category !== 'assembly')
      return refuse(
        doc,
        'update_access_platform',
        'STA_UNKNOWN_ELEMENT',
        `${assemblyId} is not a platform assembly`,
        [assemblyId],
        ['assemblyId'],
      );
    const spec = specOf(assembly);
    if (spec === null)
      return refuse(doc, 'update_access_platform', 'STA_INVALID_GEOMETRY', `the stored parameters of ${assemblyId} no longer parse`, [
        assemblyId,
      ]);
    const foreign = (assembly.kind === 'platform' ? CIRCULAR_ONLY : DECK_ONLY).filter((name) => fields[name] !== undefined);
    if (foreign.length > 0)
      return refuse(
        doc,
        'update_access_platform',
        'STA_INVALID_GEOMETRY',
        `${foreign.join(', ')} do(es) not apply to a ${assembly.kind} (${assemblyId})`,
        [assemblyId],
        foreign,
      );
    if (fields.boundary !== undefined && fields.bounds !== undefined)
      return refuse(doc, 'update_access_platform', 'STA_INVALID_GEOMETRY', 'give boundary or bounds, not both', [], ['boundary', 'bounds']);

    const defaults: string[] = [];
    let railing = spec.railing;
    if (fields.railing === null) railing = null;
    else if (fields.railing !== undefined) {
      const { edges, ...input } = fields.railing;
      const current = spec.railing === null ? {} : { ...spec.railing, edges: undefined };
      const resolved = resolveRailingFields(
        doc,
        { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) },
        defaults,
      );
      if (typeof resolved === 'string')
        return refuse(doc, 'update_access_platform', 'STA_INVALID_GEOMETRY', resolved, [assemblyId], ['railing']);
      const kept = spec.railing?.edges;
      if (spec.kind === 'platform') {
        const wanted = edges ?? kept ?? 'all';
        if (wanted !== 'all' && !wanted.every((edge) => typeof edge === 'number'))
          return refuse(
            doc,
            'update_access_platform',
            'STA_INVALID_GEOMETRY',
            'a deck platform railing takes "all" or edge indices',
            [assemblyId],
            ['railing'],
          );
        railing = {
          ...resolved,
          edges: wanted as PlatformSpec['railing'] extends infer R ? (R extends { edges: infer E } ? E : never) : never,
        };
      } else {
        const wanted = edges ?? kept ?? ['outer', 'ends'];
        if (wanted === 'all' || !wanted.every((edge) => typeof edge === 'string'))
          return refuse(
            doc,
            'update_access_platform',
            'STA_INVALID_GEOMETRY',
            'a circular platform railing takes "outer", "inner" and/or "ends"',
            [assemblyId],
            ['railing'],
          );
        railing = { ...resolved, edges: wanted as Array<'outer' | 'inner' | 'ends'> };
      }
    }
    const grating = fields.gratingType ?? spec.gratingType;
    const next: PlatformSpec | CircularSpec =
      spec.kind === 'platform'
        ? {
            ...spec,
            gratingType: grating,
            ...(fields.imposedLoadKPa === undefined ? {} : { imposedLoadKPa: fields.imposedLoadKPa }),
            railing: railing as PlatformSpec['railing'],
            ...(fields.boundary === undefined && fields.bounds === undefined
              ? {}
              : { boundary: fields.boundary ?? ringOfBounds(fields.bounds as [[number, number], [number, number]]) }),
            ...(fields.topOffset === undefined ? {} : { topOffset: fields.topOffset }),
            ...(fields.bearingBarDirection === undefined ? {} : { bearingBarDirection: fields.bearingBarDirection }),
            ...(fields.framing === undefined
              ? {}
              : {
                  framing:
                    fields.framing === 'existing'
                      ? ({ kind: 'existing' } as const)
                      : ({
                          kind: 'generated',
                          profile:
                            fields.framing.profile ?? (spec.framing.kind === 'generated' ? spec.framing.profile : DEFAULT_BEAM_PROFILE),
                          maxSpacing:
                            fields.framing.maxSpacing ??
                            (spec.framing.kind === 'generated' ? spec.framing.maxSpacing : fromMm(doc, DEFAULT_BEAM_SPACING_MM)),
                        } as const),
                }),
          }
        : {
            ...spec,
            gratingType: grating,
            ...(fields.imposedLoadKPa === undefined ? {} : { imposedLoadKPa: fields.imposedLoadKPa }),
            railing: railing as CircularSpec['railing'],
            ...(fields.elevation === undefined ? {} : { elevation: fields.elevation }),
            ...(fields.startAngleDeg === undefined ? {} : { startAngleDeg: fields.startAngleDeg }),
            ...(fields.sweepDeg === undefined ? {} : { sweepDeg: fields.sweepDeg }),
            ...(fields.gap === undefined ? {} : { gap: fields.gap }),
            ...(fields.width === undefined ? {} : { width: fields.width }),
            ...(fields.bracketProfile === undefined ? {} : { bracketProfile: fields.bracketProfile }),
            ...(fields.bracketSpacingMax === undefined ? {} : { bracketSpacingMax: fields.bracketSpacingMax }),
          };
    const built = generate(doc, building, assembly, next);
    if (!built.ok) return refusal(doc, 'update_access_platform', built);
    if (sameAssembly(building, built.building, assemblyId))
      return noop(
        doc,
        `update_access_platform: ${assembly.mark} (${assemblyId}) already matches these parameters and its vessel / beams; nothing changed.`,
      );
    return commitPlatform(doc, 'Updated', assemblyId, built, defaults);
  },
});
