/** Orphaned corrosion entries (PHY-13 COR-b): entries naming a solid or material the document no longer has, and acceptances of findings whose parts are gone. */

import type { CadDocument } from '@core/model/types';
import { type CorrosionEntry, corrosionReferences } from './guard';
import { corrosionOf } from './model';
import { rootOf } from './resolve';

export interface OrphanedEntry {
  readonly kind: CorrosionEntry['kind'] | 'acceptance';
  readonly id: string;
  readonly code: 'COR_REFERENCE_ORPHANED';
  /** The entity or material ids the entry names that the document no longer has. */
  readonly missing: readonly string[];
  readonly remedy: string;
}

const ACCEPTANCE_REMEDY = 'none needed: the acceptance applies to no finding and never counts; it stays as the signed record';
const REMOVER: Readonly<Record<CorrosionEntry['kind'], string>> = {
  surface_system: 'remove_surface_system',
  isolation: 'remove_isolation',
  galvanic_group: 'remove_galvanic_group',
};

const order = (p: string, q: string): number => (p < q ? -1 : p > q ? 1 : 0);

/** The ids an acceptance item key names (`galvanic:<a>|<b>`); a `skipped:<id>` key names nothing: accept_corrosion_item never accepts a skipped item, so such a key is not a real acceptance. */
const idsOfKey = (key: string): string[] => (key.startsWith('galvanic:') ? key.slice('galvanic:'.length).split('|') : []);

/**
 * Every orphaned entry, sorted by kind then id. Surface systems, isolations and galvanic groups are guarded (corrosionReferenceGuard), so they dangle
 * only in a file written before the guard; acceptances are never guarded (a deleted part ends its finding).
 */
export function orphanedEntries(doc: CadDocument): OrphanedEntry[] {
  const byEntry = new Map<string, { entry: CorrosionEntry; missing: Set<string> }>();
  for (const reference of corrosionReferences(doc)) {
    if (Object.hasOwn(doc[reference.kind], reference.id)) continue;
    const key = `${reference.entry.kind}:${reference.entry.id}`;
    const held = byEntry.get(key) ?? { entry: reference.entry, missing: new Set<string>() };
    held.missing.add(reference.id);
    byEntry.set(key, held);
  }
  const entries: OrphanedEntry[] = [...byEntry.values()].map(({ entry, missing }) => ({
    kind: entry.kind,
    id: entry.id,
    code: 'COR_REFERENCE_ORPHANED',
    missing: [...missing].sort(),
    remedy: `${REMOVER[entry.kind]} '${entry.id}'`,
  }));
  for (const key of Object.keys(corrosionOf(doc).acceptances)) {
    const missing = [...new Set(idsOfKey(key).map(rootOf))].filter((id) => !Object.hasOwn(doc.entities, id)).sort();
    if (missing.length > 0)
      entries.push({ kind: 'acceptance', id: key, code: 'COR_REFERENCE_ORPHANED', missing, remedy: ACCEPTANCE_REMEDY });
  }
  return entries.sort((x, y) => order(x.kind, y.kind) || order(x.id, y.id));
}
