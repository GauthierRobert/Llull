/** 09 PLM M3: snapshots externalized to the local vault (TR-PLM-13): externalize_snapshots, the history guard, load validation, integrity and repair. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext, ObjectStorePort } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { released } from './fixtures';
import { agentContext, run } from './scenarioRunner';

/** A vault port over a map: `get` re-hashes like the real store. */
const storeOf = (objects: Record<string, string>): ObjectStorePort => ({
  has: (sha) => objects[sha] !== undefined && sha256Hex(objects[sha]) === sha,
  get: (sha) => (objects[sha] !== undefined && sha256Hex(objects[sha]) === sha ? objects[sha] : null),
});

function vaulted(): { doc: CadDocument; objects: Record<string, string>; ctx: ExecutionContext; text: string; hash: string } {
  const doc = released();
  const revision = doc.plm?.item.revisions['A'];
  const text = revision?.snapshot?.kind === 'inline' ? revision.snapshot.canonicalJson : '';
  const hash = revision?.contentHash ?? '';
  const objects: Record<string, string> = { [hash]: text };
  return { doc, objects, ctx: { ...agentContext(), objects: storeOf(objects) }, text, hash };
}

const externalized = (): ReturnType<typeof vaulted> & { out: CadDocument } => {
  const base = vaulted();
  return { ...base, out: run(base.doc, 'externalize_snapshots', {}, base.ctx).document };
};

describe('externalize_snapshots', () => {
  it('replaces the inline snapshot by a vault reference once the vault returns the same verified text; the definition and hashes are untouched', () => {
    const { doc, ctx, hash } = vaulted();
    const before = JSON.stringify(doc);
    const result = run(doc, 'externalize_snapshots', {}, ctx);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.rejected).toBeUndefined();
    expect(result.summary).toContain('now in the vault');
    expect(result.document.plm?.item.revisions['A']?.snapshot).toEqual({ kind: 'vault', objectSha256: hash });
    expect(result.document.plm?.item.revisions['A']?.contentHash).toBe(hash);
    expect(result.document.entities).toBe(doc.entities);
    expect(result.document.featureHistory).toBe(doc.featureHistory);
    expect(result.affected).toEqual([]);
  });

  it('needs no human signature (an agent runs it) and is idempotent: nothing left to do reports so', () => {
    const { out, ctx } = externalized();
    const again = run(out, 'externalize_snapshots', {}, ctx);
    expect(again.document).toBe(out);
    expect(again.summary).toContain('nothing to do');
  });

  it('refuses, unchanged, without a vault port, when the object is absent or damaged, and for an unknown revision', () => {
    const { doc, objects, hash } = vaulted();
    const refusal = (ctx: ExecutionContext | undefined, params: unknown = {}): string | undefined =>
      run(doc, 'externalize_snapshots', params, ctx).error?.code;
    expect(refusal(agentContext())).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(refusal({ ...agentContext(), objects: storeOf({}) })).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(refusal({ ...agentContext(), objects: storeOf({ [hash]: `${objects[hash]} ` }) })).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(refusal({ ...agentContext(), objects: storeOf(objects) }, { revision: 'Z' })).toBe('PLM_REVISION_UNKNOWN');
    expect(run(createEmptyDocument(), 'externalize_snapshots', {}).error?.code).toBe('PLM_NOT_MANAGED');
  });

  it('a revision without a frozen snapshot is skipped', () => {
    const { doc, ctx } = vaulted();
    const inWork = run(doc, 'create_change_order', { id: 'ECO-7', classification: 'minor', classificationJustification: 'j' }).document;
    const revised = run(inWork, 'revise_item', { changeOrder: 'ECO-7' }).document;
    const result = run(revised, 'externalize_snapshots', { revision: 'B' }, ctx);
    expect(result.document).toBe(revised);
    expect(result.summary).toContain('nothing to do');
  });
});

describe('an externalized snapshot in the document', () => {
  it('keeps the release lock and the history guard: frozen history cannot change, and the lock still refuses edits', () => {
    const { out } = externalized();
    expect(run(out, 'set_parameter', { name: 't', expression: '9' }).error?.code).toBe('PLM_LOCKED');
    const rewritten = {
      ...out,
      plm: {
        ...out.plm,
        item: {
          ...out.plm?.item,
          revisions: { A: { ...out.plm?.item.revisions['A'], snapshot: { kind: 'vault', objectSha256: 'e'.repeat(64) } } },
        },
      },
    } as unknown as CadDocument;
    const loaded = run(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({ format: 'llull-document', version: 3, document: rewritten }),
    });
    expect(loaded.summary).toContain('vault reference whose object is not the content hash');
    expect(loaded.document.plm).toBeUndefined();
  });

  it('reads, verifies and views the revision through the port, and reports PLM_VAULT_OBJECT_MISSING without it', () => {
    const { out, ctx } = externalized();
    expect(run(out, 'verify_release', { revision: 'A' }, ctx).summary).toContain('verified');
    expect(run(out, 'view_revision', { revision: 'A' }, ctx).rejected).toBeUndefined();
    expect(run(out, 'plm_diff', { from: 'A', to: 'A' }, ctx).rejected).toBeUndefined();
    expect(run(out, 'verify_release', { revision: 'A' }, agentContext()).error?.code).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(run(out, 'view_revision', { revision: 'A' }, agentContext()).error?.code).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(run(out, 'plm_diff', { from: 'A', to: 'WORKING' }, agentContext()).error?.code).toBe('PLM_NO_SNAPSHOT');
  });

  it('integrity reads ok with the object present, a mismatch when the vault lost it, and ok on load (no vault to ask)', () => {
    const { out, ctx, objects, hash } = externalized();
    expect((run(out, 'plm_status', {}, ctx).data as { integrity: Record<string, string> }).integrity['A']).toBe('ok');
    const lost = { ...agentContext(), objects: storeOf({ ...objects, [hash]: 'gone' }) };
    expect((run(out, 'plm_status', {}, lost).data as { integrity: Record<string, string> }).integrity['A']).toBe('mismatch');
    const loaded = run(createEmptyDocument(), 'load_document', {
      json: JSON.stringify({ format: 'llull-document', version: 3, document: out }),
    });
    expect(loaded.summary).not.toContain('mismatch');
  });

  it('restore_revision_snapshot repairs a tampered definition from the vault object, and refuses without it', () => {
    const { out, ctx } = externalized();
    const tampered = {
      ...out,
      parameters: { ...out.parameters, t: { ...(out.parameters['t'] ?? { name: 't' }), expression: '99', value: 99 } },
    } as unknown as CadDocument;
    expect(run(tampered, 'restore_revision_snapshot', { revision: 'A' }, agentContext()).error?.code).toBe('PLM_VAULT_OBJECT_MISSING');
    const repaired = run(tampered, 'restore_revision_snapshot', { revision: 'A' }, ctx);
    expect(repaired.rejected, repaired.summary).toBeUndefined();
    expect(repaired.summary).toContain('restored');
  });
});
