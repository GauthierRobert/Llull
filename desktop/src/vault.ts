/**
 * File > Vault (09 PLM M3): check the open document in to, or a managed item out of, this machine's vault. Electron-free: the dialogs and the live
 * document are injected. The vault itself (objects, refs, locks, audit) is `server/src/plm/vault`; the document changes only through commands inside
 * `checkIn` (`checkpoint_iteration`, `externalize_snapshots`) and reaches the app through `load_document`.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { LockHolder } from '@server/plm/vault/locks';
import { VaultError, checkIn, checkOut, initVault, readRefs } from '@server/plm/vault/vault';

export interface VaultDeps {
  /** The vault folder (created on first use). */
  readonly dir: string;
  /** This launch's identity for locks: two launches of the app on one vault are two holders. */
  readonly holder: LockHolder;
  readonly now?: () => Date;
  /** The live document of the app. */
  readonly currentDocument: () => Promise<CadDocument>;
  /** Replace the live document with `json` (a serialized document): `load_document`. */
  readonly loadDocument: (json: string) => Promise<void>;
}

const clock = (deps: VaultDeps): Date => (deps.now ?? ((): Date => new Date()))();

/** Part number of an item folder name (the inverse of `itemStem`). */
export const partNumberOf = (stem: string): string =>
  stem.replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** The items the vault already holds (folder names decoded to part numbers). */
export function vaultItems(dir: string): string[] {
  const root = path.join(dir, 'items');
  return existsSync(root) ? readdirSync(root).map(partNumberOf).sort() : [];
}

/** A vault refusal as one line for a dialog (the stable code first); anything else is rethrown. */
function describe(error: unknown): string {
  if (error instanceof VaultError) return `${error.code}: ${error.message}`;
  throw error;
}

/**
 * Check the open document in: a managed item only; an item that was never checked in is locked for this launch first. The result (checkpointed, with
 * externalized snapshots) replaces the live document. Returns the message to show.
 */
export async function vaultCheckIn(deps: VaultDeps): Promise<string> {
  try {
    const vault = initVault(deps.dir);
    const document = await deps.currentDocument();
    const partNumber = document.plm?.item.partNumber;
    if (partNumber === undefined) return 'Only a managed item can be checked in (set_item_identity makes the document one).';
    if (readRefs(vault, partNumber)?.head == null) checkOut(vault, partNumber, deps.holder, clock(deps));
    const done = checkIn(vault, document, deps.holder, clock(deps));
    await deps.loadDocument(serializeDocument(done.document));
    return `${partNumber} rev ${done.revision} iteration ${done.iteration} checked in (head ${done.head.slice(0, 12)}…). The lock is released.`;
  } catch (error) {
    return describe(error);
  }
}

/** Check `partNumber` out: take its lock and load the head document into the app. A new item (no head) only gets the lock. */
export async function vaultCheckOut(deps: VaultDeps, partNumber: string): Promise<string> {
  try {
    const vault = initVault(deps.dir);
    const out = checkOut(vault, partNumber, deps.holder, clock(deps));
    if (out.document === null)
      return `${partNumber} is new to this vault: locked for you until ${out.lock.leaseUntil}. Build it, then File > Vault > Check In.`;
    await deps.loadDocument(out.document);
    return `${partNumber} checked out (lease until ${out.lock.leaseUntil}).`;
  } catch (error) {
    return describe(error);
  }
}
