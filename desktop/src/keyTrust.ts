/**
 * Trusting a signing key (09 PLM TR-PLM-19): the ONLY code that issues a `TrustGrant`. The user confirms each key in a native dialog of the desktop app;
 * nothing reachable by the CLI, the REST routes or a command can do this. Electron-free: the dialog is injected (`confirm`).
 * Residual risk (docs 09 §13.5): the dialog shows what the key store claims (owner, creation time); a user who confirms a key an agent enrolled under
 * a name they know trusts the agent. The dialog therefore warns when the owner already has a trusted key or several keys are pending.
 */

import { createKeyStore } from '../../server/src/plm/keyStore';
import { createTrustStore } from '../../server/src/plm/trustStore';
import { issueTrustGrant } from '../../server/src/plm/trustGrant';

export interface KeyTrustDeps {
  /** Native confirmation: resolves true only when the user explicitly agrees to the shown text. */
  readonly confirm: (text: string) => Promise<boolean>;
  /** Environment of the key store (enrollment only). */
  readonly keysEnv?: NodeJS.ProcessEnv;
  /** Trust store directory (tests only; the app uses the fixed per-user location). */
  readonly trustDir?: string;
  readonly now?: () => Date;
}

const fingerprint = (publicKey: string): string => publicKey.match(/.{1,8}/g)?.join(' ') ?? publicKey;

/** The enrolled, not revoked keys the user has not trusted yet. */
export function pendingKeys(deps: Pick<KeyTrustDeps, 'keysEnv' | 'trustDir'> = {}): ReturnType<ReturnType<typeof createKeyStore>['list']> {
  const trust = createTrustStore(deps.trustDir);
  return createKeyStore(deps.keysEnv)
    .list()
    .filter((key) => key.revokedAt === undefined && trust.find(key.publicKey) === null);
}

/**
 * Ask the user, one native dialog per pending key, and trust the confirmed ones. Returns the key ids trusted now.
 * @invariant a key is trusted only after an explicit yes to a dialog that shows its owner, creation time and fingerprint, with warnings
 */
export async function trustPendingKeys(deps: KeyTrustDeps): Promise<string[]> {
  const trust = createTrustStore(deps.trustDir);
  const pending = pendingKeys(deps);
  const trusted: string[] = [];
  for (const key of pending) {
    const already = trust.list().filter((entry) => entry.userId === key.userId && entry.revokedAt === undefined);
    const warnings = [
      already.length > 0
        ? `WARNING: ${key.userId} already has ${already.length} trusted key(s). Trust another only if you just enrolled it yourself.`
        : '',
      pending.length > 1 ? `WARNING: ${pending.length} keys are waiting for trust. Check each one.` : '',
    ].filter((line) => line !== '');
    const text =
      `Trust signing key ${key.keyId} of ${key.name} (${key.userId})?\n\nEnrolled: ${key.createdAt}\nPublic key: ${fingerprint(key.publicKey)}\n\n` +
      (warnings.length > 0 ? `${warnings.join('\n')}\n\n` : '') +
      'Signatures by a trusted key release, approve and classify engineering data in llull. Trust it only if you enrolled it yourself or verified its owner.';
    if (!(await deps.confirm(text))) continue;
    trust.trust(key, issueTrustGrant(text), `${(deps.now ?? ((): Date => new Date()))().toISOString().slice(0, 19)}Z`);
    trusted.push(key.keyId);
  }
  return trusted;
}
