/**
 * Human gate (TR-MAT-51, AF-34): an act only a human may do (export of export-controlled content, lowering a marking). A caller proves it
 * with a signature that `ctx.humanSignature` (09 PLM) verifies over the payload hash; a bare `true` from an agent, or no port, refuses.
 */

import { canonicalJson } from '../../lib/canonicalJson';
import { sha256Hex } from '../../lib/sha256';
import type { ExecutionContext } from '../types';

export type HumanGateOutcome = { readonly cleared: true; readonly signer: string } | { readonly cleared: false; readonly reason: string };

/**
 * Whether `confirmation` clears the gate for `act` on `ids`.
 * @invariant the signed payload is sha256(canonical JSON of { act, ids sorted }): a signature for another act or id set does not verify
 */
export function humanGate(ctx: ExecutionContext | undefined, act: string, ids: readonly string[], confirmation: unknown): HumanGateOutcome {
  if (confirmation === undefined || confirmation === false)
    return { cleared: false, reason: `${act} needs a human confirmation: pass a signature produced in the desktop app` };
  if (typeof confirmation === 'boolean')
    return { cleared: false, reason: `an agent cannot confirm ${act}; only a human signature verified by the signing port can` };
  const port = ctx?.humanSignature ?? null;
  if (port === null) return { cleared: false, reason: `no signing port is installed, so ${act} cannot be confirmed` };
  const signer = port.verify(confirmation, sha256Hex(canonicalJson({ act, ids: [...ids].sort() })));
  return signer === null ? { cleared: false, reason: `the signature did not verify for ${act}` } : { cleared: true, signer: signer.signer };
}
