/**
 * Persistent face / edge references (SC-N1). An exact kernel with history names every face after where it came from
 * (`<entity>:<role>`, carried through each operation by the kernel's own history) and every edge after the faces that meet there
 * (`e(<face>|<face>)`, `#k` when one pair meets more than once). A feature records the names of what it picked; on regeneration the names
 * are looked up again on the new topology: one match = the same edge or face, none = the reference was lost, several = it was split.
 * Kernels without names (Manifold) leave the recorded points / indices in charge, flagged unverified.
 */

import type { ShapeTopology } from '../kernel';

export type ReferenceKind = 'edge' | 'face';

export type ReferenceResolution =
  | { readonly ok: true; readonly indices: number[] }
  | { readonly ok: false; readonly lost: readonly string[]; readonly split: readonly string[] };

type Named = { readonly index: number; readonly name?: string };

const itemsOf = (topology: ShapeTopology, kind: ReferenceKind): readonly Named[] => (kind === 'edge' ? topology.edges : topology.faces);

/** Every edge (or face) of `topology` carries a persistent name: the kernel tracks history. */
export function hasNames(topology: ShapeTopology | null, kind: ReferenceKind): topology is ShapeTopology {
  if (topology === null) return false;
  const items = itemsOf(topology, kind);
  return items.length > 0 && items.every((item) => typeof item.name === 'string' && item.name.length > 0);
}

/** `name` and its split images: an edge recorded as `e(A|B)` matches `e(A|B)#1`, `e(A|B)#2` once the pair meets twice. */
function matches(candidate: string, name: string): boolean {
  return candidate === name || (!name.includes('#') && candidate.startsWith(`${name}#`));
}

/**
 * The indices named by `names`, each name resolving to exactly one edge / face; otherwise the names that found none (`lost`) and those
 * that found several (`split`).
 */
export function resolveNames(topology: ShapeTopology, kind: ReferenceKind, names: readonly string[]): ReferenceResolution {
  const items = itemsOf(topology, kind);
  const indices: number[] = [];
  const lost: string[] = [];
  const split: string[] = [];
  for (const name of names) {
    const found = items.filter((item) => item.name !== undefined && matches(item.name, name));
    if (found.length === 0) lost.push(name);
    else if (found.length > 1) split.push(name);
    else if (found[0] !== undefined) indices.push(found[0].index);
  }
  return lost.length === 0 && split.length === 0 ? { ok: true, indices } : { ok: false, lost, split };
}

/** The persistent names of `indices`, or null when one of them has none. */
export function namesOf(topology: ShapeTopology | null, kind: ReferenceKind, indices: readonly number[]): string[] | null {
  if (!hasNames(topology, kind)) return null;
  const items = itemsOf(topology, kind);
  const names = indices.map((index) => items[index]?.name);
  return names.every((name): name is string => name !== undefined) ? names : null;
}

/** One line for a lost / split reference: what happened (SC-N2). */
export function referenceProblem(kind: ReferenceKind, resolution: Extract<ReferenceResolution, { ok: false }>): string {
  const parts: string[] = [];
  if (resolution.lost.length > 0) parts.push(`REF_LOST ${kind} ${resolution.lost.join(', ')} (no longer on the solid)`);
  if (resolution.split.length > 0) parts.push(`REF_SPLIT ${kind} ${resolution.split.join(', ')} (now several ${kind}s)`);
  return parts.join('; ');
}
