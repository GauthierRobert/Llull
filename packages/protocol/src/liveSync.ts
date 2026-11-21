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
import { withoutPrivateValues } from '@core/commands/materials/libraryRecords';
import { hashText } from '@lib/hash';
import { jsonWithObjectMarks } from '@lib/jsonWithObjectMarks';
import { appendAll } from '@lib/appendAll';

/**
 * Who sent a broadcast command: the REST API (the UI, scripts) or the `llull` CLI.
 */
export type LiveCommandSource = 'rest' | 'cli';

/** SSE `command` event: one mutating command, applied server-side as number `seq`. */
export interface LiveCommandEvent {
  /** Server process id (random per start); `seq` is only comparable within one epoch. */
  readonly epoch: string;
  readonly seq: number;
  readonly name: string;
  readonly params: unknown;
  /** `documentHash` of the server document after the command. */
  readonly stateHash: string;
  /** Channel the command came in on; clients use it to label remote edits. */
  readonly source?: LiveCommandSource;
  /** The sender's idempotency key, echoed so a client can recognise its own commands. */
  readonly commandId?: string;
  /** The server's history flags after the command; absent = leave the client's flags unchanged. */
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
}

/**
 * SSE `progress` event: a native job of a running command reports (`state: 'running'`), and `state: 'ended'` follows when the command settles (applied, refused or
 * cancelled; after its `command` event when it changed the document). NOT a document change: it carries no `seq`, is not in the command log and has no
 * `stateHash`, so a client that does not know the event type ignores it and a client that does shows a progress chip. Commands that need no native job send none.
 */
export type LiveProgressReport = {
  readonly command: string;
  readonly commandId?: string;
  /** One per request (the sender's command id, else a counter of the server): concurrent jobs of one command name stay apart. */
  readonly jobId: string;
} & (
  | {
      readonly state: 'running';
      /** The native job (`quad_remesh`, ...). */
      readonly op: string;
      /** Machine name of the stage and the stage in words. */
      readonly stage: string;
      readonly message: string;
      /** Share of the whole job done (0 to 1), null before the job reported one. */
      readonly fraction: number | null;
      readonly elapsedMs: number;
      readonly etaMs: number | null;
      /** Nothing new from the job: the last report again with the clock advanced. */
      readonly heartbeat: boolean;
    }
  | { readonly state: 'ended' }
);

/** The `progress` event as the stream carries it: the report with the server epoch. */
export type LiveProgressEvent = LiveProgressReport & { readonly epoch: string };

/**
 * SSE `status` event (host health, NOT a document change: no `seq`, not in the command log): the backend's autosave started failing
 * (`ok: false`, stable `DSF_*` code) or works again (`ok: true`). Also sent to a subscriber that connects while it is failing, and
 * mirrored in `GET /health` as `autosave`.
 */
export type LiveAutosaveStatus =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'DSF_SAVE_DISK_FULL' | 'DSF_SAVE_IO' | 'DSF_AUTOSAVE_FAILED' | 'DSF_HOLD_EXPIRED';
      readonly message: string;
    };

export interface LiveStatusEvent {
  readonly epoch: string;
  readonly autosave: LiveAutosaveStatus;
}

/**
 * SSE `document` event (host state, NOT a document change): the file the live document belongs to (null: untitled). Sent after a snapshot when
 * it has a path, and whenever the host rebinds the document (open / Save As / restore), so a client that later loses the backend knows which
 * file its offline edits started from.
 */
export interface LiveDocumentEvent {
  readonly epoch: string;
  readonly path: string | null;
}

/** SSE `snapshot` event and `GET /live/snapshot` body: the full server document at `seq`. */
export interface LiveSnapshotEvent {
  readonly epoch: string;
  readonly seq: number;
  readonly stateHash: string;
  readonly document: CadDocument;
  /** The server's history flags; absent = leave the client's flags unchanged. */
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
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

/** Hash of one `ShapeRecipe` node, by identity: results share their operands' recipe objects, so a boolean chain costs O(1) per link. */
const hashByRecipeNode = new WeakMap<object, string>();

const NUMBERS_MARK = '\u0000numbers:';
/** Shorter arrays are written as text (the mark would not be shorter). */
const MIN_HASHED_NUMBERS = 64;
const float = new Float64Array(1);
const floatWords = new Uint32Array(float.buffer);
/** Mark of a long array of finite numbers, by identity (null = not such an array): a pure command keeps the arrays of a mesh it did not reshape. */
const markByNumbers = new WeakMap<object, string | null>();

/**
 * Stands for a long array of finite numbers (mesh positions / indices) in the hashed text: its length and a 64-bit fold of the IEEE-754
 * bits, so a 100k-triangle mesh costs a pass over its numbers instead of printing each one. -0 counts as 0 (JSON prints both as `0`, and a
 * snapshot-resynced replica must agree); an array with anything else than finite numbers is written as text.
 */
function numbersMark(values: readonly unknown[]): string | undefined {
  if (values.length < MIN_HASHED_NUMBERS) return undefined;
  const known = markByNumbers.get(values);
  if (known !== undefined) return known ?? undefined;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      markByNumbers.set(values, null);
      return undefined;
    }
    float[0] = value + 0;
    const low = floatWords[0] as number;
    const high = floatWords[1] as number;
    a = Math.imul(Math.imul(a ^ low, 0x01000193) ^ high, 0x01000193);
    b = Math.imul(b ^ low, 0x5bd1e995) ^ (b >>> 15);
    b = Math.imul(b ^ high, 0x5bd1e995) ^ (b >>> 15);
  }
  const mark = `${NUMBERS_MARK}${values.length}:${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
  markByNumbers.set(values, mark);
  return mark;
}

const RECIPE_CHILD_MARK = '\u0000recipe:';

function isRecipeNode(value: unknown): value is object {
  return typeof value === 'object' && value !== null && typeof (value as { op?: unknown }).op === 'string';
}

/** A nested recipe node stands for its own hash (always memoized by `hashRecipes` first), known or not; a long numeric array for its fold. */
const recipeChildMark = (value: object): string | undefined => {
  if (Array.isArray(value)) return numbersMark(value);
  return isRecipeNode(value) ? RECIPE_CHILD_MARK + (hashByRecipeNode.get(value) ?? '') : undefined;
};

/** Recipe nodes directly below `root` (not inside another node), found without recursion. */
function childRecipeNodes(root: object, rootIsNode: boolean): object[] {
  const found: object[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (isRecipeNode(value) && !(rootIsNode && value === root)) {
      found.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      // A long numeric array already folded holds no node; any other array is scanned for objects only.
      if (typeof markByNumbers.get(value) === 'string') continue;
      for (let index = 0; index < value.length; index += 1) {
        const child: unknown = value[index];
        if (typeof child === 'object' && child !== null) pending.push(child);
      }
      continue;
    }
    for (const child of Object.values(value)) pending.push(child);
  }
  return found;
}

/** Memoize the hash of every recipe node under `root`, children first, with an explicit stack (chains can be thousands deep). */
function hashRecipes(root: object): void {
  const order: object[] = [];
  const seen = new Set<object>();
  const pending = childRecipeNodes(root, false);
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || seen.has(node) || hashByRecipeNode.has(node)) continue;
    seen.add(node);
    order.push(node);
    appendAll(pending, childRecipeNodes(node, true));
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    if (node !== undefined) hashByRecipeNode.set(node, hashText(jsonWithObjectMarks(node, recipeChildMark)));
  }
}

function partHash(part: object, key: string): PartHash {
  const known = hashByPart.get(part);
  if (known !== undefined) return known;
  hashRecipes(part);
  const hex = hashText(jsonWithObjectMarks([key, part], recipeChildMark));
  const hash = { high: Number.parseInt(hex.slice(0, 8), 16), low: Number.parseInt(hex.slice(8), 16) };
  hashByPart.set(part, hash);
  return hash;
}

/**
 * Hash of one top-level document field (`blobs`, `analysis`, `drawings`, ...), memoized by the field value's identity: pure commands keep
 * untouched fields' identity, so a multi-MB `blobs` record is serialized once, not per command. Content-based, so a re-parsed copy agrees.
 */
const hashByField = new Map<string, WeakMap<object, string>>();

function fieldHash(key: string, value: unknown, serialize?: (value: unknown) => unknown): string {
  if (typeof value !== 'object' || value === null) return hashText(JSON.stringify([key, value]));
  let memo = hashByField.get(key);
  if (memo === undefined) hashByField.set(key, (memo = new WeakMap()));
  const known = memo.get(value);
  if (known !== undefined) return known;
  const hash = hashText(JSON.stringify([key, serialize === undefined ? value : serialize(value)]));
  memo.set(value, hash);
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

/** Per-field serializers for fields that normalise or are large; blobs fold per-blob hashes so adding one never re-reads the others. */
const SERIALIZE_FIELD: Record<string, (value: unknown) => unknown> = {
  analysis: (value) => withoutVerifiedFlags(value as AnalysisModel),
  blobs: (value) =>
    Object.fromEntries(Object.entries(value as Record<string, object>).map(([sha, blob]) => [sha, fieldHash('blob', blob)])),
};

/** Top-level fields hashed per entity / step (or excluded) instead of as plain fields. */
const PER_PART_FIELDS: ReadonlySet<string> = new Set(['entities', 'featureHistory', 'selection']);

/**
 * Hash of everything clients must agree on (selection excluded); memoized per (immutable) document.
 * Entities, feature steps and every other top-level field are hashed once per object and combined, so a command costs the size
 * of what it changed plus a pass over the id lists and field names, not a serialization of the whole document.
 */
export function documentHash(doc: CadDocument): string {
  const known = hashByDocument.get(doc);
  if (known !== undefined) return known;
  const shared = withoutPrivateValues(doc);
  const fields = new PartFold(hashText('llull-document-state'));
  for (const key of Object.keys(shared).sort()) {
    if (PER_PART_FIELDS.has(key)) continue;
    const value = (shared as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const hex = fieldHash(key, key === 'analysis' ? doc.analysis : value, SERIALIZE_FIELD[key]);
    fields.add({ high: Number.parseInt(hex.slice(0, 8), 16), low: Number.parseInt(hex.slice(8), 16) });
  }
  const fold = new PartFold(fields.hex());
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
