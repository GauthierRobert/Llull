/**
 * Live sync protocol (MG5.1): the server broadcasts the command log, not document diffs.
 * Every client applies each command with the same `execute` and checks the resulting state hash;
 * a gap or mismatch falls back to a full snapshot.
 *
 * @layer core/mcp
 * @pure
 * @invariant deterministic replay needs step-scoped ids (MG3) and the same kernel on both ends (MG1.4)
 * @invariant `selection` is per-client view state and is excluded from the state hash
 */

import type { CadDocument } from '../model/types';
import { execute } from '../commands/registry';
import { serializeDocument } from '../commands/persistence';
import { hashText } from '../../lib/hash';

/** SSE `command` event: one mutating command, applied server-side as number `seq`. */
export interface LiveCommandEvent {
  readonly seq: number;
  readonly name: string;
  readonly params: unknown;
  /** `documentHash` of the server document after the command. */
  readonly stateHash: string;
}

/** SSE `snapshot` event and `GET /live/snapshot` body: the full server document at `seq`. */
export interface LiveSnapshotEvent {
  readonly seq: number;
  readonly stateHash: string;
  readonly document: CadDocument;
}

export type LiveApplyResult =
  | { readonly ok: true; readonly document: CadDocument }
  | { readonly ok: false; readonly reason: 'gap' | 'mismatch' };

/** Hash of everything clients must agree on (selection excluded). */
export function documentHash(doc: CadDocument): string {
  return hashText(serializeDocument({ ...doc, selection: [] }, { includeDerived: true }));
}

/** Apply one broadcast command to the client's copy of the server document at `baseSeq`. */
export function applyLiveCommand(
  base: CadDocument,
  baseSeq: number,
  event: LiveCommandEvent,
): LiveApplyResult {
  if (event.seq !== baseSeq + 1) return { ok: false, reason: 'gap' };
  const result = execute(base, event.name, event.params);
  if (documentHash(result.document) !== event.stateHash) return { ok: false, reason: 'mismatch' };
  return { ok: true, document: result.document };
}
