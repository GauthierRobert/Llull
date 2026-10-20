/**
 * Trusting a signing key (09 PLM TR-PLM-19): the ONLY code that issues a `TrustGrant`. The user confirms each key in a native dialog of the desktop
 * app; nothing reachable by the CLI, the REST routes or a command can do this. Electron-free: the dialog is injected (`confirm`).
 */

import { createKeyStore } from '../../server/src/plm/keyStore';
import { createTrustStore } from '../../server/src/plm/trustStore';
import { issueTrustGrant } from '../../server/src/plm/trustGrant';

export interface KeyTrustDeps {
  /** Native confirmation: resolves true only when the user explicitly agrees to the shown text. */
  readonly confirm: (text: string) => Promise<boolean>;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

const fingerprint = (publicKey: string): string => publicKey.match(/.{1,8}/g)?.join(' ') ?? publicKey;

/** The enrolled, not revoked keys the user has not trusted yet. */
export function pendingKeys(env: NodeJS.ProcessEnv = process.env): ReturnType<ReturnType<typeof createKeyStore>['list']> {
  const trust = createTrustStore(env);
  return createKeyStore(env)
    .list()
    .filter((key) => key.revokedAt === undefined && trust.find(key.publicKey) === null);
}

/**
 * Ask the user, one native dialog per pending key, and trust the confirmed ones. Returns the key ids trusted now.
 * @invariant a key is trusted only after an explicit yes to a dialog that shows its owner and fingerprint
 */
export async function trustPendingKeys(deps: KeyTrustDeps): Promise<string[]> {
  const env = deps.env ?? process.env;
  const trust = createTrustStore(env);
  const trusted: string[] = [];
  for (const key of pendingKeys(env)) {
    const text =
      `Trust signing key ${key.keyId} of ${key.name} (${key.userId})?\n\nPublic key: ${fingerprint(key.publicKey)}\n\n` +
      'Signatures by a trusted key release, approve and classify engineering data in llull. Trust it only if you enrolled it yourself or verified its owner.';
    if (!(await deps.confirm(text))) continue;
    trust.trust(key, issueTrustGrant(text), (deps.now ?? ((): Date => new Date()))().toISOString().slice(0, 19) + 'Z');
    trusted.push(key.keyId);
  }
  return trusted;
}
