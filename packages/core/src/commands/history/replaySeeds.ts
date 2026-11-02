import type { CadDocument } from '../../model/types';
import { isRecord } from '../../lib/isRecord';

/** The merged seed and the dotted paths where two plugins seeded different values for the same leaf (a plugin bug, caught by the contract test). */
interface MergedSeeds {
  readonly seed: Partial<CadDocument>;
  readonly conflicts: readonly string[];
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, path: string, conflicts: string[]): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    const here = path === '' ? key : `${path}.${key}`;
    if (existing === undefined) target[key] = value;
    else if (isRecord(existing) && isRecord(value)) {
      const child: Record<string, unknown> = { ...existing };
      mergeInto(child, value, here, conflicts);
      target[key] = child;
    } else if (JSON.stringify(existing) !== JSON.stringify(value)) conflicts.push(here);
  }
}

/**
 * Deep-merge of the plugins' replay seeds: two plugins may seed different sub-slices of the same top-level key (e.g. `plant.spec` and `plant.fabrication`).
 * @invariant no seed is mutated; on a conflicting leaf the first plugin's value is kept and the path is reported
 */
export function mergeReplaySeeds(seeds: readonly Partial<CadDocument>[]): MergedSeeds {
  const seed: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const entry of seeds) mergeInto(seed, entry as Record<string, unknown>, '', conflicts);
  return { seed: seed as Partial<CadDocument>, conflicts };
}
