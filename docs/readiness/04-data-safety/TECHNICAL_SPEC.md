# 04 DSF — Data safety — Technical specification

Status: specification only (2026-10-28). Nothing in this pack is built. Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md)
(L1, L3, L6, L8), [`.claude/rules/sync.md`](../../../.claude/rules/sync.md). Source ids `[Sn]`: [`validation/sources.md`](validation/sources.md).

## 1. Current state in llull (read on main f1351cff, 2026-10-28)

### 1.1 What exists and is sound

| Area | Where | Behaviour today |
| ---- | ----- | --------------- |
| Atomic replace | `server/src/writeFileAtomic.ts:63-115` | `writeFileKeepingBackup`: write `<file>.<pid>.tmp`, `fsync` it, hard-link (or copy + fsync on FAT / shares without links) the current file to `<file>.<pid>.bak.tmp`, rename it over `<file>.bak`, rename the temp over `<file>`. `renameWithRetry` retries `EPERM / EBUSY / EACCES` 8 times with 10·k ms backoff (antivirus, indexers). Orphaned temps of dead PIDs are removed on the next save (`:177-192`) |
| One reader / writer | `server/src/documentFile.ts` | `readDocumentFile` / `writeDocumentFile`, used by the CLI `--doc`, the desktop Save and the autosave |
| Kill-during-save test | `server/tests/saveKill.test.ts` (SC-D1, [`../../decisions/SC1-solidcraft-parity.md`](../../decisions/SC1-solidcraft-parity.md)) | a child process saves a ~0.5 MB, 4,000-entity document in a loop and is `SIGKILL`ed 25 times at seeded instants ≤ 200 ms after its first save; after each kill the file and `.bak` are complete versions |
| Backend autosave | `server/src/autosave.ts`, `server/src/liveDocument.ts:16-57,140-143` | every change of the live document schedules a debounced write (`LLULL_AUTOSAVE_DEBOUNCE_MS`, default **300 ms**), async, never overlapping, temp + fsync + rename keeping `autosave.json.bak`; synchronous flush on SIGTERM / SIGINT / uncaught exception (`server/src/lifecycle.ts:24-37,92-110`). Desktop path: `<userData>/autosave.json` (`desktop/src/backendEnv.ts:65`) |
| Unreadable autosave | `server/src/liveDocument.ts:20-43` | renamed aside to `autosave.json.unreadable-<ms>`, backend starts empty |
| Undo / redo (app) | `packages/protocol/src/history.ts`, `server/src/commandBus.ts:28,113-121` | two snapshot stacks of whole `CadDocument` values (structurally shared by L3 spreads), `HISTORY_LIMIT = 100` per stack; ONE history per backend, shared by the desktop UI and every CLI `--app` caller; queries and no-ops are not recorded; `coalesce` folds held-key nudges (`tests/integration/selectionUndoSteps.test.ts`) |
| Live sync | `@protocol/liveSync`, `server/tests/liveTwoWriters.test.ts` | command log with `(epoch, seq)` and `stateHash`; two concurrent writers serialize into one gap-free log; `commandId` idempotency (LRU 1,000) |
| Format and migration | `packages/core/src/commands/persistence/serialization.ts:19-31,154-204` | envelope `{ format: 'llull-document', version: 3, document }`, deterministic `JSON.stringify`; versions 1, 2, 3 read; `migrate()` fills defaults, `migrateRetiredCommands` rewrites retired command names in history; a newer version is refused with a message; every value validated (`validateDocumentValues`); plugin-derived entities not stored (llull-document v2, L8) |
| Damaged files | `tests/unit/documentCorpusDamaged.test.ts`, corpus `tests/corpus/documents/` (v1–v3, 12 files) | truncations, seeded bit flips and hostile values never throw past `load_document` (SC-D2) |
| Crash reports | `server/src/crashReports.ts`, `server/src/liveCommandLog.ts`, `desktop/src/crashes.ts` | on an uncaught error a folder with the document, the command log since the last rebase (≤ 2,000 commands) and the error; last 20 kept; Help > Crash Reports |
| Single instance | `desktop/src/main.ts:367` | `app.requestSingleInstanceLock()`: one desktop app per user session |
| Quit guard | `desktop/src/main.ts:72-114` | Save / Don't Save / Cancel on unsaved changes (state hash differs from the last open / save) |
| Vault locks | `server/src/plm/vault/locks.ts` | PLM item locks: `locks/<item>.lock` created with `wx` (O_EXCL), holder `{userId, name, host, session, pid}`, 8 h lease, stale break when the lease expired and the PID is gone on this host (`desktop/tests/vaultLocks.test.ts`) |

### 1.2 What is unsafe or missing (the gap)

| # | Finding | Evidence | Consequence for a professional |
| - | ------- | -------- | ------------------------------ |
| G1 | **One global recovery slot.** The backend autosave is a single `autosave.json`, not tied to the document's file. After a crash the next launch loads it as an untitled document with no notice (the renderer's `RestoredBanner` only works in local mode, `src/ui/hooks/useAutosave.ts:33,95`: "With a live server nothing is saved") | `liveDocument.ts:16,69`; `desktop/src/documents.ts:39-40` (path forgotten) | the user does not know they are looking at recovered work, nor which file it belongs to |
| G2 | **Recovered work is overwritten by the next session.** The first change of the new session (New, Open of another file, any edit) rewrites `autosave.json`; one more write rotates the recovered state out of `.bak` | `autosave.ts` + `writeFileAtomic.ts:153-163` (one `.bak` level) | the crashed session's work is lost two edits after relaunch |
| G3 | **No lock on the document file.** The desktop app opens a `.llull` file without any lock; `llull --doc` reads, executes and rewrites the same file without a lock or a changed-on-disk check; two `--doc` processes race | `documents.ts:64-77`; `server/src/cli/backend.ts:63-72` | lost update: the desktop's next Save silently overwrites what an agent wrote with `--doc`, and vice versa; on a share, two engineers overwrite each other |
| G4 | **Backend crash is not recovered.** The desktop does not restart its backend when it exits (`desktop/src/backend.ts:98-104` only records the reason). The renderer falls back to local mode (`src/ui/store/localMode.ts`) where edits run in the renderer, File > Save fails (it reads `/live/snapshot`), and on reconnect the backend document replaces them (`store.ts:22,93`) | code read | edits after a backend crash look accepted and are discarded |
| G5 | **Renderer crash is not handled.** No `render-process-gone` handler in `desktop/src/main.ts` | grep | a white window; the document is safe in the backend but the user does not know it |
| G6 | **Undo is in memory only and bounded by count, not memory.** 100 snapshots; a kernel result or imported mesh held by an old snapshot stays in RAM; history is lost on crash or restart; Open (`load_document`) and New (`clear_document`) are ordinary undo entries, so undo after Open returns to the previous document | `history.ts:7`; `documents.ts:66,86` | unbounded memory on large models (pack 03 PRF: 44 MB documents); surprising undo across documents |
| G7 | **`--doc` undo is one level.** `llull undo --doc` swaps the file with `.bak` | `server/src/cli/backend.ts:111-134` | an agent cannot step back more than one command on a file |
| G8 | **No integrity code in the file.** Corruption that still parses and validates (a changed number) is invisible; there is no `verify` verb and no salvage path: a file that fails validation does not open at all (`serialization.ts:202-203`) | code read | silent wrong geometry, or an all-or-nothing refusal |
| G9 | **Durability of the rename is not forced.** The temp file is fsynced, the rename is not flushed: no directory fsync on POSIX, no `MOVEFILE_WRITE_THROUGH` on Windows (Node's `fs.rename` cannot pass it) [S14][S18][S19] | `writeFileAtomic.ts:24-34` | after a power cut the directory may still name the old file (old-or-new still holds; "new" is not guaranteed) |
| G10 | **No backup history.** One `.bak`; no rotating backups, no timestamped versions | `writeFileAtomic.ts` | one bad save plus one more save loses the good version |
| G11 | **Disk full is untested.** A failed autosave is retried only at shutdown (`autosave.ts:78-82`), with a console warning; the user is not told | code read | the user works for hours believing autosave runs |
| G12 | **Format policy contradicts itself.** The owner rule (2026-10-22, project memory) is "no backward compatibility for old documents"; the code still reads v1–v3 and rewrites retired commands, and the SC-D2 corpus requires old files to load | `serialization.ts:28`, `retiredCommands.ts`, `tests/unit/documentCorpus.test.ts` | no stated guarantee a professional can rely on (§11 Q1) |
| G13 | **Renderer autosave in localStorage.** Used only in local mode; its size is capped by the browser storage quota (size not measured; the path is retired by TR-DSF-07) and it fails with "Autosave unavailable" on large documents | `src/ui/store/autosave.ts`, `useAutosave.ts:45-49` | browser-era path (LC1 legacy) |

## 2. Target architecture

| Milestone | Layer | Placement | Laws |
| --------- | ----- | --------- | ---- |
| M1 recovery slots + journal | `server/` (host) | `server/src/recovery/{slot,journal,checkpoint,scan}.ts` replace `autosave.ts`'s single file; the live document writes checkpoints + a command journal per slot | L6 (host transport only: the journal is the `/live` command log written to disk), L1 (restore = `load_document`) |
| M2 desktop crash handling | `desktop/src` | `render-process-gone` → reload; backend `exit` → restart from the slot; Document Recovery dialog | L6 |
| M3 document locks + conflict detection | `server/src/documentLock.ts` (shared with `plm/vault/locks.ts`), `server/src/documentFile.ts`, `server/src/cli/backend.ts`, `desktop/src/documents.ts` | lock beside the file; content hash checked before every write | L6 |
| M4 save pipeline | `server/src/writeFileAtomic.ts`; optional native helper (§5.4) | free-space precheck, write-verify, durable rename, backup ring | C7 (native where Node cannot) |
| M5 integrity + verify + salvage | core `commands/persistence/` | envelope v4 with `integrity`, `verify_document` (query), `salvage_document` (mutating, like `load_document`) | L1, L3, L5 (registered, CLI + UI); core has no `fs`: hosts pass the text (as `load_document` does) |
| M6 undo hardening | `@protocol/history`, `server/src/commandBus.ts`, `src/ui/store` | memory budget, labelled entries with source, document-session boundaries; later history-based undo (MG5.4) over the recipe | L3 (snapshots of pure results), L8 |
| M7 format policy | core `persistence/serialization.ts`, `tests/corpus/documents/` | version window, migration chain, `writtenBy`, newer-version refusal without write | owner decision Q1 |
| M8 fault-injection runner | `server/tests/fault/`, `scripts/faultRunner.mjs` | kill / disk-full / power-cut / corruption / concurrency scenarios (§9) | W3 (documented gate, `npm run fault`) |

No architecture law changes. Undo / redo stay host operations on snapshots (they are not document commands; L1 is unaffected
because the snapshots are results of commands). Recovery restores through `load_document`; salvage is a registered command.

### Technical requirements

| Id | Pri | Requirement | FR |
| -- | --- | ----------- | -- |
| TR-DSF-01 | MUST | Recovery slot per document session in `<userData>/recovery/<slotId>/` (§3.1): `slot.json`, `checkpoint.llull`, `journal.ndjson`; created on the first change after New / Open; the single `autosave.json` is retired (desktop) | 05, 06, 07 |
| TR-DSF-02 | MUST | Journal: each committed live command appends one line `{seq, epoch, name, params, source, stateHash, crc32}`; lines are flushed with `fsync` at most `JOURNAL_FLUSH_MS` after the command was acknowledged (group commit; default 1,000 ms, spec budget §8) | 05, 06 |
| TR-DSF-03 | MUST | Checkpoint: the full document is written with the save pipeline (§5.1) when the journal holds ≥ `CHECKPOINT_COMMANDS` lines or ≥ `CHECKPOINT_MS` passed with pending lines, and on idle; the journal restarts after a successful checkpoint; checkpoint cost is measured and kept off the event loop (worker thread serialize — budget §8) | 05, 06, 21 |
| TR-DSF-04 | MUST | Recovery = `checkpoint` then journal lines replayed with `execute` (the same path as `/live` followers), each line's `stateHash` compared; the first mismatch, CRC error or truncated line stops replay at the last verified state and is reported (`DSF_RECOVERY_PARTIAL`, line number) | 06, 08 |
| TR-DSF-05 | MUST | A slot is deleted only after (a) a successful Save of the document whose hash equals the slot's state, then a clean close, or (b) an explicit Discard; a slot is never overwritten by another session; Discard moves it to `<userData>/recovery/discarded/` kept `DISCARD_KEEP_DAYS` (default 7, owner Q4) | 07 |
| TR-DSF-06 | MUST | Desktop: `webContents` `render-process-gone` with a reason other than `clean-exit` → crash report + window reload (document intact in the backend) + notice; `utilityProcess` `exit` of the backend while not quitting → restart it from its recovery slot, at most 3 restarts in 5 min, then a dialog [S32][S33] | 09 |
| TR-DSF-07 | MUST | Desktop renderer never edits in local mode: while the backend is down the UI is read-only with a "Backend restarting" status (local mode remains for tests / dev only, LC1) | 09 |
| TR-DSF-08 | MUST | Document lock file `<dir>/<name>.llull.lock` (§3.2), created with exclusive create (`wx` → `CREATE_NEW` / `O_CREAT\|O_EXCL`) [S35][S39]; desktop holds it while the document is open, heartbeat every `LOCK_HEARTBEAT_MS`; CLI `--doc` holds it for one invocation | 13, 14, 15 |
| TR-DSF-09 | MUST | Stale lock rule: same host and holder PID gone → removed with an audit line; other host → stale only when `heartbeatAt` is older than `LOCK_STALE_MS`, and then only broken on explicit user / `--break-lock` request; never silently | 15 |
| TR-DSF-10 | MUST | Optimistic conflict check: the host remembers the SHA-256 of the bytes it read or wrote; before a write it re-hashes the file on disk; a difference → `DSF_SAVE_CONFLICT` (desktop dialog: Save As / Overwrite keeping theirs as a backup / Cancel; CLI: refusal) | 13, 14 |
| TR-DSF-11 | MUST | Save pipeline (§5.1): free-space precheck (`fs.statfs`), temp write, `fsync`, read-back hash verify, backup, durable rename, error codes §7 | 10, 11, 12 |
| TR-DSF-12 | SHOULD | Durable rename: Windows `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH)` (`ReplaceFileW` keeps ACLs and attributes but documents no write-through flag, so it is used only with a following flush); POSIX `rename` then `fsync` of the directory [S14][S15][S17][S18]; through a small native helper (§5.4) | 10 |
| TR-DSF-13 | SHOULD | Backup ring: `<dir>/.llull-backup/<name>/<UTC yyyymmddThhmmssZ>-<sha8>.llull`, newest `BACKUP_KEEP` kept (default owner Q3); `.bak` stays as the newest previous version; `llull backups list\|restore FILE` | 12, 17 |
| TR-DSF-14 | MUST | Envelope v4: `{ format, version: 4, writtenBy: { app: 'llull', version }, integrity: { algorithm: 'sha256', document: <hex> }, document }`; the hash covers `JSON.stringify(document)` exactly as written (§3.3); the file stays deterministic (no timestamp in it) | 16 |
| TR-DSF-15 | MUST | `verify_document` query command (§4.1): stable codes §7, no document change, CLI `llull verify FILE` (host reads the bytes) | 16 |
| TR-DSF-16 | MUST | `load_document` runs the same checks; `DSF_HASH_MISMATCH` opens with a warning (files edited outside llull by agents stay openable), structure / value errors refuse as today with the finding list | 16 |
| TR-DSF-17 | SHOULD | `salvage_document` command (§4.2): lenient parse (prefix of a truncated file), drops invalid entities / steps with one finding each, never invents values; result is a new unsaved document | 18 |
| TR-DSF-18 | MUST | Undo entries carry `{label, source, commandName, at}`; `GET /history` + `llull history --app`; Open / New start a new history (they are not undo entries); Save does not clear history | 01, 02, 03 |
| TR-DSF-19 | MUST | Undo memory budget: each entry records the estimated bytes it alone retains (entities whose object identity differs from the next entry, typed arrays by `byteLength`, other values by serialized length, measured once at record time); the oldest entries are dropped beyond `UNDO_BUDGET_BYTES` (default TBD — measure with VC-DSF-04, owner Q5) but never below `UNDO_MIN_DEPTH` (default 20) entries; the UI says when history was trimmed | 04 |
| TR-DSF-20 | SHOULD | Undo after a kernel operation restores the exact prior document (snapshot, no kernel re-run): `documentHash` before the operation = after undo; redo restores the exact result | 03 |
| TR-DSF-21 | COULD | History-based undo (MG5.4, ROADMAP): an evicted snapshot is rebuilt from the recipe (`replay_history` up to the entry's step); undo survives restart through the recovery journal | 04, 19 |
| TR-DSF-22 | MUST | Format version window (§6.2): reader accepts `[MIN_READABLE, CURRENT]`; one pure migration `vN → vN+1` per bump in `persistence/migrations/`; a migrated document is never written over its file until the user saves, and that first save keeps the original as `<name>.v<N>.llull` | 20 |
| TR-DSF-23 | MUST | A newer-version file is refused with `DSF_VERSION_NEWER` (app version needed from `writtenBy`); the file is never written by the older app | 20 |
| TR-DSF-24 | MUST | `--doc` undo / redo walk the backup ring (depth = ring size), not only `.bak` | 17 |
| TR-DSF-25 | MUST | Fault-injection runner (§9) with every VC of driver `fault`; results in `expected_results.json` form | all |

## 3. Data model

### 3.1 Recovery slot

```ts
// server/src/recovery/slot.ts (host data, never part of CadDocument)
interface RecoverySlotMeta {
  readonly slotId: string;                 // uuid per document session
  readonly createdAt: string;              // ISO
  readonly app: { version: string; pid: number; host: string; session: string };
  readonly source: { path: string; sha256AtOpen: string } | null;   // null = untitled
  readonly checkpoint: { seq: number; stateHash: string; at: string } | null;
  readonly cleanClose: boolean;            // true only after Save + close (then the slot is deleted)
}
// journal.ndjson: one JSON object per line
interface JournalLine {
  readonly seq: number; readonly epoch: string;
  readonly name: string; readonly params: unknown; readonly source: 'rest' | 'cli';
  readonly stateHash: string;              // documentHash after the command (@protocol/liveSync)
  readonly crc32: string;                  // of the line without this field
}
// undo / redo steps are journaled as { seq, kind: 'snapshot', checkpointRef } : an undo forces a checkpoint (it has no command to replay)
```

### 3.2 Lock file

```ts
// <dir>/<name>.llull.lock — JSON, created with flag 'wx'
interface DocumentLock {
  readonly holder: { app: 'llull-desktop' | 'llull-cli'; user: string; host: string; pid: number; session: string };
  readonly acquiredAt: string;
  readonly heartbeatAt: string;            // desktop rewrites every LOCK_HEARTBEAT_MS (atomic replace by the holder only)
  readonly mode: 'write';
}
```

The fields follow the vault lock (`server/src/plm/vault/locks.ts`); both use one module. AutoCAD's `.dwl` / `.dwl2` carry the
same information (user, machine, time) [S5].

### 3.3 Envelope v4

```ts
interface DocumentEnvelopeV4 {
  format: 'llull-document';
  version: 4;
  writtenBy: { app: 'llull'; version: string };       // semver of the writing build
  integrity: { algorithm: 'sha256'; document: string }; // hex of SHA-256 over the UTF-8 bytes of JSON.stringify(document) [S28]
  document: CadDocument;
}
```

The reader re-serializes the parsed `document` with `JSON.stringify` and hashes it; JavaScript's number-to-string and
string escaping are deterministic, so a file written by llull round-trips to the same bytes (verified by VC-DSF-16 on the
whole corpus). A hand-edited file gives `DSF_HASH_MISMATCH` (warning), not a refusal.

## 4. Commands

### 4.1 `verify_document` (query, `readOnly`, toolset `core`)

```ts
params: z.object({
  json: z.string().describe('The file text (the CLI / desktop reads the file)'),
  deep: z.boolean().default(false).describe('Also replay the recipe and compare with the stored entities'),
})
data: { ok: boolean; version: number; writtenBy?: string; findings: { code: string; severity: 'error' | 'warn' | 'info'; path?: string; message: string }[];
        counts: { entities: number; steps: number } }
```

`@affects` nothing (query). `@invariant` never throws (all failures are findings); `deep` is kernel-optional: with
`ctx.kernel` it replays exact operations, without it reports `DSF_DEEP_SKIPPED_NO_KERNEL` for kernel steps.
`@failure` none (a damaged input is a finding list with `ok: false`).

### 4.2 `salvage_document` (mutating, toolset `core`)

```ts
params: z.object({ json: z.string(), dropInvalid: z.literal(true).default(true) })
```

Parses leniently: a truncated text is cut to its longest prefix that closes to valid JSON at an entity or step boundary;
each entity / feature step / collection item that fails validation is dropped with a `DSF_SALVAGE_DROPPED` finding (path,
reason); `order` and `layerOrder` are repaired as `migrate()` does; references to dropped ids are reported, not invented.
Result: a new document (unsaved, no path), `data.findings`. `@failure` nothing salvageable → no-op, `DSF_SALVAGE_EMPTY`.
Analogue: AutoCAD `RECOVER` ("extracts as much data as it can") [S4].

### 4.3 Host verbs (not document commands)

| Verb | CLI | Desktop | Route |
| ---- | --- | ------- | ----- |
| list / restore / discard recovery | `llull recovery list\|show\|restore <slot>\|discard <slot>` | Document Recovery dialog at launch and File > Recover | `GET /recovery`, restore = `load_document` of the slot's recovered text |
| history | `llull history --app` | Edit > History (labels) | `GET /history` |
| backups | `llull backups list\|restore FILE` | File > Previous Versions | file operations, restore keeps the current file in the ring first |
| lock | `llull lock status FILE`, `--break-lock` | dialog on Open | file operations |

## 5. Algorithms

### 5.1 Save pipeline (every document write: desktop Save, CLI `--doc`, checkpoint)

1. `text = serialize(doc)`; `need = byteLength(text)`.
2. `fs.statfs(dir)`: if `bavail × bsize < 2 × need + 1 MiB` → `DSF_SAVE_DISK_FULL` before touching anything (the 2× covers temp + backup copy on file systems without hard links).
3. Conflict check: `sha256(file on disk)` = remembered hash, else `DSF_SAVE_CONFLICT` (TR-DSF-10).
4. Write `<file>.<pid>.tmp`; `fsync` (`FlushFileBuffers` on Windows [S16]). `ENOSPC` / `EIO` → remove temp, `DSF_SAVE_IO` / `DSF_SAVE_DISK_FULL`; the original and the recovery slot are untouched.
5. Read the temp back, compare SHA-256 with `text` → else `DSF_SAVE_VERIFY_FAILED`.
6. Backup: hard link (or copy + fsync) of the current file into the ring and as `.bak` (existing code, `writeFileAtomic.ts:91-115`).
7. Durable rename of the temp over the file (TR-DSF-12), retry on transient sharing errors (existing).
8. Remember the new hash; the recovery slot marks `saved`.

Old-or-new holds at every instant (existing SC-D1 property). Step 7's durability is what TR-DSF-12 adds: without it, a
power cut after a "saved" message can bring back the previous version [S18][S26][S27].

### 5.2 Journal group commit

Commands are acknowledged when applied in memory (today's behaviour, unchanged latency). A writer appends their lines to the
journal and calls `fsync` once per batch; a batch closes after `JOURNAL_FLUSH_MS` or 256 lines. Worst-case loss after a crash
or power cut = commands acknowledged in the last `JOURNAL_FLUSH_MS` + one `fsync` duration (TBD — measure with VC-DSF-06).
Checkpoints are written by a worker thread from the immutable document value (L3 makes this safe without copying).

### 5.3 Lock acquisition

```
open(<name>.llull.lock, 'wx')            → ok: write holder, fsync, keep
EEXIST → read holder
  holder.host == this host && !alive(holder.pid)       → remove (audit), retry once
  holder.host != this host && now - heartbeatAt > LOCK_STALE_MS → report DSF_LOCK_STALE (user / --break-lock decides)
  else                                                 → DSF_DOC_LOCKED {holder}; desktop offers Open Read-Only
```

Exclusive create on an SMB share is assumed to be decided once by the server (not confirmed by a fetched source: VC-DSF-14 tests it on a real share; if it fails, the fallback is a `mkdir`-based lock directory, which `proper-lockfile` uses because "O_EXCL is broken on NFS" [S39]); Windows share modes [S35] cannot be set from Node; the PID test is only valid on
the holder's own host, hence the heartbeat for other hosts. Read-only opens do not take the lock. The lock is advisory for
other programs; llull's own writers all honour it. SQLite's own guidance on network file systems (locking bugs, no WAL
over a network) is why the lock is a separate file and the document is not a database on the share [S22][S23][S25].

### 5.4 Native durable-rename helper

Node exposes neither `MOVEFILE_WRITE_THROUGH` nor directory `fsync` on Windows. Options (decision in §11 Q6): (a) a
napi-rs addon `llull-fsutil` (Rust default, C7) with `replace_durable(temp, target)` and `fsync_dir(dir)`; (b) extend an
existing sidecar with a file verb (one process hop per save); (c) accept the NTFS journal ordering and document the
residual risk. (a) is recommended: no extra process, testable in `native:check`.

### 5.5 Undo memory accounting

At `recordChange`, the entry's retained size = Σ size(e) over entities `e` of the prior snapshot whose object is not
referenced by the current document (identity test, O(changed) with the command's `affected` ids plus deleted ids), plus the
changed top-level slices. `size` = `byteLength` of typed arrays + string lengths × 2 + 8 per number (an estimate, compared with
heap snapshots in VC-DSF-04). Eviction drops the oldest entries until the sum ≤ `UNDO_BUDGET_BYTES` or depth =
`UNDO_MIN_DEPTH`.

## 6. Persistence and interop

### 6.1 JSON vs SQLite (decision)

| Option | For | Against |
| ------ | --- | ------- |
| Keep the JSON envelope (chosen for now) | deterministic, diffable, readable by agents and `jq`; one writer; already validated and corpus-tested | whole-file rewrite on every save and checkpoint (cost on 44 MB documents, pack 03) |
| SQLite container [S24] | incremental, transactional commits; atomic commit proven by its test suite [S23][S40]; partial reads | network-share locking caveats, no WAL over a network [S21][S22][S25] (engineering offices); binary, not diffable; a second format to migrate |

Recovery uses a journal (§5.2) so the JSON rewrite cost moves off the critical path. Revisit SQLite (or a chunked container)
with pack 03 PRF when checkpoint times exceed their budget (§8); owner question Q2.

### 6.2 Format version policy (proposed; owner decision Q1)

- `CURRENT` bumps only on a breaking change; additive optional fields need no bump (today's rule, `serialization.ts:25`).
- `MIN_READABLE`: until the owner declares a compatibility start (proposed: the first pilot build, pack 01), the window may
  shrink at each bump, as the 2026-10-22 rule allows; from that build on, every version ≥ that build's stays readable.
- Each bump ships: one pure migration function, at least one corpus file of the old version with its `.expected.json`, and
  a `DSF_VERSION_OLDER_MIGRATED` info finding on open.
- Precedents: one DWG version (AC1032) spans three AutoCAD releases [S6]; Onshape pins each feature to a FeatureScript version and regenerates "held back" features with the old behaviour [S41].

## 7. Surfaces and stable codes

| Code | Severity | Raised by | Meaning / user action |
| ---- | -------- | --------- | --------------------- |
| `DSF_SAVE_DISK_FULL` | error | save pipeline | not enough free space; original file and recovery intact; free space or Save As elsewhere |
| `DSF_SAVE_IO` | error | save pipeline | write / fsync / rename failed (`errno` in detail); original intact |
| `DSF_SAVE_VERIFY_FAILED` | error | save pipeline | read-back hash differs; original intact |
| `DSF_SAVE_CONFLICT` | error | save pipeline | file changed on disk since open / last save (holder in detail if a lock exists) |
| `DSF_DOC_LOCKED` | error | open / CLI `--doc` | another llull holds the document (`holder`); CLI hint: use `--app` when the holder is this machine's desktop app |
| `DSF_LOCK_STALE` | warn | open | a lock from another host older than `LOCK_STALE_MS`; break only on request |
| `DSF_LOCK_BROKEN` | info | open | a dead same-host lock was removed (audit) |
| `DSF_AUTOSAVE_FAILED` | error | recovery writer | journal or checkpoint write failed; status bar stays red until a write succeeds |
| `DSF_RECOVERY_AVAILABLE` | info | launch | one or more slots to recover |
| `DSF_RECOVERY_PARTIAL` | warn | recovery | replay stopped at line k (CRC / hash / truncation); state = last verified |
| `DSF_HASH_MISMATCH` | warn | verify / load | integrity hash differs (edited outside llull or damaged) |
| `DSF_HASH_ABSENT` | info | verify / load | v1–v3 file without integrity field |
| `DSF_JSON_INVALID` | error | verify / load | not JSON (offset in detail) |
| `DSF_TRUNCATED` | error | verify / load | JSON ends early (offset); `salvage_document` may recover a prefix |
| `DSF_FORMAT_UNKNOWN` | error | verify / load | not a `llull-document` |
| `DSF_VERSION_NEWER` | error | verify / load | written by a newer llull (`writtenBy`); file untouched |
| `DSF_VERSION_TOO_OLD` | error | verify / load | below `MIN_READABLE` |
| `DSF_VERSION_OLDER_MIGRATED` | info | load | migrated in memory from vN |
| `DSF_VALUE_INVALID` | error | verify / load | a value failed validation (`path`) |
| `DSF_DANGLING_REFERENCE` | warn | verify | an id referenced but absent (`path`) |
| `DSF_REPLAY_DIVERGES` | warn | verify `deep` | the recipe regenerates entities that differ from the stored ones |
| `DSF_DEEP_SKIPPED_NO_KERNEL` | info | verify `deep` | kernel steps not replayed |
| `DSF_SALVAGE_DROPPED` | warn | salvage | one item dropped (`path`, reason) |
| `DSF_SALVAGE_EMPTY` | error | salvage | nothing recoverable |
| `DSF_UNDO_TRIMMED` | info | undo | oldest entries dropped by the memory budget |

UI: a status-bar indicator (saved / autosaved n s ago / autosave failing), the Document Recovery dialog (§4.3), Open
Read-Only, Previous Versions. CLI: every code in `--json` output; `llull verify`, `recovery`, `backups`, `history`, `lock`.

## 8. Budgets (spec budgets, grade "target")

| Quantity | Budget | Basis |
| -------- | ------ | ----- |
| Work lost after kill -9 of the backend or a power cut | ≤ `JOURNAL_FLUSH_MS` + 1 fsync of acknowledged commands; default 1,000 ms | spec; incumbents' timer autosaves are minutes (AutoCAD default: 10 minutes after the last save, `SAVETIME` [S1][S2]) |
| Work lost after a renderer crash | 0 commands (document lives in the backend) | architecture L6 |
| Saved file after any fault | complete old or complete new version; never neither | SC-D1 (existing), [S26] |
| Recovery dialog after relaunch | lists every slot not cleanly closed; restore of a 0.5 MB / 4,000-entity doc ≤ TBD — measure with VC-DSF-07 | spec |
| Undo depth | ≥ 100 entries within budget, ≥ `UNDO_MIN_DEPTH` = 20 always | today's 100 kept |
| Undo memory | ≤ `UNDO_BUDGET_BYTES` (TBD — measure with VC-DSF-04, owner Q5) | spec |
| Checkpoint of the 44 MB pack-03 document | off the event loop; UI frame never blocked by it (> 50 ms long task count = 0) | pack 03 PRF |
| Lock heartbeat / stale | `LOCK_HEARTBEAT_MS` = 60 s; `LOCK_STALE_MS` = 10 min (owner-tunable) | spec choice; vault lease 8 h is for check-out, not editing |

## 9. Test strategy

| Kind | Where | VC |
| ---- | ----- | -- |
| unit | `tests/unit/`, `server/tests/` (shared history, envelope v4, verify / salvage codes, migrations, code table) | VC-DSF-01, 02, 16, 18, 20, 22 |
| cli | `llull` scripts against the desktop backend and `--doc` files | VC-DSF-03, 17, 19 |
| perf | pack 03 corpus on the reference machine | VC-DSF-04, 21 |
| fault runner | `server/tests/fault/*.fault.ts` + `scripts/faultRunner.mjs`, `npm run fault` (documented gate, run before a release and nightly; not in `npm run check`: minutes long) | VC-DSF-05, 06, 08, 10, 11, 12, 13, 14, 15, 23 |
| electron | pack 06 E2E harness | VC-DSF-07, 09 |
| power cut (inside the fault runner) | SQLite-style: a file shim that drops or reorders unsynced writes, then a snapshot check [S40]; ALICE-style reordering of the save syscalls [S26]; Windows: VM hard power-off during a save loop | VC-DSF-11 |

The procedures and pass rules are in [`validation/README.md`](validation/README.md).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 | recovery slots + journal + checkpoint; retire `autosave.json` | — | L |
| M2 | renderer / backend crash handling; read-only while backend down; Recovery dialog | M1, pack 06 harness for VCs | M |
| M3 | lock file + conflict check (desktop, CLI `--doc`) | — | M |
| M4 | save pipeline: statfs, verify, backup ring, native durable rename | Q6 | M |
| M5 | envelope v4, `verify_document`, `salvage_document` | Q1 | M |
| M6 | undo labels, document-session boundaries, memory budget; then MG5.4 | M1 (undo across restart) | M / L |
| M7 | version window + migration chain policy | Q1 | S |
| M8 | fault runner + power-cut rig | M1–M4 | M |

Order: M3 and M1 first (they close the lost-update and lost-recovery holes), then M4, M2, M5, M6, M7; M8 grows with each.
Cross-pack: pack 03 PRF (checkpoint cost on large documents), pack 06 E2E (desktop VCs), pack 05 INS (native helper bundled).

## 11. Open questions (owner)

1. **Q1 Compatibility start.** The 2026-10-22 rule says no backward compatibility; professional use needs every file a
   customer saved to open in later versions. Proposal: keep the rule until the first pilot build, then freeze a
   `MIN_READABLE` and require a migration per bump. Also: delete the v1–v3 readers and retired-command rewrites now (as
   the rule says), or keep them (as SC-D2 and the corpus test require)?
2. **Q2 Container.** Keep JSON (proposed) or move to SQLite / a chunked container with pack 03?
3. **Q3 Backups kept per file** (`BACKUP_KEEP`): proposal 10; Revit 2014 defaults: 3 backups non-workshared, up to 20 workshared [S11][S12].
4. **Q4 Discarded recovery kept** 7 days?
5. **Q5 Undo memory budget**: a fixed size or a share of physical RAM; decide after VC-DSF-04 measures it.
6. **Q6 Native durable rename** helper (napi-rs addon) or accept the residual power-loss risk?
7. **Q7 `--doc` on a document open in the app**: refuse with a hint (proposed) or route automatically to `--app`?

## 12. References

See [`validation/sources.md`](validation/sources.md).
