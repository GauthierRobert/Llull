/**
 * Contacts of fastener stacks without geometry (PHY-13 TR-COR-04 / FR-COR-03). The stacks are plain document data of the `fasteners` plugin
 * (`CadDocument.fasteners.stacks`), read here through a narrow structural view: no import of that plugin.
 */

import { isRecord } from '@lib/isRecord';
import type { CadDocument } from '@core/model/types';

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** `[a, b]` ordered so a < b. */
const ordered = (a: string, b: string): readonly [string, string] => (a < b ? [a, b] : [b, a]);

function stackPairs(stack: Record<string, unknown>): Array<readonly [string, string]> {
  const layers = (Array.isArray(stack['layers']) ? stack['layers'] : []).map((layer) => (isRecord(layer) ? text(layer['entityId']) : null));
  const fastener = isRecord(stack['fastener']) ? text(stack['fastener']['instanceId']) : null;
  const nut = isRecord(stack['nut']) ? text(stack['nut']['instanceId']) : null;
  const washers = (Array.isArray(stack['washers']) ? stack['washers'] : []).filter(isRecord);
  const washerOn = (side: string): string | null => text(washers.find((washer) => washer['side'] === side)?.['instanceId']);
  const solid = layers.filter((layer): layer is string => layer !== null);
  const pairs: Array<readonly [string, string]> = [];
  if (fastener !== null) for (const layer of solid) pairs.push(ordered(fastener, layer));
  solid.slice(1).forEach((layer, index) => {
    const previous = solid[index];
    if (previous !== undefined) pairs.push(ordered(previous, layer));
  });
  const head = washerOn('head');
  const tail = washerOn('nut');
  const [first] = solid;
  const last = solid[solid.length - 1];
  if (head !== null && first !== undefined) pairs.push(ordered(head, first));
  if (tail !== null && last !== undefined) pairs.push(ordered(tail, last));
  if (nut !== null) {
    const against = tail ?? last;
    if (against !== undefined) pairs.push(ordered(nut, against));
  }
  return pairs.filter(([a, b]) => a !== b);
}

/**
 * Unordered pairs `[a, b]` (a < b) that touch by construction in the placed fastener stacks: fastener to each layer, layer to the next layer, washer to the
 * adjacent layer (head washer on the first, nut-side washer on the last), nut to its washer (or to the last layer). Deduplicated, sorted.
 * @invariant pure; a malformed or absent fasteners slice yields no pair
 */
export function stackContacts(doc: CadDocument): Array<readonly [string, string]> {
  const slice: unknown = (doc as { readonly fasteners?: unknown }).fasteners;
  const stacks = isRecord(slice) && isRecord(slice['stacks']) ? Object.values(slice['stacks']).filter(isRecord) : [];
  const unique = new Map<string, readonly [string, string]>();
  for (const stack of stacks) for (const pair of stackPairs(stack)) unique.set(pair.join('|'), pair);
  return [...unique.values()].sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
}
