/** A scripted signature port for the PLM unit tests: it accepts a confirmation only when its `signature` IS the payload hash it is asked to verify. */

import type { HumanSignaturePort } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';

/**
 * `verify` clears an act only when the confirmation was made over exactly that act's payload (`signature === payload`) by a named user (`as`): a
 * confirmation for another act, another document state or other params does not verify. `valid` / `trust` script the raw Ed25519 check and key trust.
 */
export const fakePort = (valid = true, trust: 'trusted' | 'untrusted' | 'test' = 'trusted'): HumanSignaturePort => ({
  verify: (confirmation, payload) =>
    isRecord(confirmation) && confirmation['signature'] === payload && typeof confirmation['as'] === 'string'
      ? { signer: confirmation['as'], signatureId: `fake:${confirmation['as']}` }
      : null,
  verifyEd25519: () => valid,
  keyTrust: () => trust,
  signerOf: () => (trust === 'trusted' ? { keyId: 'k-test', userId: 'u-1', name: 'J. Example' } : null),
});
