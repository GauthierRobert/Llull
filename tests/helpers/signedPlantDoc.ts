/** A plant document holding both human-gated records the replay must keep: an approved pipe spec (PSC-M3) and an issued isometric (ISO-M4). */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { apply } from './commandAssertions';
import { loadedL101 } from '../unit/plant/fabrication/isoM2Fixtures';
import { fixtureSpec } from '../unit/plant/piping/specFixture';

export const AT = '2026-11-02T09:30:00Z';

/** Any confirmation with a nonce verifies (the gate itself is tested elsewhere); `spend` is not modelled. */
export const permissivePort: HumanSignaturePort = { verify: () => ({ signer: 'alice', signatureId: 'sig-1' }) };
export const signingContext: ExecutionContext = { ...defaultContext(), humanSignature: permissivePort };

export const issueParams = { lineId: 'L-101', revision: 'A', purpose: 'for_construction', at: AT };

/** Spec CS150-A1 approved, then the L-101 line numbered and issued. */
export function signedPlantDoc(): CadDocument {
  const imported = apply(apply(loadedL101(), 'import_pipe_spec', { spec: fixtureSpec() }), 'number_welds', { lineId: 'L-101' });
  const approved = execute(imported, 'approve_pipe_spec', { specId: 'CS150-A1', at: AT, confirmation: { nonce: 'a' } }, signingContext);
  if (approved.error !== undefined) throw new Error(approved.summary);
  const issued = execute(approved.document, 'issue_isometric', { ...issueParams, confirmation: { nonce: 'b' } }, signingContext);
  if (issued.error !== undefined) throw new Error(issued.summary);
  return issued.document;
}
