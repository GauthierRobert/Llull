/** The canonical manifests a human signs (FR-PLM-20/21, §5.7, §6.1): the release manifest of a frozen revision and the manifest of an iteration. */

import type { PlmModel, Revision, SignatureRecord } from '@core/model/plm';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';

export interface SigningManifest {
  readonly body: Readonly<Record<string, unknown>>;
  /** The exact UTF-8 text that is signed: the canonical JSON of `body`. */
  readonly canonical: string;
  readonly sha256: string;
}

const seal = (body: Record<string, unknown>): SigningManifest => {
  const canonical = jcsJson(body);
  return { body, canonical, sha256: sha256Hex(canonical) };
};

/**
 * The release manifest body of a released / superseded / obsolete revision: identity, state, change, effectivity, marking, release stamp, document
 * content hash, tool provenance, the unverified flags present at release and, for an assembly, the structure frozen at release. The host adds the package members when it writes the package.
 * @invariant a pure function of the PLM record at release (deterministic: no clock, no tool version; unchanged when the revision is later superseded,
 *   so signatures stay valid)
 */
export function releaseManifest(
  plm: PlmModel,
  revision: Revision,
  meaning: SignatureRecord['meaning'] = 'release',
): SigningManifest | null {
  if (revision.contentHash === undefined) return null;
  const eco = revision.changeOrder === undefined ? undefined : plm.changes[revision.changeOrder];
  return seal({
    schema: 'llull-release-manifest/0.1',
    meaning,
    item: { partNumber: plm.item.partNumber, name: plm.item.name, revision: revision.label, iteration: revision.iterations.length },
    lifecycleState: 'released',
    change:
      eco === undefined
        ? null
        : { eco: eco.id, purpose: eco.purpose, ...(eco.classification !== undefined ? { classification: eco.classification } : {}) },
    effectivity: revision.releasedEffectivity ?? revision.effectivity,
    marking: revision.releasedMarking ?? plm.item.marking,
    releasedAt: revision.releasedAt ?? null,
    releasedBy: revision.releasedBy ?? null,
    documentContentHash: revision.contentHash,
    tool: { name: 'llull', releaseScopeFormat: 2 },
    reviewRequired: [],
    unverified: revision.unverified ?? [],
    ...(revision.releasedStructure !== undefined ? { structure: revision.releasedStructure } : {}),
  });
}

/** The manifest of one iteration (`A.2`): what an approver signs before release. */
export function iterationManifest(
  plm: PlmModel,
  revision: Revision,
  n: number,
  meaning: SignatureRecord['meaning'] = 'approval',
): SigningManifest | null {
  const iteration = revision.iterations[n - 1];
  if (iteration === undefined) return null;
  return seal({
    schema: 'llull-iteration-manifest/0.1',
    meaning,
    item: { partNumber: plm.item.partNumber, name: plm.item.name, revision: revision.label, iteration: n },
    contentHash: iteration.contentHash,
  });
}

/** The manifest a signature target refers to, or null when the target does not exist (yet). */
export function manifestFor(plm: PlmModel, target: SignatureRecord['target'], meaning: SignatureRecord['meaning']): SigningManifest | null {
  if (target.kind === 'release') {
    const revision = plm.item.revisions[target.ref];
    return revision === undefined ? null : releaseManifest(plm, revision, meaning);
  }
  const [label, n] = target.ref.split('.');
  const revision = label === undefined ? undefined : plm.item.revisions[label];
  return revision === undefined ? null : iterationManifest(plm, revision, Number(n), meaning);
}
