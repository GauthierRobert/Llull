/**
 * Connection graph (FR-FPR-06): parts are nodes; joints, rigid-body membership, declared welds / threads / press fits and contacts are
 * edges. A component with no grounded member floats; a part held only by touch contacts is resting only.
 * @invariant order-independent: components are listed by their first part in the input order
 */

import type { CheckItem } from '../../model/checkResult';
import { makeItem } from './partValidity';

export interface ConnectivityInput {
  /** Every part id, in document order. */
  readonly parts: readonly string[];
  /** Rigid links (same body, joint, weld / thread / press-fit intent, hard or allowed overlap). */
  readonly strongLinks: ReadonlyArray<readonly [string, string]>;
  /** Contact links that hold nothing by themselves (touch). */
  readonly touchLinks: ReadonlyArray<readonly [string, string]>;
  /** Parts attached to the world. */
  readonly grounded: ReadonlySet<string>;
}

function components(parts: readonly string[], links: ReadonlyArray<readonly [string, string]>): string[][] {
  const parent = new Map(parts.map((id) => [id, id] as const));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    for (let step = id; step !== root; ) {
      const next = parent.get(step) ?? root;
      parent.set(step, root);
      step = next;
    }
    return root;
  };
  for (const [a, b] of links) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const [rootA, rootB] = [find(a), find(b)];
    if (rootA !== rootB) parent.set(rootB, rootA);
  }
  const groups = new Map<string, string[]>();
  for (const id of parts) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()];
}

/** `FPR_PART_FLOATING` (fail) per ungrounded component, `FPR_PART_RESTING_ONLY` (warn) per component held by touch alone. */
export function connectivityItems(input: ConnectivityInput): CheckItem[] {
  const items: CheckItem[] = [];
  const touching = components(input.parts, [...input.strongLinks, ...input.touchLinks]);
  const isGrounded = (group: readonly string[]): boolean => group.some((id) => input.grounded.has(id));
  for (const group of touching) {
    if (isGrounded(group)) continue;
    items.push(
      makeItem(
        'FPR_PART_FLOATING',
        'fail',
        group,
        'Attach the group: add a joint or fastener to a grounded part, mark a part with set_part_grounded, or remove it.',
        { values: { parts: group.length } },
      ),
    );
  }
  const floating = new Set(items.flatMap((entry) => entry.ids));
  for (const group of components(input.parts, input.strongLinks)) {
    if (group.every((id) => floating.has(id)) || isGrounded(group)) continue;
    items.push(
      makeItem(
        'FPR_PART_RESTING_ONLY',
        'warn',
        group,
        'These parts are held only by contact: add a joint or a fastener (weld, thread, press fit via allow_interference).',
        { values: { parts: group.length } },
      ),
    );
  }
  return items;
}
