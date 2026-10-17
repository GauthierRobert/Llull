/**
 * Live sync protocol: the server broadcasts the command log, not document diffs.
 * Every client applies each command with the same `execute` and checks the resulting state hash;
 * a gap or mismatch falls back to a full snapshot.
 *
 * @invariant deterministic replay needs step-scoped ids and the same kernel on both ends
 * @invariant `selection` is per-client view state and is excluded from the state hash; so is the `verified: false` flag of recorded FE
 *   summaries (a replica without the artifact store records it, the server does not)
 */

import type { AnalysisModel } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { hashText } from '@lib/hash';

/** Who sent a broadcast command: the REST API (browser, scripts), an MCP agent, or the `llull` CLI. */
export type LiveCommandSource = 'rest' | 'mcp' | 'cli';

/** SSE `command` event: one mutating command, applied server-side as number `seq`. */
export interface LiveCommandEvent {
  /** Server process id (random per start); `seq` is only comparable within one epoch. */
  readonly epoch: string;
  readonly seq: number;
  readonly name: string;
  readonly params: unknown;
  /** `documentHash` of the server document after the command. */
  readonly stateHash: string;
  /** Named user who ran the command (server in named-user mode only); clients may ignore it. */
  readonly userId?: string;
  readonly userName?: string;
  /** Channel the command came in on; clients use it to label remote edits. */
  readonly source?: LiveCommandSource;
  /** The sender's idempotency key, echoed so a client can recognise its own commands. */
  readonly commandId?: string;
}

/** SSE `snapshot` event and `GET /live/snapshot` body: the full server document at `seq`. */
export interface LiveSnapshotEvent {
  readonly epoch: string;
  readonly seq: number;
  readonly stateHash: string;
  readonly document: CadDocument;
}

type LiveApplyResult = { readonly ok: true; readonly document: CadDocument } | { readonly ok: false; readonly reason: 'gap' | 'mismatch' };

const hashByDocument = new WeakMap<CadDocument, string>();

/** Two 32-bit lanes of `hashText`, so documents fold parts without building strings. */
interface PartHash {
  readonly high: number;
  readonly low: number;
}

/** Per-object hashes: commands share unchanged entities / steps between documents (L3 purity). */
const hashByPart = new WeakMap<object, PartHash>();

function partHash(part: object, key: string): PartHash {
  const known = hashByPart.get(part);
  if (known !== undefined) return known;
  const hex = hashText(JSON.stringify([key, part]));
  const hash = { high: Number.parseInt(hex.slice(0, 8), 16), low: Number.parseInt(hex.slice(8), 16) };
  hashByPart.set(part, hash);
  return hash;
}

/** Order-sensitive running 64-bit fold of part hashes. */
class PartFold {
  high: number;
  low: number;

  constructor(seedHex: string) {
    this.high = Number.parseInt(seedHex.slice(0, 8), 16);
    this.low = Number.parseInt(seedHex.slice(8), 16);
  }

  add(part: PartHash): void {
    this.high = Math.imul(this.high ^ part.high, 0x01000193);
    this.low = Math.imul(this.low ^ part.low, 0x5bd1e995) ^ (this.low >>> 15);
  }

  hex(): string {
    return (this.high >>> 0).toString(16).padStart(8, '0') + (this.low >>> 0).toString(16).padStart(8, '0');
  }
}

/**
 * The analysis slice with the `verified: false` flag of recorded summaries removed. A replica that has no artifact store records a summary
 * flagged `verified: false` (05 §4.1) where the server, which has the store, records it unflagged: the flag says what this machine could
 * check, not what the document says, so it must not make the replicas' hashes differ (a mismatch would force a snapshot on every FE command).
 */
function withoutVerifiedFlags(analysis: AnalysisModel): AnalysisModel {
  const flagged = Object.values(analysis.cases).some((entry) => entry.meshSummary?.verified === false || entry.results?.verified === false);
  if (!flagged) return analysis;
  const unflag = <T extends { readonly verified?: false }>(summary: T | undefined): T | undefined => {
    if (summary === undefined) return undefined;
    const { verified, ...rest } = summary;
    void verified;
    return rest as T;
  };
  return {
    ...analysis,
    cases: Object.fromEntries(
      Object.entries(analysis.cases).map(([id, entry]) => {
        const { meshSummary, results, ...rest } = entry;
        const mesh = unflag(meshSummary);
        const solved = unflag(results);
        return [
          id,
          { ...rest, ...(mesh !== undefined ? { meshSummary: mesh } : {}), ...(solved !== undefined ? { results: solved } : {}) },
        ];
      }),
    ),
  };
}

/**
 * Hash of everything clients must agree on (selection excluded); memoized per (immutable) document.
 * Entities and feature steps are hashed once per object and combined, so a command costs the size
 * of what it changed plus a pass over the id lists, not a serialization of the whole document.
 */
export function documentHash(doc: CadDocument): string {
  const known = hashByDocument.get(doc);
  if (known !== undefined) return known;
  const normalised = doc.analysis === undefined ? doc : { ...doc, analysis: withoutVerifiedFlags(doc.analysis) };
  const rest = hashText(serializeDocument({ ...normalised, selection: [], entities: {}, featureHistory: [] }, { includeDerived: true }));
  const fold = new PartFold(rest);
  for (const id in doc.entities) {
    const entity = doc.entities[id];
    if (entity !== undefined) fold.add(partHash(entity, id));
  }
  for (const step of doc.featureHistory) fold.add(partHash(step, 'step'));
  const hash = fold.hex();
  hashByDocument.set(doc, hash);
  return hash;
}

/** Apply one broadcast command to the client's copy of the server document at `baseSeq`. */
export function applyLiveCommand(base: CadDocument, baseSeq: number, event: LiveCommandEvent): LiveApplyResult {
  if (event.seq !== baseSeq + 1) return { ok: false, reason: 'gap' };
  const result = execute(base, event.name, event.params);
  if (documentHash(result.document) !== event.stateHash) return { ok: false, reason: 'mismatch' };
  return { ok: true, document: result.document };
}
