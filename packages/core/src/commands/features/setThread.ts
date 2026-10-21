/**
 * set_thread (07 FTR M2, FR-FTR-19 / FR-FTR-20): the thread attribute of a hole feature. Cosmetic: geometry and `recipeKey` never change.
 * Modelled: the part is re-evaluated with the helical groove (kernel required).
 */

import type { HoleSpec, ThreadSpec } from '../../model/features';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { editFeatureNode, featureNodes } from '../../geometry/featureInstances';
import { evaluateRecipe } from '../kernelShape';
import { MAX_THREAD_TURNS } from '../../geometry/threadTool';
import { refuse } from './ftr';
import { resolveModelledThread, threadBoreProblem } from './modelledThread';
import { parseThread, threadSchema } from './threads';

const withThread = (hole: HoleSpec, thread: ThreadSpec | null): HoleSpec => {
  const copy: { -readonly [K in keyof HoleSpec]: HoleSpec[K] } = { ...hole };
  if (thread === null) delete copy.thread;
  else copy.thread = thread;
  return copy;
};

/**
 * @affects modifies 1 mesh entity: the thread of one hole feature in its recipe (same id)
 * @invariant kernel-optional: a cosmetic change needs no ctx.kernel; a modelled-thread change needs ctx.kernel and refuses FTR_NEEDS_EXACT_KERNEL without it. A cosmetic change keeps the shape recipe key and the mesh; `thread: null` removes the attribute; adding or removing a modelled thread rebuilds the mesh
 * @failure missing entity / no such hole feature (FTR_PART_NOT_FOUND), designation fails its family grammar or has no modelled form (FTR_THREAD_DESIGNATION_INVALID),
 *   bore does not fit the modelled thread (FTR_HOLE_DIAMETERS_INCONSISTENT), no kernel (FTR_NEEDS_EXACT_KERNEL), kernel cannot build it (FTR_FEATURE_BUILD_FAILED) -> rejected no-op
 */
export const setThread = defineCommand({
  name: 'set_thread',
  description:
    'Set (or remove) the thread of a hole feature made by add_hole: a designation such as "MJ6x1-4H5H" or ".1900-32 UNJF-3B", ' +
    'checked against a light per-family grammar. By default it is a cosmetic attribute for drawings, hole_table and code export; the geometry ' +
    'and the shape recipe key are NOT changed. With thread.modelled true the part is rebuilt with a real helical groove (basic 60 degree ' +
    'internal profile, explicit pitch required, bore near the minor diameter; needs a geometry kernel). featureIndex counts the hole/pocket features of the part in the order they were cut (0 = first add_hole or ' +
    'add_pocket on the original solid); hole ids in hole_table read hole-<featureIndex>.<position>. Refusal codes: FTR_PART_NOT_FOUND, ' +
    'FTR_THREAD_DESIGNATION_INVALID, FTR_HOLE_DIAMETERS_INCONSISTENT, FTR_NEEDS_EXACT_KERNEL, FTR_FEATURE_BUILD_FAILED.',
  params: z.object({
    id: z.string().describe('Id of the mesh entity made by add_hole.'),
    featureIndex: z
      .number()
      .int()
      .min(0)
      .describe('Index of the hole feature among the part features (add_hole / add_pocket steps in cutting order, from 0).'),
    thread: threadSchema
      .nullable()
      .describe(
        'The thread to set, or null to remove it. designation is checked against its family grammar; depth is in document length units.',
      ),
  }),
  run: (doc, { id, featureIndex, thread }, ctx): CommandResult => {
    const entity = doc.entities[id];
    const nodes = entity?.kind === 'mesh' && entity.brep !== undefined ? featureNodes(entity.brep) : [];
    const node = nodes[featureIndex];
    if (entity?.kind !== 'mesh' || entity.brep === undefined || node?.feature !== 'hole')
      return refuse(
        doc,
        'set_thread',
        'FTR_PART_NOT_FOUND',
        entity === undefined ? `entity '${id}' not found` : `'${id}' has no hole feature number ${featureIndex}`,
        'pass a mesh made by add_hole and a featureIndex of one of its holes',
        [id],
        entity === undefined ? ['id'] : ['featureIndex'],
      );
    const parsed = thread === null ? null : parseThread(thread);
    if (thread !== null && parsed === null)
      return refuse(
        doc,
        'set_thread',
        'FTR_THREAD_DESIGNATION_INVALID',
        `thread designation '${thread.designation}' fails the grammar of its family`,
        "use the family's designation form, e.g. MJ6x1-4H5H",
        [id],
        ['thread.designation'],
      );
    const resolved = parsed === null ? null : resolveModelledThread(doc, parsed);
    if (typeof resolved === 'string')
      return refuse(
        doc,
        'set_thread',
        'FTR_THREAD_DESIGNATION_INVALID',
        resolved,
        'use an explicit pitch, e.g. M6x1',
        [id],
        ['thread.designation'],
      );
    const spec = resolved;
    if (node.hole.thread?.modelled !== true && spec?.modelled !== true) {
      const brep = editFeatureNode(entity.brep, featureIndex, (current) =>
        current.feature === 'hole' ? { ...current, hole: withThread(current.hole, spec) } : current,
      );
      const what = spec === null ? 'removed the thread' : `thread ${spec.designation} (${spec.family}, cosmetic)`;
      return changed(
        { ...doc, entities: { ...doc.entities, [id]: { ...entity, brep } } },
        `set_thread: ${what} on hole feature ${featureIndex} of '${id}'; geometry and recipe key unchanged.`,
        [id],
      );
    }
    const fit = spec === null ? null : threadBoreProblem({ ...node.hole, thread: spec });
    if (fit !== null)
      return refuse(
        doc,
        'set_thread',
        'FTR_HOLE_DIAMETERS_INCONSISTENT',
        fit,
        'recreate the hole with a bore near the minor diameter',
        [id],
        ['thread'],
      );
    const kernel = ctx?.kernel;
    if (kernel === undefined || kernel === null)
      return refuse(
        doc,
        'set_thread',
        'FTR_NEEDS_EXACT_KERNEL',
        'a modelled thread changes the geometry and needs a geometry kernel',
        'run with a kernel installed',
        [id],
      );
    const brep = editFeatureNode(entity.brep, featureIndex, (current) =>
      current.feature === 'hole' ? { ...current, hole: withThread(current.hole, spec) } : current,
    );
    const rebuilt = evaluateRecipe(kernel, brep);
    if (rebuilt === 'refused' || rebuilt === 'empty')
      return refuse(
        doc,
        'set_thread',
        'FTR_FEATURE_BUILD_FAILED',
        `the kernel could not build the thread (${rebuilt}); a modelled thread is refused past ${MAX_THREAD_TURNS} turns`,
        'check the bore against the thread and the depth',
        [id],
      );
    const what =
      spec === null
        ? 'removed the modelled thread'
        : `thread ${spec.designation} (${spec.family}, ${spec.modelled === true ? 'modelled helical groove, basic profile' : 'cosmetic'})`;
    return changed(
      { ...doc, entities: { ...doc.entities, [id]: { ...entity, mesh: rebuilt.mesh, brep: rebuilt.recipe } } },
      `set_thread: ${what} on hole feature ${featureIndex} of '${id}'; mesh rebuilt (${rebuilt.mesh.indices.length / 3} triangles).`,
      [id],
    );
  },
});
