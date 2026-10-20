/**
 * The proof that a USER confirmed trusting a signing key (09 PLM TR-PLM-19). Issued only by the desktop app, after a native confirmation dialog
 * (`desktop/src/keyTrust.ts`); no server route, CLI command or command param can create one. dependency-cruiser (`trust-grant-is-desktop-only`)
 * forbids every other importer than `desktop/` and tests.
 */

export interface TrustGrant {
  readonly userConfirmed: true;
  /** What the user was shown and confirmed (key id, owner, public key). */
  readonly shown: string;
}

export function issueTrustGrant(shown: string): TrustGrant {
  return { userConfirmed: true, shown };
}
