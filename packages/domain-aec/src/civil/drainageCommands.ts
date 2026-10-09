/**
 * Gravity drainage network commands: manholes, pipes, hydraulic checks and sizing.
 * @layer domain-aec/civil
 */

import type { Vec2 } from '@core/model/types';
import type { ManholeObject } from '@core/model/civil';
import type { CommandDefinition } from '@core/commands/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { fromMm } from '../model';
import {
  civilAffected,
  civilObject,
  civilObjectsOf,
  getCivil,
  nextCivilId,
  toMetresText,
  withObject,
} from './model';
import { regenerateCivil } from './evaluate';
import { surfaceTinById } from './surfaceTin';
import { elevationAt } from './tin';
import { pipePlanLength } from './drainageTopology';
import { drainageAnalysisCommands } from './drainageAnalysisCommands';
import { drainagePipeCommands } from './drainagePipeCommands';
import { exportDrainageLongSection } from './drainageLongSectionCommand';

const manholeFields = {
  invertElevation: z.number().describe('Invert (lowest internal) elevation of the chamber.'),
  rimElevation: z
    .number()
    .optional()
    .describe('Rim (cover level) elevation; must be above the invert. Overrides `surfaceId`.'),
  surfaceId: z
    .string()
    .optional()
    .describe('Surface id; when `rimElevation` is omitted the rim is the ground level there.'),
  diameter: z
    .number()
    .optional()
    .describe('Chamber internal diameter in document units (> 0). Default 1200 mm.'),
  catchmentAreaHa: z
    .number()
    .optional()
    .describe('Contributing catchment area in hectares (> 0) for the rational method.'),
  runoffCoefficient: z
    .number()
    .optional()
    .describe('Runoff coefficient C, 0 to 1. Default 0.9 when a catchment area is given.'),
  inflowLps: z.number().optional().describe('Additional point inflow in litres per second (>= 0).'),
  entryTimeMin: z
    .number()
    .optional()
    .describe(
      "Inlet (entry) time in minutes (> 0) of this manhole's catchment for the time of concentration. Default 5.",
    ),
  name: z.string().optional().describe('Display name. Default "MH<n>".'),
};

function checkOptions(options: {
  diameter?: number | undefined;
  catchmentAreaHa?: number | undefined;
  runoffCoefficient?: number | undefined;
  inflowLps?: number | undefined;
  entryTimeMin?: number | undefined;
}): string | null {
  if (options.diameter !== undefined && !(options.diameter > 0)) return 'diameter must be > 0.';
  if (options.catchmentAreaHa !== undefined && options.catchmentAreaHa < 0) {
    return 'catchmentAreaHa must be >= 0.';
  }
  const c = options.runoffCoefficient;
  if (c !== undefined && !(c >= 0 && c <= 1)) return 'runoffCoefficient must be between 0 and 1.';
  if (options.inflowLps !== undefined && options.inflowLps < 0) return 'inflowLps must be >= 0.';
  if (options.entryTimeMin !== undefined && !(options.entryTimeMin > 0)) {
    return 'entryTimeMin must be > 0.';
  }
  return null;
}

function groundLevel(
  civil: ReturnType<typeof getCivil>,
  surfaceId: string,
  at: Vec2,
): number | string {
  const tin = surfaceTinById(civil, surfaceId);
  if (!tin) return `no surface ${surfaceId}.`;
  return elevationAt(tin, at) ?? `position [${at[0]}, ${at[1]}] is outside surface ${surfaceId}.`;
}

function catchmentOf(
  areaHa: number | undefined,
  coefficient: number | undefined,
  previous?: ManholeObject['catchment'],
): ManholeObject['catchment'] {
  const area = areaHa ?? previous?.areaHa ?? 0;
  if (!(area > 0)) return undefined;
  return { areaHa: area, runoffCoefficient: coefficient ?? previous?.runoffCoefficient ?? 0.9 };
}

/**
 * @command add_manhole
 * @pure
 * @affects creates 1 manhole (cylinder body, plan circle, label)
 * @invariant rim above invert
 * @failure bad value / no rim source / position outside surface -> no-op
 */
export const addManhole = defineCommand({
  name: 'add_manhole',
  description:
    'Add a drainage manhole / inspection chamber / outfall at a plan position. Give `invertElevation` ' +
    'and either `rimElevation` or a `surfaceId` (rim = ground level there). Optional catchment ' +
    '(area in ha, runoff coefficient), point inflow and `entryTimeMin` (inlet time, default 5 min) feed the network check. Connect manholes with add_pipe.',
  params: z.object({
    location: vec2('Plan position [x, y] of the chamber centre, document units.'),
    ...manholeFields,
  }),
  run: (doc, params): CommandResult => {
    const problem = checkOptions(params);
    if (problem !== null) return noop(doc, `add_manhole failed: ${problem}`);
    const civil = getCivil(doc);
    let rim = params.rimElevation;
    if (rim === undefined) {
      if (params.surfaceId === undefined) {
        return noop(
          doc,
          'add_manhole failed: give rimElevation or a surfaceId to take the rim from.',
        );
      }
      const ground = groundLevel(civil, params.surfaceId, params.location);
      if (typeof ground === 'string') return noop(doc, `add_manhole failed: ${ground}`);
      rim = ground;
    }
    if (!(rim > params.invertElevation)) {
      return noop(
        doc,
        `add_manhole failed: rim ${rim} must be above invert ${params.invertElevation}.`,
      );
    }
    const id = nextCivilId(civil, 'manhole');
    const catchment = catchmentOf(params.catchmentAreaHa, params.runoffCoefficient);
    const manhole: ManholeObject = {
      id,
      category: 'manhole',
      name: params.name?.trim() || `MH${civilObjectsOf(civil, 'manhole').length + 1}`,
      entityIds: [],
      position: [params.location[0], params.location[1]],
      rimElevation: rim,
      invertElevation: params.invertElevation,
      diameter: params.diameter ?? fromMm(doc, 1200),
      ...(catchment ? { catchment } : {}),
      ...(params.inflowLps ? { inflow: params.inflowLps } : {}),
      ...(params.entryTimeMin ? { entryTimeMin: params.entryTimeMin } : {}),
    };
    const document = regenerateCivil(doc, withObject(civil, manhole));
    return {
      document,
      summary:
        `Added manhole ${manhole.name} (${id}) at [${manhole.position.join(', ')}]: ` +
        `invert ${toMetresText(doc, manhole.invertElevation)} m, rim ${toMetresText(doc, rim)} m, ` +
        `depth ${toMetresText(doc, rim - manhole.invertElevation)} m.`,
      affected: civilAffected(document, [id]),
      data: { manholeId: id },
    };
  },
});

/**
 * @command update_manhole
 * @pure
 * @affects regenerates 1 manhole and the pipes attached to it
 * @failure unknown manhole / bad value / no change / zero-length pipe -> no-op
 */
export const updateManhole = defineCommand({
  name: 'update_manhole',
  description:
    'Edit a manhole: move it, change invert / rim (or re-take the rim from `surfaceId`), diameter, ' +
    'catchment (`catchmentAreaHa` 0 removes it), point inflow (0 removes it), `entryTimeMin` or name. Connected pipes ' +
    'stay connected and keep their inverts; pipes whose invert would fall below the new manhole invert are reported.',
  params: z.object({
    manholeId: z.string().describe('Manhole id, e.g. "manhole-1".'),
    location: vec2('New plan position [x, y].').optional(),
    ...manholeFields,
    invertElevation: manholeFields.invertElevation.optional(),
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const manhole = civilObject(civil, params.manholeId, 'manhole');
    if (!manhole) return noop(doc, `update_manhole failed: no manhole ${params.manholeId}.`);
    const problem = checkOptions(params);
    if (problem !== null) return noop(doc, `update_manhole failed: ${problem}`);
    const position: Vec2 = params.location ?? manhole.position;
    let rim = params.rimElevation ?? manhole.rimElevation;
    if (params.rimElevation === undefined && params.surfaceId !== undefined) {
      const ground = groundLevel(civil, params.surfaceId, position);
      if (typeof ground === 'string') return noop(doc, `update_manhole failed: ${ground}`);
      rim = ground;
    }
    const invert = params.invertElevation ?? manhole.invertElevation;
    if (!(rim > invert)) {
      return noop(doc, `update_manhole failed: rim ${rim} must be above invert ${invert}.`);
    }
    const catchment = catchmentOf(
      params.catchmentAreaHa,
      params.runoffCoefficient,
      manhole.catchment,
    );
    const inflow = params.inflowLps === undefined ? manhole.inflow : params.inflowLps;
    const entryTimeMin = params.entryTimeMin ?? manhole.entryTimeMin;
    const updated: ManholeObject = {
      id: manhole.id,
      category: 'manhole',
      name: params.name?.trim() || manhole.name,
      entityIds: manhole.entityIds,
      position: [position[0], position[1]],
      rimElevation: rim,
      invertElevation: invert,
      diameter: params.diameter ?? manhole.diameter,
      ...(catchment ? { catchment } : {}),
      ...(inflow ? { inflow } : {}),
      ...(entryTimeMin ? { entryTimeMin } : {}),
    };
    if (JSON.stringify(updated) === JSON.stringify(manhole)) {
      return noop(doc, `update_manhole: nothing to change on ${manhole.id}.`);
    }
    const next = withObject(civil, updated);
    const attached = civilObjectsOf(next, 'pipe').filter(
      (pipe) => pipe.fromId === manhole.id || pipe.toId === manhole.id,
    );
    const degenerate = attached.filter((pipe) => !((pipePlanLength(next, pipe) ?? 0) > 0));
    if (degenerate.length > 0) {
      return noop(
        doc,
        `update_manhole failed: the move would give zero-length pipe(s) ${degenerate.map((p) => p.id).join(', ')}.`,
      );
    }
    const below = attached.filter(
      (pipe) =>
        (pipe.fromId === manhole.id ? pipe.invertFrom : pipe.invertTo) < updated.invertElevation,
    );
    const document = regenerateCivil(doc, next);
    const warning =
      below.length > 0
        ? ` Warning: pipe(s) ${below.map((p) => p.id).join(', ')} have an invert below the manhole invert.`
        : '';
    return {
      document,
      summary:
        `Updated manhole ${updated.name} (${updated.id}): invert ${toMetresText(doc, invert)} m, ` +
        `rim ${toMetresText(doc, rim)} m; ${attached.length} connected pipe(s) kept.${warning}`,
      affected: civilAffected(document, [updated.id, ...attached.map((pipe) => pipe.id)]),
    };
  },
});

export const drainageCommands = [
  addManhole,
  updateManhole,
  ...drainagePipeCommands,
  ...drainageAnalysisCommands,
  exportDrainageLongSection,
] as ReadonlyArray<CommandDefinition<unknown>>;
