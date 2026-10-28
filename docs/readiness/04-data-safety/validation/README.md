# 04 DSF — Validation plan

Machine: the reference profile `ref-win11` (owner's Windows 11 workstation) unless a case names another; the SMB and
power-cut cases need the rigs of §3. Grades follow [`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md): **A** measured
or read in llull's code / a primary source, **B** one secondary source, **C** located only, **target** = a budget set by this
spec (gating). Pack readiness level: **PRL2 trustworthy**; a case marked PRL1 is a prerequisite of the installable,
observable product (packs 05 / 06 build on it).

Reference documents: `tests/corpus/documents/` (12 files, v1–v3; SC-D2), the SC-D1 save-loop document (4,000 boxes,
~0.5 MB, `server/tests/fixtures/saveLoopChild.ts`), and the 44 MB document of pack 03 PRF (125k-triangle STEP import).

## 1. Use cases

1. **UC-1 Crash and recover.** Backend, renderer, OS or power fails mid-session; relaunch; recover (FR-DSF-05..09).
2. **UC-2 Save safely.** Save under kill, power cut, full disk, I/O error; go back to earlier versions (FR-DSF-10..12, 17).
3. **UC-3 Shared files.** Desktop + CLI `--doc` on one PC; two PCs on an SMB share (FR-DSF-13..15).
4. **UC-4 Trust a file.** Verify, open with a warning, salvage, migrate, refuse newer (FR-DSF-16, 18, 20).
5. **UC-5 Undo.** Shared UI + CLI history, kernel operations, memory, document boundaries (FR-DSF-01..04, 19).

## 2. Validation cases

| VC | Proves | Level | Driver | Input | Expected | Tolerance | Source / grade |
| -- | ------ | ----- | ------ | ----- | -------- | --------- | -------------- |
| VC-DSF-01 | FR-DSF-01, TR-DSF-18 | PRL2 | unit | backend command bus: 5 `rest` + 5 `cli` commands interleaved, then 10 × undo, 10 × redo | after undo: `stateHash` = empty document's; after redo: = final; `GET /history` labels = command names + sources in order | exact | L3 (shared history exists, A); labels target |
| VC-DSF-02 | FR-DSF-02, TR-DSF-18 | PRL2 | unit | edit A (3 commands), `load_document` B through File > Open, undo; then 1 edit, Save, undo | after Open: "Nothing to undo", hash = B; after Save: undo still available | exact | baseline A (code read): Open is an undo entry, undo returns to A |
| VC-DSF-03 | FR-DSF-03, TR-DSF-20 | PRL2 | cli | `--app`, native kernel: `add_box`, `fillet_edge` (exact), undo, redo; kernel call counter | hash after undo = hash before fillet; after redo = hash after fillet; 0 kernel calls during undo / redo | exact | target |
| VC-DSF-04 | FR-DSF-04, TR-DSF-19 | PRL2 | perf | 44 MB document; 150 commands each replacing a 1 M-vertex mesh entity; heap snapshots | retained undo memory ≤ `UNDO_BUDGET_BYTES`; depth ≥ 20; `DSF_UNDO_TRIMMED` shown when trimmed; estimate within ×2 of the heap-snapshot delta | budget TBD — measure with this case (Q5) | baseline TBD — measure; target |
| VC-DSF-05 | FR-DSF-05, FR-DSF-06, TR-DSF-01..04 | PRL2 | fault | P1: edit stream 1 command / 100 ms with timestamps of each ack; backend `SIGKILL` / `TerminateProcess` at a seeded instant; 200 runs | recovered state = the state after some acked command k; every command acked ≥ 1,000 ms before the kill is ≤ k; no state that was never acked | 0 violations | target; baseline: 300 ms debounce (L2), loss not measured |
| VC-DSF-06 | FR-DSF-06, TR-DSF-02 | PRL2 | fault | P2: same stream through a file shim that, at a seeded "power cut", drops all unsynced writes and reorders the unsynced remainder [S40][S26]; 500 cuts; also record the `fsync` duration distribution | same rule as VC-DSF-05; p99 fsync duration reported (feeds §8 of the technical spec) | 0 violations | target |
| VC-DSF-07 | FR-DSF-07, TR-DSF-05 | PRL2 | electron | pack 06 harness: open `bracket.llull` (corpus copy), 12 edits, kill the app tree, relaunch; then open another file and edit twice; relaunch again | dialog lists the slot with path, last-change time, 12 changes; after the second session the first slot is still listed; restore → recovered hash; restore time ≤ TBD (measure) | exact | baseline A (code read): slot shown as untitled with no notice, gone after 2 edits (G1, G2) |
| VC-DSF-08 | FR-DSF-08, TR-DSF-04 | PRL2 | fault | P3: a recovery slot with 50 journal lines; variants: last line torn at every byte offset; one flipped byte in line 30; wrong `stateHash` in line 40 | `DSF_RECOVERY_PARTIAL` naming the line; state = after line 49 / 29 / 39 | exact | target |
| VC-DSF-09 | FR-DSF-09, TR-DSF-06, TR-DSF-07 | PRL2 | electron | (a) `webContents.forcefullyCrashRenderer()` after 5 edits; (b) kill the backend utility process after 5 edits, then try an edit in the window | (a) window reloads, hash unchanged, 0 edits lost, notice shown; (b) backend restarted from its slot, UI read-only until it is back, the attempted edit refused with a status, 0 edits lost | exact | baseline A (code read): no handler; backend not restarted; local-mode edits discarded on reconnect |
| VC-DSF-10 | FR-DSF-10, TR-DSF-11 | PRL1 | fault | P4: extend SC-D1 — save loop killed at seeded instants, 1,000 runs on the 0.5 MB document and 200 runs on the 44 MB document; Windows and Linux | after every kill: file parses and verifies as a complete old or new generation; `.bak` and ring entries complete; no orphan temp after the next save | 0 failures | baseline A: 25 / 25 runs pass (L10) |
| VC-DSF-11 | FR-DSF-10, TR-DSF-12 | PRL2 | fault | P5: Windows 11 VM (Hyper-V), save loop announcing each completed save over a serial / network log outside the VM; hard power-off at random; 50 cycles; with and without TR-DSF-12 | file always complete; with TR-DSF-12, the last save announced before the cut is the version on disk | 0 failures | target; without TR-DSF-12 the result is recorded, not gated |
| VC-DSF-12 | FR-DSF-11, TR-DSF-11 | PRL2 | fault | P6: a volume smaller than 2 × the document (VHD / loop device); Save; then fill the volume during autosave; also an injected `EIO` on `fsync` | Save → `DSF_SAVE_DISK_FULL` before any write, file sha256 unchanged; autosave → `DSF_AUTOSAVE_FAILED` in the status bar within 1 s; `EIO` → `DSF_SAVE_IO`; document still marked unsaved; slot intact | exact | baseline A (code read): console warning only (G11) |
| VC-DSF-13 | FR-DSF-13, FR-DSF-14, TR-DSF-08, TR-DSF-10 | PRL2 | fault | P7: (a) desktop opens `x.llull`; `llull add_box --doc x.llull`; (b) two `--doc` processes each run 100 `add_box` on one file; (c) `x.llull` replaced by another program while open, then Save | (a) `DSF_DOC_LOCKED` with holder and `--app` hint, file unchanged; (b) 200 boxes, or every refused command reported (no silent loss); (c) `DSF_SAVE_CONFLICT`, external version kept | exact | baseline: no lock (L7, L8); lost-update count TBD — measure with (b) on today's build |
| VC-DSF-14 | FR-DSF-14, TR-DSF-08 | PRL2 | fault | P8: two Windows 11 VMs + an SMB 3 share (Windows Server or Samba); (a) both open the file; (b) 1,000 simultaneous lock attempts from both hosts | (a) the second gets holder info and opens read-only; its Save is refused; (b) exactly one winner per attempt | 0 double winners | target; atomicity of exclusive create on SMB not confirmed by a source (sources.md, not verified) — if (b) fails, the `mkdir` fallback [S39] is tested instead |
| VC-DSF-15 | FR-DSF-15, TR-DSF-09 | PRL2 | fault | desktop holding `x.llull` killed; (a) relaunch on the same host; (b) open from a second host before and after `LOCK_STALE_MS` | (a) lock removed, `DSF_LOCK_BROKEN`; (b) `DSF_DOC_LOCKED` before, `DSF_LOCK_STALE` after, lock kept until `--break-lock` / user confirmation | exact | target |
| VC-DSF-16 | FR-DSF-16, TR-DSF-14..16 | PRL2 | unit | the 12 corpus files saved as v4; SC-D2 damaged variants; one digit changed in a box size of a v4 file | every v4 file: `verify_document` `ok`, hash round-trips; changed digit → `DSF_HASH_MISMATCH` (warn) and opens; damaged variants → `DSF_JSON_INVALID` / `DSF_TRUNCATED` / `DSF_VALUE_INVALID` / … (one code each, never a throw) | exact | target; SC-D2 never-throws baseline A (L11) |
| VC-DSF-17 | FR-DSF-12, FR-DSF-17, TR-DSF-13, TR-DSF-24 | PRL2 | cli | 5 commands on a `--doc` file; `llull backups list`; `llull undo --doc` × 5; `llull redo --doc` × 2 | 5 ring entries listed; after 5 undos the file bytes equal the original; after 2 redos = state after command 2 | exact | baseline A: one level (L8) |
| VC-DSF-18 | FR-DSF-18, TR-DSF-17 | PRL3 | unit | each corpus file truncated at 20 seeded offsets; one entity made invalid | `salvage_document` keeps exactly the entities whose JSON lies wholly in the prefix (count derived from the offsets) and drops the invalid one, one `DSF_SALVAGE_DROPPED` per drop; no value invented (every kept entity deep-equals the original) | exact | derived: entity byte ranges of the original file |
| VC-DSF-19 | FR-DSF-19, TR-DSF-21 | PRL3 | cli | 10 commands `--app`, stop and restart the app, undo × 10 | original document hash | exact | target (COULD) |
| VC-DSF-20 | FR-DSF-20, TR-DSF-22, TR-DSF-23 | PRL2 | unit | a v5 envelope; each v1–v3 corpus file (or only those inside the owner's window, Q1) | v5 → `DSF_VERSION_NEWER` naming `writtenBy.version`, file bytes unchanged; older → `DSF_VERSION_OLDER_MIGRATED`, loads as its `.expected.json`; first save writes `<name>.v<N>.llull` beside it | exact | baseline A: v1–v3 read, newer refused (L9) |
| VC-DSF-21 | FR-DSF-21, TR-DSF-03 | PRL2 | perf | 44 MB document, 1 edit / s for 120 s in the desktop app; renderer long-task observer; backend event-loop delay histogram | 0 renderer long tasks > 50 ms attributable to checkpoints; checkpoint duration and backend p99 loop delay recorded | count exact | baseline TBD — measure (today's 300 ms full-file autosave on 44 MB); target |
| VC-DSF-22 | FR-DSF-22 | PRL2 | unit | every refusal path of VC-DSF-05..20 in `--json`; the code table of TECHNICAL_SPEC §7 | each emitted code is in the table; each table code is emitted by ≥ 1 test; all cases run with the network disabled | exact | target |
| VC-DSF-23 | FR-DSF-05, FR-DSF-06, TR-DSF-03 | PRL2 | fault | P1 with kills aimed inside the checkpoint write and the journal rotation (instrumented hooks); 200 runs | VC-DSF-05 rule holds; no slot left without a readable checkpoint or journal | 0 violations | target |

FR → VC coverage: 01→01, 02→02, 03→03, 04→04, 05→05/23, 06→05/06/23, 07→07, 08→08, 09→09, 10→10/11, 11→12,
12→17, 13→13, 14→13/14, 15→15, 16→16, 17→17, 18→18, 19→19, 20→20, 21→21, 22→22 (and every case asserts its codes).

## 3. Procedures

All fault procedures run in the fault runner (`npm run fault`, TECHNICAL_SPEC §9): seeded randomness (seed printed and
recorded), one JSON result per case in the `expected_results.json` shape, artefacts (journals, files, logs) kept on failure.
None of them runs in `npm run check` (minutes long); they gate a release and run nightly.

- **P1 edit stream with kills.** Start the backend with a temp `userData`. A driver sends `add_box` with a sequence number in
  the name at 10 Hz through `POST /command`, logging the ack time of each. At a seeded instant in [2 s, 20 s] kill the backend
  process tree (`SIGKILL` on Linux, `TerminateProcess` via the job object on Windows). Restart, run recovery, read the
  recovered document: k = the highest sequence present; check the set is exactly 1..k and that every command acked
  ≥ 1,000 ms before the kill is ≤ k.
- **P2 power-cut shim.** Same as P1, but the journal and checkpoint writers go through a test file layer that records every
  write and `fsync`. At the cut, materialise the files as: everything synced, plus a seeded subset of unsynced writes in a
  seeded order (the model of [S40]; ALICE explores the same space by syscall reordering [S26]).
- **P3 journal damage.** Write a slot with 50 lines; produce variants by truncation at every byte of the last line, by one
  flipped bit in line 30, by a wrong `stateHash` in line 40; recover each.
- **P4 kill during save.** The SC-D1 child (`server/tests/fixtures/saveLoopChild.ts`) generalised to the save pipeline of
  TECHNICAL_SPEC §5.1 and to the 44 MB document; kill ≤ 200 ms after the first completed save (as SC-D1), seeded.
- **P5 VM power-off.** Hyper-V VM with the app's save loop as a service; each completed save is announced to the host over
  the network before the next starts; the host powers the VM off (`Stop-VM -TurnOff`) at a random instant, boots it, and runs
  `llull verify` on the file and compares its generation with the last announced one.
- **P6 disk full / I/O error.** A fixed-size VHD (Windows) or loop device (Linux) slightly larger than the document;
  injected `EIO` via the test file layer for `fsync`.
- **P7 concurrent writers on one PC.** Desktop through the pack 06 harness; CLI processes started by the runner; the
  external replace uses a plain `copy` over the file.
- **P8 SMB share.** Two VMs on one virtual switch, share on a third (Windows Server SMB 3.1.1) and, separately, Samba; lock
  races triggered by a shared start barrier (a timestamp file); results compared per attempt.

## 4. Expected values and thresholds

Indexed in [`expected_results.json`](expected_results.json) (schema [`../../vc.schema.json`](../../vc.schema.json)). Values
are spec budgets (`grade: target`, gating) or measured / read baselines (`grade: A`). Every "TBD — measure" is filled by
the first run of its case and recorded in [`sources.md`](sources.md) with date and machine; no value is assumed before.
