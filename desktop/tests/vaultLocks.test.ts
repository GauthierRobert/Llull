/** File > Vault (09 PLM M3, VC-PLM-23): two app launches on one vault, exclusive locks with the holder named, check-in of the live document, stale-lock break. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@server/plugins';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { currentHolder } from '@server/plm/vault/vault';
import { partNumberOf, vaultCheckIn, vaultCheckOut, vaultItems, type VaultDeps } from '../src/vault';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-desktop-vault-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date('2026-11-02T09:00:00Z');

/** One app launch: its own identity and its own live document (`json` = the last document loaded into it). */
function launch(user: string, session: string, start: CadDocument): VaultDeps & { live: () => CadDocument } {
  let live = start;
  return {
    dir: path.join(dir, 'vault'),
    holder: currentHolder({ LLULL_USER: user }, session),
    now: () => NOW,
    currentDocument: () => Promise.resolve(live),
    loadDocument: (json) => {
      live = deserializeDocument(json);
      return Promise.resolve();
    },
    live: () => live,
  };
}

const managed = (): CadDocument =>
  execute(createEmptyDocument(), 'set_item_identity', {
    partNumber: 'LL-2001',
    name: 'Bracket',
    itemType: 'part',
    at: '2026-11-02T09:00:00Z',
    by: 'u-1',
  }).document;

describe('File > Vault', () => {
  it('checks a new item in (locking it first), then a second launch checks it out and cannot check it in over the first', async () => {
    const a = launch('alice', 'desk-A', managed());
    expect(await vaultCheckIn(a)).toContain('LL-2001 rev A iteration');
    expect(a.live().plm?.item.revisions['A']?.iterations.length).toBeGreaterThanOrEqual(1);
    expect(vaultItems(a.dir)).toEqual(['LL-2001']);
    const b = launch('bob', 'desk-B', createEmptyDocument());
    expect(await vaultCheckOut(b, 'LL-2001')).toContain('checked out');
    expect(b.live().plm?.item.partNumber).toBe('LL-2001');
    const again = launch('alice', 'desk-C', managed());
    expect(await vaultCheckOut(again, 'LL-2001')).toContain('PLM_VAULT_LOCKED');
    expect(await vaultCheckOut(again, 'LL-2001')).toContain('bob');
    expect(await vaultCheckIn(a)).toContain('PLM_VAULT_LOCKED');
    expect(await vaultCheckIn(b)).toContain('checked in');
    expect(await vaultCheckOut(again, 'LL-2001')).toContain('checked out');
  });

  it('a new part number gets the lock without a head; an unmanaged document cannot be checked in', async () => {
    const a = launch('alice', 'desk-A', createEmptyDocument());
    expect(await vaultCheckOut(a, 'LL-7')).toContain('new to this vault');
    expect(await vaultCheckIn(a)).toContain('Only a managed item');
  });

  it('decodes item folders back to part numbers', () => {
    expect(partNumberOf('LL%2F2001')).toBe('LL/2001');
    expect(partNumberOf('LL-1')).toBe('LL-1');
    expect(vaultItems(path.join(dir, 'none'))).toEqual([]);
  });
});
