/**
 * Contacts of fastener stacks without geometry (PHY-13 TR-COR-04 / FR-COR-03). The stacks come from the read-only command `list_fastener_stacks`
 * composed through `execute` (L10: no import of the fasteners plugin, no knowledge of its slice); the answer is validated structurally and a stack
 * that does not validate is reported, never silently dropped.
 */

import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** `[a, b]` ordered so a < b. */
const ordered = (a: string, b: string): readonly [string, string] => (a < b ? [a, b] : [b, a]);

export interface StackContacts {
  readonly pairs: Array<readonly [string, string]>;
  /** Stacks whose entry in the answer is malformed: their contacts are unknown. */
  readonly skipped: Array<{ readonly id: string; readonly reason: string }>;
}

/** The pairs of one validated entry, or why it is malformed. */
function entryPairs(entry: Record<string, unknown>): Array<readonly [string, string]> | string {
  const layersRaw = entry['layers'];
  const fastener = text(entry['fastenerInstanceId']);
  const washersRaw = entry['washers'];
  if (!Array.isArray(layersRaw) || !Array.isArray(washersRaw) || fastener === null)
    return 'layers, washers or fastenerInstanceId is missing in the list_fastener_stacks answer';
  const solid = layersRaw.map((layer) => (isRecord(layer) ? text(layer['entityId']) : null));
  const washers = washersRaw.map((washer) => (isRecord(washer) ? { id: text(washer['instanceId']), side: washer['side'] } : null));
  const nut = entry['nutInstanceId'] === undefined ? undefined : text(entry['nutInstanceId']);
  if (
    solid.length === 0 ||
    solid.some((id) => id === null) ||
    washers.some((washer) => washer === null || washer.id === null || (washer.side !== 'head' && washer.side !== 'nut')) ||
    nut === null
  )
    return 'a layer, washer or nut id is malformed in the list_fastener_stacks answer';
  const layers = solid.filter((id): id is string => id !== null);
  const sideId = (side: string): string | null => washers.find((washer) => washer?.side === side)?.id ?? null;
  const pairs: Array<readonly [string, string]> = layers.map((layer) => ordered(fastener, layer));
  layers.slice(1).forEach((layer, index) => {
    const previous = layers[index];
    if (previous !== undefined) pairs.push(ordered(previous, layer));
  });
  const [first] = layers;
  const last = layers[layers.length - 1];
  const head = sideId('head');
  const tail = sideId('nut');
  if (head !== null && first !== undefined) pairs.push(ordered(head, first));
  if (tail !== null && last !== undefined) pairs.push(ordered(tail, last));
  const against = tail ?? last;
  if (nut !== undefined && against !== undefined) pairs.push(ordered(nut, against));
  return pairs.filter(([a, b]) => a !== b);
}

/**
 * Unordered pairs `[a, b]` (a < b) that touch by construction in the stacks of a `list_fastener_stacks` answer: fastener to each layer, layer to the next
 * layer, washer to the adjacent layer (head washer on the first, nut-side washer on the last), nut to its washer (or to the last layer). Deduplicated, sorted.
 * @invariant pure; never throws on a hostile answer: a malformed entry is listed in `skipped`
 */
export function stackPairsOf(stacks: unknown): StackContacts {
  const unique = new Map<string, readonly [string, string]>();
  const skipped: Array<{ id: string; reason: string }> = [];
  (Array.isArray(stacks) ? stacks : []).forEach((entry, index) => {
    const id = isRecord(entry) ? (text(entry['id']) ?? `#${index}`) : `#${index}`;
    const pairs = isRecord(entry) ? entryPairs(entry) : 'the entry is not an object';
    if (typeof pairs === 'string') skipped.push({ id, reason: pairs });
    else for (const pair of pairs) unique.set(pair.join('|'), pair);
  });
  const sorted = [...unique.values()].sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
  return { pairs: sorted, skipped };
}

/**
 * The stack contacts of the document, through `list_fastener_stacks`.
 * @invariant a document without the fasteners plugin (the command is unknown) has no stacks
 */
export function stackContacts(doc: CadDocument): StackContacts {
  const answer = execute(doc, 'list_fastener_stacks', {});
  if (answer.rejected === true || !isRecord(answer.data)) return { pairs: [], skipped: [] };
  return stackPairsOf(answer.data['stacks']);
}
