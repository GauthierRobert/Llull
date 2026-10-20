/** Interference intents: pairs of parts that are allowed to overlap, with the reason (PHY-21 FR-FPR-05). */

import type { CadDocument } from '../../model/types';
import { createPrototypeModel, INTENT_KINDS, type InterferenceIntent, type PrototypeModel } from '../../model/prototype';
import { is3D } from '../../model/types';
import { nextId } from '../../lib/id';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, failer } from '../noop';

export function prototypeOf(doc: CadDocument): PrototypeModel {
  return doc.prototype ?? createPrototypeModel();
}

/**
 * @affects adds 1 intent to doc.prototype.intents (affected: [intentId], id `fit-<step>.<k>`)
 * @invariant stored pair is sorted (a < b); declaredBy is 'agent': ExecutionContext carries no caller yet, so the conservative value is
 *   recorded (a human badge needs the interim human gate, spec 11 Q5)
 * @failure a = b, unknown or 2D id, empty reason, pair already declared -> no-op
 */
export const allowInterference = defineCommand({
  name: 'allow_interference',
  description:
    'Declare that two parts are MEANT to overlap (a press fit, a thread, a weld, or an overlap by design), so check_assembly reports the ' +
    'pair as FPR_PAIR_ALLOWED (pass, with your reason shown) instead of FPR_PAIR_HARD. Welds, threads and press fits also count as rigid ' +
    'connections when check_assembly decides whether a part is attached (FPR_PART_FLOATING). The declaration is stored in the document, ' +
    'is never applied silently and is listed in every check. Refused when a = b, an id is unknown or 2D, the reason is empty, or the ' +
    'pair already has an intent (remove_interference_intent first). Returns the intent id (fit-<step>.<k>) in affected[0]. Next: ' +
    'check_assembly.',
  params: z.object({
    a: z.string().describe('Entity or instance id of the first part.'),
    b: z.string().describe('Entity or instance id of the second part (different from a).'),
    kind: z.enum(INTENT_KINDS).describe('"press_fit", "thread", "weld" (rigid connections) or "overlap_by_design" (overlap only).'),
    reason: z
      .string()
      .describe('Why the overlap is intended, e.g. "pin pressed into piston boss, 0.02 mm interference". Must be non-empty.'),
  }),
  run: (doc, { a, b, kind, reason }): CommandResult => {
    const fail = failer(doc, 'allow_interference');
    if (a === b) return fail('a and b must be two different parts');
    for (const id of [a, b]) {
      const entity = doc.entities[id];
      if (entity === undefined) return fail(`entity '${id}' not found`);
      if (!is3D(entity)) return fail(`entity '${id}' is 2D (${entity.kind}); intents apply to solids and instances`);
    }
    if (reason.trim().length === 0) return fail('reason must be non-empty');
    const prototype = prototypeOf(doc);
    const [first, second] = a < b ? [a, b] : [b, a];
    const existing = Object.values(prototype.intents).find((intent) => intent.a === first && intent.b === second);
    if (existing !== undefined)
      return fail(`pair ${first} / ${second} already has intent '${existing.id}' (${existing.kind}); remove_interference_intent first`);
    const id = nextId('fit');
    const intent: InterferenceIntent = { id, a: first, b: second, kind, reason: reason.trim(), declaredBy: 'agent' };
    const document = { ...doc, prototype: { ...prototype, intents: { ...prototype.intents, [id]: intent } } };
    return changed(document, `Declared ${kind} between '${first}' and '${second}' as ${id} (by agent): ${intent.reason}.`, [id]);
  },
});

/**
 * @affects removes 1 intent from doc.prototype.intents (affected: [id])
 * @failure unknown intent id -> no-op
 */
export const removeInterferenceIntent = defineCommand({
  name: 'remove_interference_intent',
  description:
    'Remove a declared interference intent (fit-<step>.<k>, from allow_interference). The pair is checked as an ordinary overlap again. ' +
    'Unknown id: no-op. Next: check_assembly.',
  params: z.object({ id: z.string().describe('Intent id returned by allow_interference, e.g. "fit-3.1".') }),
  run: (doc, { id }): CommandResult => {
    const prototype = doc.prototype;
    const intent = prototype?.intents[id];
    if (prototype === undefined || intent === undefined) return failer(doc, 'remove_interference_intent')(`no intent '${id}'`);
    const intents = Object.fromEntries(Object.entries(prototype.intents).filter(([key]) => key !== id));
    return changed(
      { ...doc, prototype: { ...prototype, intents } },
      `Removed intent ${id} (${intent.kind} between '${intent.a}' and '${intent.b}').`,
      [id],
    );
  },
});
