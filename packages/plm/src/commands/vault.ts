/** externalize_snapshots: move frozen release snapshots out of the document into the local vault (M3, TR-PLM-13); the content hash proves them. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { Revision } from '@plm/types';
import { refusePlm } from '../refusal';
import { NOT_MANAGED } from '../state';
import { withPlm } from '../revisions';

/**
 * @affects doc.plm.item.revisions[*].snapshot (inline -> { kind: 'vault', objectSha256 }); nothing else
 * @invariant a snapshot leaves the document only when the vault already returns an object that re-hashes to the revision's content hash and equals the
 *   inline text: the evidence never exists in fewer places than before
 * @failure no vault port, or the object absent / damaged -> PLM_VAULT_OBJECT_MISSING; unknown revision -> PLM_REVISION_UNKNOWN (refusals, unchanged doc)
 */
export const externalizeSnapshots = defineCommand({
  name: 'externalize_snapshots',
  description:
    'Replace the inline release snapshots of frozen revisions (released, superseded, obsolete) with references to the local vault object of the same ' +
    'SHA-256, so the document stays small. The host (`llull vault checkin`) writes the objects first; this command verifies that the vault returns text ' +
    'equal to the inline snapshot and hashing to the revision content hash, and only then drops the inline copy. Needs the vault reachable (LLULL_VAULT). ' +
    'Changes no definition and confers no authority, so it needs no human signature. revision = one label; absent = every frozen revision still inline.',
  annotations: { idempotent: true, metaHistory: true },
  params: z.object({ revision: z.string().optional().describe('Revision label; absent = every frozen revision with an inline snapshot.') }),
  run: (doc, { revision: only }, ctx): CommandResult => {
    const plm = doc.plm;
    if (plm === undefined) return refusePlm(doc, 'externalize_snapshots', 'PLM_NOT_MANAGED', NOT_MANAGED);
    if (only !== undefined && plm.item.revisions[only] === undefined)
      return refusePlm(doc, 'externalize_snapshots', 'PLM_REVISION_UNKNOWN', `${plm.item.partNumber} has no revision '${only}'`, [only]);
    const revisions: Record<string, Revision> = { ...plm.item.revisions };
    const moved: string[] = [];
    for (const label of only === undefined ? plm.item.revisionOrder : [only]) {
      const revision = revisions[label];
      if (revision?.snapshot?.kind !== 'inline' || revision.contentHash === undefined) continue;
      const hash = revision.contentHash;
      if (ctx?.objects?.get(hash) !== revision.snapshot.canonicalJson)
        return refusePlm(
          doc,
          'externalize_snapshots',
          'PLM_VAULT_OBJECT_MISSING',
          `the vault has no verified object ${hash.slice(0, 12)}… for ${plm.item.partNumber} rev ${label} (check in first, with LLULL_VAULT set)`,
          [label],
        );
      revisions[label] = { ...revision, snapshot: { kind: 'vault', objectSha256: hash } };
      moved.push(label);
    }
    if (moved.length === 0) return report(doc, 'externalize_snapshots: no frozen revision with an inline snapshot; nothing to do.');
    return changed(
      withPlm(doc, { ...plm, item: { ...plm.item, revisions } }),
      `${plm.item.partNumber}: snapshot of rev ${moved.join(', ')} now in the vault (${moved.length} revision(s)).`,
      [],
    );
  },
});
