/**
 * blend_union: weld several solids into one exact piece and round every joint where they meet — the "one-piece frame" operation (tubes +
 * lugs + dropouts → a single blended carbon frame).
 */

import { type Entity, type ShapeRecipe, is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { noop, failer } from '../noop';
import { blendRejection } from './blendCodes';
import { jointSchema, planJoints } from './blendJoints';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { round6 } from '../../lib/compactNumber';
import { operandRecipe } from '../../geometry/operandRecipe';
import { OCC_KERNEL_HINT } from './modifyTarget';

const MAX_BLEND_OPERANDS = 200;

/** `[CODE] joints[i].path: message` as the kernel words a refusal about a pick. */
const KERNEL_PICK_REFUSAL =
  /^\[(BLD_JOINT_PARAMS|BLD_LAW_NOT_PERIODIC|REF_LOST|REF_SPLIT)\]\s*(joints(?:\[\d+\])?(?:\.\w+)?):\s*([\s\S]*)$/;

/**
 * @affects removes the operand solids; creates 1 mesh entity (their union, joints filleted)
 * @invariant >= 2 distinct 3D solids; radius > 0; a kernel with fillets (OCC); every joint has `radius` except the joints (and their tangent chains) a `joints` pick names (by persistent name, else nearest to near), which have the pick's radius or radius law; a pick by near records the name of its joint (recordExtras joints[].name; with a "#k" name also joints[].nameMid, the midpoint of the joint) so regeneration follows the joint; a name and near together: the name wins and the summary / data.joints[].nearIgnored say near is ignored
 * @failure missing / duplicate / 2D / instance operand, bad radius, no kernel, kernel lacks blends, kernel refusal (radius too large for a
 *   joint) -> no-op, affected:[]; a joint radius <= 0, two radii (laws) on one tangent chain, a pick farther than 10 x its radius from every joint, no joint to pick, a pick with neither near nor name, a varying law on a joint chained with others -> BLD_JOINT_PARAMS (path joints[i].near / .radius / .radiusEnd); a bad law -> BLD_LAW_INVALID; a law that does not close on a closed joint -> BLD_LAW_NOT_PERIODIC; a "#k" joint whose midpoint moved more than 10 x its radius since it was recorded (the numbering of two faces' joints changed) -> REF_LOST; interior sizes on a closed joint that do not mirror about t = 1/2 -> BLD_LAW_NOT_PERIODIC (path joints[i].sizes); a joint name that no joint has (REF_LOST) or that several have (REF_SPLIT) (path joints[i].name)
 * data = { joints [{ index, distanceToJoint, radius, radiusEnd?, name, start, end }], unit } when joints were given
 */
export const blendUnion = defineCommand({
  name: 'blend_union',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Weld 2+ solids into ONE exact solid and round every joint where they meet with a fillet: ' +
    'the one-piece frame operation (bike frame tubes, lugs and dropouts; pipe tees; brackets welded to ' +
    'plates; organic joints between swept or lofted parts). All intersection curves created by the ' +
    'union are filleted with `radius`; `joints` [{ near | name, radius, radiusEnd?, sizes?, interpolation?, law? }] gives a joint (picked by its persistent name, or the one nearest to a point) ' +
    'its own radius or a radius law along it (the whole tangent chain of that joint: one radius per chain, two different radii on one chain are refused; a radius that varies along a joint ' +
    'needs a joint alone in its tangent chain). The name of a joint picked by point is recorded in the step and used on regeneration (REF_LOST / REF_SPLIT when the joint is gone or split); ' +
    'data.joints[].name lists it, with the start and end of the joint edge (the law runs from start to end). The operands are consumed and replaced by one mesh entity that ' +
    'keeps the exact construction (STEP export, further fillets and booleans see true faces). ' +
    `Needs the exact kernel (check kernel_info): ${OCC_KERNEL_HINT}; with the mesh kernel it cannot fillet and no-ops ` +
    '(use boolean op union there). If the kernel refuses, try another radius: a blend must fit inside ' +
    'the smallest wall it touches, and a crotch where three solids meet can reject specific radii.',
  params: z.object({
    ids: z.array(z.string()).describe('Ids of the 3D solids to weld (>= 2, distinct). The first one styles the result.'),
    radius: z.number().describe('Joint fillet radius in document units (> 0), for every joint that has no entry in joints.'),
    joints: z
      .array(jointSchema)
      .describe(
        'Per-joint radii and radius laws: each entry picks a joint by name (wins) or the joint nearest to near and rounds it (with the joints tangent to it) with its radius (law) instead of the default radius. Several entries may name the same chain only with the same radius; a point farther than 10 x its radius from every joint is refused (BLD_JOINT_PARAMS). The result reports each pick distance to its joint (distanceToJoint), its name, start and end in data.joints.',
      )
      .optional(),
  }),
  run: (doc, { ids, radius, joints }, ctx): CommandResult => {
    const fail = failer(doc, 'blend_union');
    if (ids.length < 2 || ids.length > MAX_BLEND_OPERANDS) return fail(`needs 2..${MAX_BLEND_OPERANDS} solids (got ${ids.length})`);
    if (new Set(ids).size !== ids.length) return fail('ids must be distinct');
    if (!(radius > 0)) return fail(`radius must be > 0 (got ${radius})`);
    const operands: Entity[] = [];
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail(`entity '${id}' not found`);
      if (!is3D(entity)) return fail(`entity '${id}' is a 2D shape; blends need 3D solids`);
      if (entity.kind === 'instance') return fail(`entity '${id}' is a component instance; run explode_instance first`);
      operands.push(entity);
    }
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('blend_union'));
    if (!kernel.supports('blend')) return fail(`this kernel cannot fillet joints; use ${OCC_KERNEL_HINT}, or boolean op union`);
    const given = joints ?? [];
    const planned = planJoints(given);
    if ('refusal' in planned)
      return blendRejection(doc, 'blend_union', planned.refusal.code, planned.refusal.message, ids, [planned.refusal.path]);
    const recipe: ShapeRecipe = {
      op: 'blend',
      sources: operands.map((entity) => operandRecipe(kernel, entity)),
      radius,
      ...(planned.joints.length === 0 ? {} : { joints: planned.joints }),
    };
    const result = evaluateRecipe(kernel, recipe);
    if (result === 'refused') {
      const why = kernel.blendReport?.(recipe)?.message;
      const coded = KERNEL_PICK_REFUSAL.exec(why ?? '');
      if (coded !== null) return blendRejection(doc, 'blend_union', coded[1] ?? '', coded[3] ?? '', ids, [coded[2] ?? 'joints']);
      return fail(
        `the kernel could not blend the joints of [${ids.join(', ')}] with radius ${radius}${why === undefined || why === '' ? '' : ` (${why})`}; try another radius (smaller usually fits; a crotch where 3 solids meet can reject specific radii)`,
      );
    }
    if (result === 'empty') return fail('the union is empty or could not be meshed as a closed solid');
    const committed = commitKernelResult(
      doc,
      kernel,
      result,
      operands as [Entity, ...Entity[]],
      (newId, triangles) =>
        `blend_union: welded ${ids.length} solids [${ids.join(', ')}] into one piece '${newId}' with joints filleted (radius ${radius}; ${triangles} triangles). Operands consumed.`,
    );
    const picks = kernel.blendReport?.(recipe)?.notes?.picks;
    if (committed.document === doc || picks === undefined || picks.length === 0) return committed;
    // a pick by point records the name of its joint, so a later regeneration follows the joint (names win over points)
    const recorded = given.map((joint, at) => {
      const pick = picks[at];
      if (joint.name !== undefined || pick?.name === undefined) return joint;
      // "#k" names number the joints of two faces by position: the midpoint recorded with one lets a regeneration refuse a joint that took the number over
      return { ...joint, name: pick.name, ...(pick.name.includes('#') && pick.mid !== undefined ? { nameMid: pick.mid } : {}) };
    });
    const ignored = given.flatMap((joint, at) => (joint.name !== undefined && joint.near !== undefined ? [{ at, name: joint.name }] : []));
    return {
      ...committed,
      ...(ignored.length === 0
        ? {}
        : {
            summary: `${committed.summary} ${ignored.map((entry) => `joints[${entry.at}] picked by name ${entry.name}; near ignored`).join('; ')} (edit name to move the pick).`,
          }),
      data: {
        joints: picks.map((pick, at) => ({
          index: at,
          distanceToJoint: round6(pick.distance),
          radius: pick.radius,
          ...(planned.joints[at]?.radiusEnd === undefined ? {} : { radiusEnd: planned.joints[at]?.radiusEnd }),
          ...(pick.name === undefined ? {} : { name: pick.name }),
          ...(ignored.some((entry) => entry.at === at) ? { nearIgnored: true } : {}),
          ...(pick.start === undefined ? {} : { start: pick.start }),
          ...(pick.end === undefined ? {} : { end: pick.end }),
        })),
        unit: doc.units,
      },
      ...(recorded.every((joint, at) => joint === given[at]) ? {} : { recordExtras: { joints: recorded } }),
    };
  },
});
