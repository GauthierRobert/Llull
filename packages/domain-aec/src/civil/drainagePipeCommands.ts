/**
 * Drainage pipe commands: connect manholes with gravity pipes and edit them.
 * @layer domain-aec/civil
 */

import type { PipeObject } from '@core/model/civil';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { fromMm } from '../model';
import {
  civilObject,
  civilObjectsOf,
  getCivil,
  nextCivilId,
  toMetresText,
  withObject,
} from './model';
import { commitCivil } from './evaluate';
import { flowsTo, pipePlanLength } from './drainageTopology';

const pipeFields = {
  diameter: z
    .number()
    .optional()
    .describe('Pipe internal diameter in document units (> 0). Default 300 mm.'),
  material: z.string().optional().describe('Pipe material label, e.g. "PVC", "HDPE", "Concrete".'),
  manningN: z.number().optional().describe('Manning roughness n (> 0). Default 0.013 (PVC).'),
  invertFrom: z
    .number()
    .optional()
    .describe('Invert elevation at the upstream end. Default: upstream manhole invert.'),
  invertTo: z
    .number()
    .optional()
    .describe('Invert elevation at the downstream end. Default: downstream manhole invert.'),
  name: z.string().optional().describe('Display name. Default "P<n>".'),
};

function checkPipeValues(values: {
  diameter?: number | undefined;
  manningN?: number | undefined;
}): string | null {
  if (values.diameter !== undefined && !(values.diameter > 0)) return 'diameter must be > 0.';
  if (values.manningN !== undefined && !(values.manningN > 0)) return 'manningN must be > 0.';
  return null;
}

function slopeText(pipe: PipeObject, length: number): string {
  const percent = length > 0 ? ((pipe.invertFrom - pipe.invertTo) / length) * 100 : 0;
  return `${percent.toFixed(2)} %`;
}

/**
 * @command add_pipe
 * @pure
 * @affects creates 1 pipe (tube body, plan line, label)
 * @invariant flow runs fromId -> toId; the network stays acyclic; one pipe per ordered pair
 * @failure unknown / non-manhole end, self-loop, coincident ends, duplicate, cycle -> no-op
 */
export const addPipe = defineCommand({
  name: 'add_pipe',
  description:
    'Add a gravity pipe from the upstream manhole `fromId` to the downstream manhole `toId` (flow ' +
    'direction). Inverts default to the manhole inverts; diameter 300 mm, PVC, n 0.013. Refuses ' +
    'self-loops, duplicates and loops in the network; warns on adverse (uphill) slope. Then run ' +
    'check_drainage_network or size_drainage_pipes.',
  params: z.object({
    fromId: z.string().describe('Upstream manhole id, e.g. "manhole-1".'),
    toId: z.string().describe('Downstream manhole id.'),
    ...pipeFields,
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const from = civilObject(civil, params.fromId, 'manhole');
    const to = civilObject(civil, params.toId, 'manhole');
    if (!from || !to) {
      return noop(
        doc,
        `add_pipe failed: ${!from ? params.fromId : params.toId} is not a manhole in this document.`,
      );
    }
    if (from.id === to.id)
      return noop(doc, `add_pipe failed: ${from.id} cannot connect to itself.`);
    const problem = checkPipeValues(params);
    if (problem !== null) return noop(doc, `add_pipe failed: ${problem}`);
    const duplicate = civilObjectsOf(civil, 'pipe').find(
      (pipe) =>
        (pipe.fromId === from.id && pipe.toId === to.id) ||
        (pipe.fromId === to.id && pipe.toId === from.id),
    );
    if (duplicate) {
      return noop(
        doc,
        `add_pipe failed: ${duplicate.id} already connects ${from.id} and ${to.id}.`,
      );
    }
    if (flowsTo(civil, to.id, from.id)) {
      return noop(
        doc,
        `add_pipe failed: ${from.id} -> ${to.id} would close a loop in the network.`,
      );
    }
    const id = nextCivilId(civil, 'pipe');
    const pipe: PipeObject = {
      id,
      category: 'pipe',
      name: params.name?.trim() || `P${civilObjectsOf(civil, 'pipe').length + 1}`,
      entityIds: [],
      fromId: from.id,
      toId: to.id,
      diameter: params.diameter ?? fromMm(doc, 300),
      material: params.material?.trim() || 'PVC',
      manningN: params.manningN ?? 0.013,
      invertFrom: params.invertFrom ?? from.invertElevation,
      invertTo: params.invertTo ?? to.invertElevation,
    };
    const length = pipePlanLength(civil, pipe) ?? 0;
    if (!(length > 0))
      return noop(doc, `add_pipe failed: ${from.id} and ${to.id} share the same plan position.`);
    const adverse = pipe.invertFrom <= pipe.invertTo ? ' Warning: adverse or zero slope.' : '';
    return commitCivil(
      doc,
      withObject(civil, pipe),
      [id],
      `Added pipe ${pipe.name} (${id}) ${from.name} -> ${to.name}: length ${toMetresText(doc, length)} m, ` +
        `slope ${slopeText(pipe, length)}, ${pipe.material}.${adverse}`,
      { pipeId: id },
    );
  },
});

/**
 * @command update_pipe
 * @pure
 * @affects regenerates 1 pipe
 * @failure unknown pipe / bad value / no change -> no-op
 */
export const updatePipe = defineCommand({
  name: 'update_pipe',
  description:
    'Edit a drainage pipe: diameter, material, Manning n, end invert elevations or name. ' +
    'Endpoints (fromId / toId) cannot change; delete and re-add the pipe instead.',
  params: z.object({
    pipeId: z.string().describe('Pipe id, e.g. "pipe-1".'),
    ...pipeFields,
  }),
  run: (doc, params): CommandResult => {
    const civil = getCivil(doc);
    const pipe = civilObject(civil, params.pipeId, 'pipe');
    if (!pipe) return noop(doc, `update_pipe failed: no pipe ${params.pipeId}.`);
    const problem = checkPipeValues(params);
    if (problem !== null) return noop(doc, `update_pipe failed: ${problem}`);
    const updated: PipeObject = {
      ...pipe,
      name: params.name?.trim() || pipe.name,
      diameter: params.diameter ?? pipe.diameter,
      material: params.material?.trim() || pipe.material,
      manningN: params.manningN ?? pipe.manningN,
      invertFrom: params.invertFrom ?? pipe.invertFrom,
      invertTo: params.invertTo ?? pipe.invertTo,
    };
    if (JSON.stringify(updated) === JSON.stringify(pipe))
      return noop(doc, `update_pipe: nothing to change on ${pipe.id}.`);
    const length = pipePlanLength(civil, updated) ?? 0;
    const adverse =
      updated.invertFrom <= updated.invertTo ? ' Warning: adverse or zero slope.' : '';
    return commitCivil(
      doc,
      withObject(civil, updated),
      [updated.id],
      `Updated pipe ${updated.name} (${updated.id}): slope ${slopeText(updated, length)}, ` +
        `${updated.material}, n ${updated.manningN}.${adverse}`,
    );
  },
});

export const drainagePipeCommands = [addPipe, updatePipe];
