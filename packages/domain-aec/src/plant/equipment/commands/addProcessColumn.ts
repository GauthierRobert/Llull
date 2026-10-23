import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { execute } from '@core/commands/registry';
import { fromMm } from '@core/model/units';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { getBuilding, withElement } from '../../../building/model';
import { refuse } from '../model';
import type { TraySpec } from '../plantData';
import { vesselShape } from './addVessel';
import { inConvention, platformClipsSchema, resolveClips, trayOverflow, trayRows, traysSchema } from './columnParams';

/**
 * @affects creates 1 vertical vessel element exactly as add_vessel (composed through execute) and records its trays and platform clips;
 *   the clips are derived partial rings on the shell
 * @invariant tray i is at firstElevation + (i - 1) x spacing above the bottom tangent line; trays are data only (internals draw no geometry)
 * @failure last tray above the tangent length -> EQP_TRAYS_DONT_FIT (nothing is created); every add_vessel refusal passes through unchanged
 */
export const addProcessColumn = defineCommand({
  name: 'add_process_column',
  description:
    'Create a PROCESS column (distillation / absorption tower; not the structural add_column): a VERTICAL vessel (same parameters as add_vessel, orientation is implied: heads {top, bottom}, support skirt / legs) ' +
    'with a tray stack and platform clips. trays { count, spacing, firstElevation (above the bottom tangent line), type } must fit in the tangent ' +
    'length (EQP_TRAYS_DONT_FIT otherwise, path trays.count). platformClips [{ elevation, fromDeg, toDeg, depth, height }] are shell attachments for ' +
    'platforms (angles read with angleConvention). Returns add_vessel data plus trays[{ index, elevation }] and clips[]. Trays are internals: no geometry.',
  params: z.object({ ...vesselShape, trays: traysSchema.optional(), platformClips: platformClipsSchema.optional() }),
  run: (doc, params, ctx): CommandResult => {
    const { trays, platformClips, ...vessel } = params;
    if (trays !== undefined) {
      const overflow = trayOverflow(trays, vessel.tangentLength);
      if (overflow !== null)
        return refuse(
          doc,
          'add_process_column',
          'EQP_TRAYS_DONT_FIT',
          `${trays.count} trays at spacing ${trays.spacing} from ${trays.firstElevation} put the last tray at ${overflow}, above the tangent length ${vessel.tangentLength}`,
          [],
          ['trays.count'],
        );
    }
    const convention = vessel.angleConvention ?? 'north_cw';
    const clips = resolveClips(platformClips ?? [], convention, vessel.tangentLength, {
      depth: fromMm(doc, 100),
      height: fromMm(doc, 100),
    });
    if (!Array.isArray(clips)) return refuse(doc, 'add_process_column', 'EQP_PARAM_INVALID', clips.message, [], [clips.path]);
    const added = execute(doc, 'add_vessel', { ...vessel, orientation: 'vertical' }, ctx);
    const data = added.data as Record<string, unknown> | undefined;
    const elementId = data?.['elementId'];
    const element = typeof elementId === 'string' ? added.document.building?.elements[elementId] : undefined;
    if (added.rejected === true || element?.category !== 'equipment' || element.plant?.template.kind !== 'vessel')
      return { ...added, summary: `add_process_column: ${added.summary}` };
    const traySpec: TraySpec | undefined =
      trays === undefined
        ? undefined
        : {
            count: trays.count,
            spacing: trays.spacing,
            firstElevation: trays.firstElevation,
            ...(trays.type === undefined ? {} : { type: trays.type }),
          };
    const template = {
      ...element.plant.template,
      ...(traySpec === undefined ? {} : { trays: traySpec }),
      ...(clips.length === 0 ? {} : { platformClips: clips }),
    };
    const next = { ...element, plant: { ...element.plant, template } };
    const rows = traySpec === undefined ? [] : trayRows(traySpec);
    return commitBuilding(
      added.document,
      withElement(getBuilding(added.document), next),
      [next.id],
      `add_process_column: ${next.mark} (${next.id}) vertical column, ${rows.length} tray(s)${rows.length > 0 ? ` from ${rows[0]?.elevation} to ${rows[rows.length - 1]?.elevation}` : ''}, ${clips.length} platform clip(s).`,
      { ...data, trays: rows, clips: clips.map((clip) => inConvention(clip, convention)) },
    );
  },
});
