/** select_fastener (query), insert_fastener_stack and delete_fastener_stack (08 MAT FR-MAT-12/15, M5-M6). */

import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { fastenerError, refuse } from './codes';
import { fastenerModel, withFasteners } from './fastenerDoc';
import { type HoleMode, holeDiameterDoc, placeStack } from './placeStack';
import { quantity, selectionFields, selectionSchema } from './selectionParams';
import { type SelectionOutcome, runSelection } from './selection';

export const holeFields = {
  holeMode: z
    .enum(['cut_close_tolerance', 'cut_clearance', 'none'])
    .describe(
      'Hole cut through every plate of the stack with the geometry kernel: "cut_close_tolerance" (default, diameter from the catalogue size or holeDiameter), ' +
        '"cut_clearance" (clearance diameter from the catalogue or holeDiameter) or "none" (no cut).',
    )
    .optional(),
  holeDiameter: quantity(
    'Hole diameter as { value, unit }; overrides the catalogue hole diameter. Required when the catalogue lists none',
  ).optional(),
};

const insertSchema = z.object({ ...selectionFields, ...holeFields });

const brief = (outcome: SelectionOutcome): string => {
  const data = outcome.data;
  const washers =
    Array.isArray(data['washers']) && data['washers'].length > 0
      ? ` + washers [${(data['washers'] as Array<{ partNumber: string }>).map((w) => w.partNumber).join(', ')}]`
      : '';
  return `${String(data['partNumber'])} (length ${String(data['lengthIn'])} in)${washers}`;
};

/**
 * @affects nothing (query)
 * @failure unknown family/size, missing stack, stack out of range, unshimmable gap, short protrusion -> data.ok = false with coded reasons[] and error
 */
export const selectFastener = defineCommand({
  name: 'select_fastener',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Select the fastener for a stack (read-only): grip dash, part number, shim washers, length and thread protrusion. Give family and diameterDash ' +
    '(list_fastener_families), and the stack either as stack { value, unit } or as stackIds + axisPoint (+ axis) measured along the axis. Optional nut and ' +
    'washer family ids (same diameter dash) enable the protrusion check and shimming. Bolts use the smallest grip >= stack (washers fill the gap, total <= 1/8 in ' +
    'by default, at most 3); Hi-Lok pins use the grip whose range contains the stack; rivets use stack + 1.5 D rounded to the catalogue step. Every rule left ' +
    'at its default is listed in data.rules with source and defaulted: true. Failures return data.ok = false with reasons[] (FAST_STACK_OUT_OF_RANGE, ' +
    'FAST_WASHER_GAP, FAST_PROTRUSION_SHORT, ...). All lengths in data are inches (…In). Next: insert_fastener_stack.',
  params: selectionSchema,
  run: (doc, params): CommandResult => {
    const outcome = runSelection(doc, params);
    if (outcome.ok) return report(doc, `select_fastener: ${brief(outcome)} for stack ${String(outcome.data['stackIn'])} in.`, outcome.data);
    const failure = outcome.failure;
    return {
      ...report(
        doc,
        `select_fastener: no fastener — ${failure?.message ?? 'failed'} (${failure?.code ?? 'unknown'}); no-op.`,
        outcome.data,
      ),
      error: fastenerError(failure?.code ?? 'FAST_STACK_OUT_OF_RANGE', failure?.ids ?? []),
    };
  },
});

/**
 * @affects plates (cut in place: same id and order slot, mesh replaced, material/name/tags carried over), components (one per part number, created once), instances (fastener, washers, nut), fasteners.stacks
 * @invariant one feature step; ids step-scoped (fst-<step>.<k>); undo restores the document exactly
 * @failure selection not ok, hole diameter unknown, kernel cut fails, stack given as a bare number -> unchanged document with a coded error
 */
export const insertFastenerStack = defineCommand({
  name: 'insert_fastener_stack',
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  description:
    'Insert one fastener stack through plates: runs the select_fastener rules, cuts the hole through every plate (exact boolean with the kernel), and places the bolt/pin/rivet, ' +
    'shim washers and nut as instances of one component per part number (created once; geometry from the catalogue dimensions, or flagged representative placeholders ' +
    'that are excluded from mass). Needs stackIds + axisPoint (+ axis, head to nut direction). holeMode picks the cut; holeDiameter {value, unit} overrides the catalogue. ' +
    'Records the stack in the document (id fst-<step>.<k>, returned in data.stackId); bill_of_materials then lists the standard parts. Refused selections change nothing. ' +
    'Next: check_fastener_layout, bill_of_materials. Delete with delete_fastener_stack (holes stay: undo to restore the plates).',
  params: insertSchema,
  run: (doc, params, ctx): CommandResult => {
    const outcome = runSelection(doc, params);
    if (!outcome.ok || outcome.resolved === null)
      return {
        ...refuse(
          doc,
          'insert_fastener_stack',
          outcome.failure?.code ?? 'FAST_STACK_OUT_OF_RANGE',
          outcome.failure?.message ?? 'selection failed',
          outcome.failure?.ids ?? [],
        ),
        data: outcome.data,
      };
    const mode: HoleMode = params.holeMode ?? 'cut_close_tolerance';
    const diameter = holeDiameterDoc(doc, outcome.resolved, mode, params.holeDiameter);
    if (typeof diameter !== 'number')
      return { ...refuse(doc, 'insert_fastener_stack', diameter.code, diameter.message, diameter.ids), data: outcome.data };
    const placed = placeStack(doc, ctx, outcome.resolved, mode, diameter);
    if (!placed.ok) return { ...refuse(doc, 'insert_fastener_stack', placed.code, placed.message, placed.ids), data: outcome.data };
    const warnings = [
      ...(outcome.data['warnings'] as unknown[]),
      ...placed.representative.map((partNumber) => ({
        code: 'FAST_GEOMETRY_REPRESENTATIVE',
        message: `${partNumber} uses placeholder proportions; excluded from mass`,
      })),
    ];
    const stack = placed.stack;
    return {
      ...changed(
        placed.document,
        `Inserted fastener stack ${stack.id}: ${brief(outcome)}${stack.nut ? ` + ${stack.nut.partNumber}` : ''} through ${stack.layers.length} layer(s), stack ${outcome.data['stackIn'] as number} in, hole ${mode === 'none' ? 'not cut' : `Ø${diameter.toPrecision(5)} ${doc.units}`}; ` +
          `${placed.affected.length} entities created/modified.${warnings.length > 0 ? ` ${warnings.length} warning(s).` : ''}`,
        [...placed.affected],
      ),
      data: { stackId: stack.id, stack, selection: outcome.data, warnings },
    };
  },
});

/**
 * @affects removes the stack record and its instances (bolt, washers, nut); plates and holes are untouched
 * @failure unknown stack id -> no-op naming the id (FAST_STACK_NOT_FOUND)
 */
export const deleteFastenerStack = defineCommand({
  name: 'delete_fastener_stack',
  annotations: { destructive: true },
  description:
    'Delete fastener stacks by id: removes the stack record and its bolt/pin/rivet, washer and nut instances. The holes cut in the plates stay (undo restores them). ' +
    'Fastener instances cannot be removed with delete_entities; use this. Unknown ids are refused (FAST_STACK_NOT_FOUND) and nothing changes.',
  params: z.object({
    stackIds: z.array(z.string()).describe('Ids of the stacks to delete (fst-…), as returned by insert_fastener_stack in data.stackId.'),
  }),
  run: (doc, { stackIds }, ctx): CommandResult => {
    const stacks = fastenerModel(doc).stacks;
    const missing = stackIds.filter((id) => !Object.hasOwn(stacks, id));
    if (stackIds.length === 0 || missing.length > 0)
      return refuse(
        doc,
        'delete_fastener_stack',
        'FAST_STACK_NOT_FOUND',
        stackIds.length === 0 ? 'stackIds is empty' : `stack(s) [${missing.join(', ')}] not found`,
        missing,
      );
    const doomed = stackIds.flatMap((id) => {
      const stack = stacks[id];
      return stack === undefined
        ? []
        : [stack.fastener.instanceId, ...stack.washers.map((washer) => washer.instanceId), ...(stack.nut ? [stack.nut.instanceId] : [])];
    });
    const remaining = Object.fromEntries(Object.entries(stacks).filter(([id]) => !stackIds.includes(id)));
    const withoutRecords = withFasteners(doc, { stacks: remaining });
    const removed = execute(withoutRecords, 'delete_entities', { ids: doomed }, ctx);
    return changed(
      removed.document,
      `Deleted fastener stack(s) [${stackIds.join(', ')}] and ${doomed.length} instance(s). Holes in the plates remain.`,
      doomed,
    );
  },
});
