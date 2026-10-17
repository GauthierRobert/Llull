/** holes_from_recognition (07 FTR FR-FTR-25, VC-FTR-32): the recognised holes of an exact solid as a `build_project` plan of `add_hole` steps. */

import { type CadDocument, is3D } from '../../model/types';
import type { FtrResultMeta } from '../../model/manufacturing';
import { toRadians } from '../../lib/angle';
import { recognizeFeatures as recognize } from '../../geometry/recognition/recognize';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { operandRecipe } from '../brep/kernelShape';
import { report } from '../noop';
import { refuse, resultMeta } from './ftr';
import { lengthToleranceOf, recognitionOf } from './recognition';
import { type HolePlanAction, holePlan } from './holePlan';

export interface HolePlanData extends FtrResultMeta {
  readonly entityId: string;
  readonly stock: string;
  /** Pass to `build_project` as `actions`. */
  readonly actions: readonly HolePlanAction[];
  readonly holes: number;
  /** Indices (into the recognised hole list) whose classification is ambiguous. */
  readonly ambiguous: readonly number[];
}

/**
 * @affects nothing — read-only
 * @invariant data.actions = one add_hole step per group of identical holes (kind, diameters, extent, entrance plane), in recognition order
 * @failure missing / non-solid entity (FTR_PART_NOT_FOUND), no exact kernel or no face graph (FTR_NEEDS_EXACT_KERNEL) -> rejected no-op, no data
 */
export const holesFromRecognition = defineCommand({
  name: 'holes_from_recognition',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Turn the holes recognised on an exact 3D solid (an imported STEP part, see recognize_features) into a build_project plan of add_hole ' +
    'steps: data.actions, one step per group of identical holes (same kind, diameters, depth, drill point and entrance plane) with their ' +
    'world positions. The first step cuts into `stock`, the entity or "$alias" you will drill (a plain stock whose faces contain the hole ' +
    'entrances); each next step cuts into the previous result. Lengths are in the document length unit, angles in degrees; a blind hole always ' +
    'carries its drill point angle (0 = flat). Holes whose classification is ambiguous are included and listed in data.ambiguous. Needs an ' +
    'exact kernel: otherwise refused with FTR_NEEDS_EXACT_KERNEL (also FTR_PART_NOT_FOUND). Next: build_project with data.actions.',
  params: z.object({
    id: z.string().describe('Id of the 3D solid (mesh with an exact B-rep) whose holes are read.'),
    stock: z
      .string()
      .describe('Entity id (or "$alias" of an earlier plan step) of the solid the plan drills; the first add_hole step targets it.'),
  }),
  run: (doc: CadDocument, { id, stock }, ctx): CommandResult => {
    const entity = doc.entities[id];
    if (!entity || !is3D(entity) || entity.kind === 'instance')
      return refuse(doc, 'holes_from_recognition', 'FTR_PART_NOT_FOUND', `no 3D solid '${id}'`, 'pass a solid id', [id], ['id']);
    const kernel = (ctx ?? currentContext()).kernel;
    const input = kernel === null ? 'no_port' : recognitionOf(kernel, operandRecipe(kernel, entity));
    if (typeof input === 'string')
      return refuse(
        doc,
        'holes_from_recognition',
        'FTR_NEEDS_EXACT_KERNEL',
        input === 'no_port'
          ? 'this kernel has no face-query port (no exact B-rep)'
          : 'the kernel could not build the face graph of this solid',
        'rerun with --kernel occt; for imported parts use import_step_exact',
        [id],
      );
    const found = recognize(
      input.graph,
      input.topology,
      { kinds: ['hole'], mergeSplitFaces: true, angularTolerance: toRadians(1e-4), lengthTolerance: lengthToleranceOf(input.topology) },
      input.orientation,
    );
    const actions = holePlan(found.holes, stock);
    const ambiguous = found.holes.flatMap((hole, index) => (hole.confidence === 'exact' ? [] : [index]));
    const data: HolePlanData = {
      ...resultMeta(doc, { formulas: { plan: 'one add_hole per group of identical holes' }, sources: ['07 FTR FR-FTR-25'] }),
      entityId: id,
      stock,
      actions,
      holes: found.holes.length,
      ambiguous,
    };
    return report(
      doc,
      `holes_from_recognition: '${id}' has ${found.holes.length} holes in ${actions.length} add_hole steps targeting '${stock}'` +
        `${ambiguous.length === 0 ? '' : `; ${ambiguous.length} ambiguous (data.ambiguous)`}. Pass data.actions to build_project. ` +
        'Computed by llull, not approved — a qualified person must review before manufacture.',
      data,
    );
  },
});
