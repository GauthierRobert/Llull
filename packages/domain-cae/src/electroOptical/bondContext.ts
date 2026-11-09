/**
 * What a bond check reads from the rest of the document, each through a read-only command composed with `execute` (no plugin internals): which solids touch
 * (`find_contacts`, with the solids it did NOT test), which touch by construction in a fastener stack (`list_fastener_stacks`) and which solids carry a
 * surface system (`list_surface_systems`). An answer that cannot be read makes the dependent finding `unknown`, never a pass.
 */

import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import type { BondPath } from './types';

export interface SurfaceSystemView {
  readonly id: string;
  readonly entityIds: readonly string[];
  readonly layers: readonly string[];
}

export interface BondContext {
  /** Contacting pairs of the joint solids; null when no joint names its solids. */
  readonly contacts: ReadonlySet<string> | null;
  /** Solid id (root) -> why find_contacts did not test it; '*' = the skipped list could not be read, so nothing is confirmed. */
  readonly untested: ReadonlyMap<string, string>;
  /** Pairs that touch by construction in a placed fastener stack. */
  readonly stackPairs: ReadonlySet<string>;
  readonly systems: readonly SurfaceSystemView[];
}

/** The solid at the root of an id (an assembly child `instance/child` counts as `instance`). */
const rootOf = (id: string): string => id.split('/')[0] ?? id;

/** `a|b` ordered over the roots of both ids. */
export const pairKey = (a: string, b: string): string => [rootOf(a), rootOf(b)].sort().join('|');

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The unordered pairs of consecutive layers of every well-formed stack; a malformed entry gives no evidence (never an invented contact). */
export function stackPairsOf(answer: CommandResult): ReadonlySet<string> {
  const pairs = new Set<string>();
  const stacks = answer.rejected === true || !isRecord(answer.data) ? [] : answer.data['stacks'];
  for (const stack of Array.isArray(stacks) ? stacks : []) {
    const layers =
      isRecord(stack) && Array.isArray(stack['layers'])
        ? stack['layers'].map((layer) => (isRecord(layer) ? text(layer['entityId']) : null))
        : [];
    layers.forEach((layer, index) => {
      const next = layers[index + 1];
      if (layer !== null && next !== null && next !== undefined) pairs.add(pairKey(layer, next));
    });
  }
  return pairs;
}

export function systemsOf(answer: CommandResult): readonly SurfaceSystemView[] {
  const list = answer.rejected === true || !isRecord(answer.data) ? [] : answer.data['systems'];
  return (Array.isArray(list) ? list : []).flatMap((system): SurfaceSystemView[] => {
    if (!isRecord(system) || text(system['id']) === null || !Array.isArray(system['entityIds']) || !Array.isArray(system['layers']))
      return [];
    return [
      {
        id: String(system['id']),
        entityIds: system['entityIds'].filter((id): id is string => typeof id === 'string'),
        layers: system['layers'].map((layer) => (isRecord(layer) && typeof layer['class'] === 'string' ? layer['class'] : 'unreadable')),
      },
    ];
  });
}

/** The solids find_contacts reported as not tested; '*' when the list or an entry of it is malformed. */
export function untestedOf(data: unknown): Map<string, string> {
  const skipped = isRecord(data) ? data['skipped'] : undefined;
  const untested = new Map<string, string>();
  if (!Array.isArray(skipped)) return untested.set('*', 'the skipped list of find_contacts is unreadable');
  for (const entry of skipped) {
    const id = isRecord(entry) ? text(entry['id']) : null;
    if (id === null) untested.set('*', 'a skipped entry of find_contacts is malformed');
    else untested.set(rootOf(id), isRecord(entry) && typeof entry['reason'] === 'string' ? entry['reason'] : 'no reason given');
  }
  return untested;
}

/** The context of `paths`, or the find_contacts refusal to return as is. */
export function bondContext(
  doc: CadDocument,
  paths: readonly BondPath[],
  ctx: ExecutionContext | undefined,
): BondContext | { readonly refusal: CommandResult } {
  const systems = systemsOf(execute(doc, 'list_surface_systems', {}, ctx));
  const joined = [
    ...new Set(paths.flatMap((path) => path.elements.flatMap((element) => (element.kind === 'joint' ? (element.interfaces ?? []) : [])))),
  ].filter((id) => Object.hasOwn(doc.entities, id));
  if (joined.length === 0) return { contacts: null, untested: new Map(), stackPairs: new Set(), systems };
  const found = execute(doc, 'find_contacts', { entityIds: joined }, ctx);
  if (found.error !== undefined) return { refusal: found };
  const pairs = isRecord(found.data) && Array.isArray(found.data['pairs']) ? found.data['pairs'] : [];
  const contacts = new Set(
    pairs.flatMap((pair) =>
      isRecord(pair) && typeof pair['a'] === 'string' && typeof pair['b'] === 'string' ? [pairKey(pair['a'], pair['b'])] : [],
    ),
  );
  return { contacts, untested: untestedOf(found.data), stackPairs: stackPairsOf(execute(doc, 'list_fastener_stacks', {}, ctx)), systems };
}
