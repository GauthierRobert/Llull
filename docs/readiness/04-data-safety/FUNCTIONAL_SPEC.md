# 04 DSF — Data safety: undo, recovery, integrity, concurrent access — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `DSF`. Template:
[`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md), [`../../plant/TEMPLATE.md`](../../plant/TEMPLATE.md); track rules:
[`../README.md`](../README.md). Technical view: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). Source ids `[Sn]`:
[`validation/sources.md`](validation/sources.md).

## 1. Summary

A professional engineer stops trusting a tool the first time it loses an afternoon of work or overwrites a colleague's
change. llull already has good pieces: the save is atomic and keeps a `.bak` (tested by killing a process mid-save 25 times),
the backend autosaves 300 ms after each change, every value of a file is validated on open, and the desktop app and the CLI
`--app` share one ordered history. What it does not have is a **guarantee**: the code read for this pack found that

- recovered work is kept in one global `autosave.json`, shown after a crash as an untitled document with no notice, and
  overwritten two edits into the next session (TECHNICAL_SPEC §1.2 G1, G2);
- nothing stops `llull --doc` and the desktop app (or two engineers on a share) from writing the same file: the last
  writer silently wins (G3);
- a crashed backend is not restarted, and edits made meanwhile are accepted in the window, then discarded (G4); a crashed
  renderer leaves a white window (G5);
- undo is 100 in-memory snapshots, not bounded by memory, lost on restart, and crosses Open / New (G6); `--doc` undo is one
  level (G7);
- a file carries no integrity code, there is no verify verb, and a file that fails one validation does not open at all
  (G8); the saved rename is not flushed for power loss (G9); one backup level (G10); a full disk is not reported (G11);
- the format policy contradicts itself: the owner's "no backward compatibility" rule versus readers for v1–v3 (G12).

This pack specifies the guarantees (never lose more than 1 s of acknowledged work; a saved file is always complete; one
writer per document; every file verifiable) and the fault-injection tests that prove them.

## 2. Context and value

**How incumbents protect data.**

| Tool | Mechanism | Source |
| ---- | --------- | ------ |
| AutoCAD | timed automatic save, default 10 minutes after the last save (`SAVETIME`); `.bak` previous version (`ISAVEBAK`); optional full-time CRC validation of objects read | [S1][S2] |
| AutoCAD | Drawing Recovery Manager: after a failure lists every drawing open at the time, with up to 4 candidates (recovered DWG, autosave SV$, BAK, original) and the user chooses which to keep | [S3] |
| AutoCAD | `RECOVER` repairs and opens a damaged drawing, extracting "as much data as it can" | [S4] |
| AutoCAD | `.dwl` / `.dwl2` lock files beside the drawing name the user, machine and time; left behind after a crash | [S5] (B) |
| SOLIDWORKS | backup / auto-recover options (copies per document, minutes between recovery files); defaults not confirmed | [S7] (C) |
| Onshape | every change by every user is kept; restore to any point is itself a new history entry; versions are immutable; undo is per user, per tab, per session | [S8][S9][S10] |
| Revit | backups per project (2014 defaults: 3 non-workshared, up to 20 workshared); worksharing: a borrowed element gives exclusive edit rights | [S11][S12][S13] |
| SQLite as a file format | atomic, crash-safe writes, continuous update instead of File / Save, persistent undo; but locking over network file systems is unreliable and WAL does not work over a network | [S24][S21][S22][S25] |

**What research says.** Crash-consistent file updates are hard: the OSDI 2014 study found 60 vulnerabilities in eleven
widely used systems [S26]. `rename` replaces atomically for other processes, but a crash needs the file *and* its
directory flushed [S17][S18][S27]; on Windows only `MoveFileExW` documents a write-through flag [S14][S15]. SQLite's own
test suite injects I/O errors, crashes mid-write and reorders unsynced writes [S40] — the model for this pack's fault runner.

**Why llull must close the gap.** The readiness question (track [`README.md`](../README.md)) is daily professional use. A
pilot (pack 01) cannot start on a tool that can silently lose work; engineering offices keep projects on network shares
where two people open the same file; agents drive the same document through the CLI while the engineer works in the app.

## 3. Personas and user stories

- **Engineer (primary operator, desktop app).**
  - US-1: "When the app or the PC dies, I relaunch and get my work back, minus at most a second, and I am told so."
  - US-2: "I undo the last 100 steps, including a fillet the kernel computed, and get exactly what I had."
  - US-3: "When a colleague has the file open on the share, I am told who, and I can open it read-only."
  - US-4: "When the disk is full, I am told before I lose anything, and the file on disk is untouched."
  - US-5: "I can go back to any of the last saved versions of a file."
  - US-6: "A file someone emailed me that is damaged opens as far as it can, with a list of what was dropped."
- **Agent (CLI).**
  - US-7: "`llull --doc` on a file open in the app is refused with a hint to use `--app`, instead of being overwritten later."
  - US-8: "`llull verify FILE --json` gives me stable codes I can act on."
  - US-9: "`llull undo --doc` steps back more than one command."
- **CAD manager / IT.**
  - US-10: "A file written by a newer llull is never damaged by an older one; an old file opens in a new llull."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | M3 document lock + conflict check · M1 recovery slots + journal · M4 save pipeline (disk-full precheck, verify, durable rename) · M2 renderer / backend crash handling, Document Recovery dialog · fault runner for these |
| **V1** | M5 envelope v4 with integrity, `verify_document`, `salvage_document` · M6 undo labels, document boundaries, memory budget · backup ring, Previous Versions · M7 version-window policy |
| **V2** | history-based undo (MG5.4) and undo across restart · SQLite / chunked container if pack 03 shows the JSON checkpoint too slow |
| Out of scope | multi-user co-editing of one document (Revit-style worksharing, Onshape-style concurrent editing): llull is local-first, one writer per document; cloud backup (LC1); encryption at rest (OS / disk) |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-DSF-01 | MUST | Every change to the open document, from the UI or from `llull --app`, enters one ordered undo history; each entry is labelled with its command and source (`ui` / `cli`); undo restores the exact prior state (same `stateHash`) and redo the exact next one | one document, two callers (L1, L6) | code: `server/src/commandBus.ts`; [S10] |
| FR-DSF-02 | MUST | Undo never crosses documents: New and Open start a new history; Save does not clear it | today Open is an undo entry (G6) | code read |
| FR-DSF-03 | MUST | Undo / redo after a kernel operation (boolean, fillet, import) restores the exact prior / next state without re-running the kernel | undo must be instant and exact | L3 snapshots |
| FR-DSF-04 | MUST | Undo keeps ≥ 100 entries when they fit a memory budget, and always ≥ 20; when entries are dropped for memory the user is told (`DSF_UNDO_TRIMMED`) | 44 MB documents (pack 03) | spec budget |
| FR-DSF-05 | MUST | Every acknowledged change is on durable storage within 1 s (recovery point objective, configurable) | AutoCAD's default is 10 minutes [S1]; a CAD session must not lose minutes | spec budget |
| FR-DSF-06 | MUST | After a kill of any llull process, an OS crash or a power cut, the next launch restores the document to a state containing every change acknowledged ≥ 1 s before the fault, and never a state that was not acknowledged | US-1 | [S26][S40] |
| FR-DSF-07 | MUST | A Document Recovery dialog at launch lists every document not cleanly closed: source file (or untitled), time of last change, changes since the last save; per document: open recovered / open last saved / open a backup / discard. A recovery is never overwritten by another session; discarded recoveries stay retrievable 7 days | AutoCAD Drawing Recovery Manager [S3]; G1, G2 | [S3] |
| FR-DSF-08 | MUST | A damaged recovery (torn write, bad bytes) recovers the last verified state and says which change it stopped at | partial is better than nothing | [S40] |
| FR-DSF-09 | MUST | A renderer crash reloads the window with no loss; a backend crash restarts the backend from its recovery within the same session; while the backend is down the UI does not accept edits | G4, G5 | [S32][S33] |
| FR-DSF-10 | MUST | Save is atomic and durable: at every instant the file is a complete previous or new version; once "Saved" is shown, the new version survives a power cut | G9 | [S14][S17][S18] |
| FR-DSF-11 | MUST | A full disk or an I/O error during save or autosave is reported at once (stable code, status bar), leaves the file and the recovery untouched, and keeps the document marked unsaved | G11 | [S40] |
| FR-DSF-12 | SHOULD | Each save keeps the previous version as `.bak` and in a ring of the last N saved versions (N owner-set); File > Previous Versions and `llull backups` restore one | G10; AutoCAD `.bak` [S1], Revit backups [S11][S12] | [S1][S11] |
| FR-DSF-13 | MUST | A save never overwrites a file changed on disk since it was opened or last saved without asking (desktop) or refusing (CLI) | lost update (G3) | code read |
| FR-DSF-14 | MUST | One writer per document across the desktop app, `llull --doc` processes and other machines on a share: a second writer gets the holder (user, machine, since) and can open read-only; `--doc` on a document open in this machine's app is refused with the `--app` hint | G3; `.dwl` precedent [S5]; Revit borrowing [S13] | [S5][S13] |
| FR-DSF-15 | MUST | A lock left by a crashed llull on the same machine is cleared automatically; a lock from another machine is only broken on an explicit request after it went stale | stale locks after crashes [S5] | [S5][S39] |
| FR-DSF-16 | MUST | Every saved file carries an integrity hash; `verify_document` (UI, `llull verify`) reports stable codes; opening a file runs the same checks (hash mismatch = warning, invalid structure = refusal with the list) | G8 | [S28][S2] |
| FR-DSF-17 | SHOULD | `llull undo` / `redo` on a `--doc` file step through the backup ring, not one level | G7 | code read |
| FR-DSF-18 | SHOULD | `salvage_document` opens a damaged file as far as it can, listing every dropped item; it never invents values | AutoCAD `RECOVER` [S4] | [S4] |
| FR-DSF-19 | COULD | Undo history survives a restart and a recovery | SQLite file-format persistent undo [S24]; Onshape history [S8] | [S8][S24] |
| FR-DSF-20 | MUST | A file written by a newer llull is refused (stating the version needed) and never written; an older readable file is migrated in memory, and its first save keeps the original beside it; the readable version window is published (owner decision Q1) | G12 | [S6][S41] |
| FR-DSF-21 | SHOULD | Autosave / checkpoint never freezes the UI, including on the 44 MB pack-03 document | pack 03 | spec budget |
| FR-DSF-22 | MUST | Every data-safety refusal or finding has a stable `DSF_*` code in CLI `--json` and UI, works offline, and is listed in TECHNICAL_SPEC §7 | AF-11, AF-41 | AGENT_FIRST |

## 6. Workflows

**Desktop (primary).**

```text
crash / power cut ─▶ relaunch ─▶ Document Recovery dialog (FR-DSF-07)
   bracket.llull   last change 14:02:31   12 changes since save   [Open recovered] [Open saved] [Backups…] [Discard]
open a file on \\server\projects\ held by a colleague ─▶ "Held by j.doe on PC-ENG-07 since 09:14" [Open read-only] [Cancel]
save while the share is full ─▶ DSF_SAVE_DISK_FULL, file untouched, title stays "unsaved", recovery intact
```

**CLI (agent).**

```text
llull verify part.llull --json                     # findings with DSF_* codes (FR-DSF-16)
llull add_box … --doc part.llull                   # DSF_DOC_LOCKED: open in llull desktop on this PC — use --app (FR-DSF-14)
llull recovery list                                # slots, source files, change counts (FR-DSF-07)
llull backups list part.llull ; llull undo --doc part.llull   # ring (FR-DSF-12, 17)
llull exec salvage_document json=@text:broken.llull --doc rescued.llull   # (FR-DSF-18)
llull history --app                                # labelled shared history (FR-DSF-01)
```

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| UI and CLI `--app` interleave 10 changes | undo 10 times | empty document hash; each undo labelled with command + source | VC-DSF-01 |
| document A edited, then File > Open B | Undo | "Nothing to undo"; A not restored | VC-DSF-02 |
| a native fillet applied | undo, redo | hashes equal to before / after; no kernel call | VC-DSF-03 |
| 150 changes on the 44 MB document | measure | memory ≤ budget; ≥ 20 entries; `DSF_UNDO_TRIMMED` shown if trimmed | VC-DSF-04 |
| a scripted edit stream | the backend is killed (-9) at random instants | recovery holds every change acked ≥ 1 s before, none un-acked | VC-DSF-05 |
| unsynced writes dropped / reordered (power-cut shim) | recover | same rule as above | VC-DSF-06 |
| the app crashed with `bracket.llull` open | relaunch | dialog lists it with path, time, change count; restore gives the recovered hash | VC-DSF-07 |
| a journal with a torn last line or a flipped byte | recover | `DSF_RECOVERY_PARTIAL` at that line; state = previous line | VC-DSF-08 |
| the renderer is crashed / the backend is killed | — | window reloads, no change lost; backend restarted, UI read-only meanwhile | VC-DSF-09 |
| a save loop on 0.5 MB and 44 MB files | killed 1,000 times | file always a complete old or new version | VC-DSF-10 |
| a VM powered off during saves | reboot | file complete; every save acknowledged before the cut is there | VC-DSF-11 |
| a nearly full volume | Save / autosave | `DSF_SAVE_DISK_FULL` / `DSF_AUTOSAVE_FAILED`; file bytes unchanged | VC-DSF-12 |
| the app has `x.llull` open | `llull … --doc x.llull`; two `--doc` writers in parallel | `DSF_DOC_LOCKED`; no lost update; external edit → `DSF_SAVE_CONFLICT` | VC-DSF-13 |
| two PCs on one SMB share | both open the file; 1,000 lock races | second read-only; exactly one winner per race | VC-DSF-14 |
| a desktop holding a lock is killed | relaunch on the same PC / open from another PC | `DSF_LOCK_BROKEN` / `DSF_LOCK_STALE` (not broken without request) | VC-DSF-15 |
| the corpus files and their damaged variants | `verify_document` | hash round-trips on every v4 file; each damage → its code | VC-DSF-16 |
| 5 commands on a `--doc` file | `llull undo --doc` × 5 | the original file | VC-DSF-17 |
| a corpus file truncated at many offsets | `salvage_document` | every entity wholly inside the prefix kept; each drop listed | VC-DSF-18 |
| 10 changes, app restarted | undo × 10 | original document (COULD) | VC-DSF-19 |
| a v5 file / a v3 file | open in a v4 build; save | `DSF_VERSION_NEWER`, file unchanged / migrated, original kept as `.v3.llull` | VC-DSF-20 |
| the 44 MB document edited continuously | checkpoints run | 0 UI long tasks > 50 ms caused by them | VC-DSF-21 |
| any DSF refusal | `--json` | the code is one of §7's table | VC-DSF-22 |
| a kill during checkpoint + journal rotation | recover | consistent state, rule of VC-DSF-05 | VC-DSF-23 |

## 8. Standards and practice alignment

- No standard governs CAD file durability. The pack follows OS API contracts (`MoveFileExW`, `FlushFileBuffers`,
  `CreateFileW` share modes, POSIX `rename` / `fsync`) [S14][S16][S17][S18][S35], SHA-256 (FIPS 180-4) for integrity [S28],
  chunk-CRC practice (PNG) for journal lines [S29], and SQLite's published test method as the fault-injection model [S40].
- Record keeping for engineering deliverables (PLM release, signatures) is pack 09 PLM's vault; this pack covers the working
  file, not released revisions.

## 9. KPIs

| KPI | Today | Target |
| --- | ----- | ------ |
| Acknowledged work lost after kill -9 of the backend | ≤ 300 ms debounce + write time (not measured) | ≤ 1 s, measured (VC-DSF-05) |
| Work kept after crash + 2 edits in the next session | lost (G2, code read) | kept until the user chooses |
| Lost updates with app + `--doc` on one file | possible (G3, code read; not measured) | 0 |
| Kill-during-save runs passing | 25 / 25 (SC-D1) | 1,000 / 1,000 on 0.5 MB and 44 MB |
| Power-cut runs with a complete file | not tested | 100 % |
| Undo depth / memory bound | 100 entries / none | ≥ 100 within budget, ≥ 20 always |
| Backup versions per file | 1 (`.bak`) | ring of N (owner) |
| Damaged-file outcome | refuse or open (SC-D2: never throws) | verify codes + salvage |

## 10. Risks and assumptions

- Consumer disks may "lie about syncing" [S22]: durability is only as good as the hardware; VC-DSF-11 uses a VM to bound
  what software controls.
- Exclusive create on SMB is assumed atomic on the server; not confirmed by a fetched source — VC-DSF-14 tests it, with a
  `mkdir` lock as fallback [S39].
- Journal replay depends on deterministic commands (L8, already required by live sync's `stateHash`); a non-deterministic
  command breaks recovery at that line (VC-DSF-08 shows the partial path).
- The checkpoint cost on large documents is unknown (TBD — measure with VC-DSF-21); if too high, pack 03 decides the
  container (Q2).
- The owner's no-backward-compatibility rule (2026-10-22) conflicts with FR-DSF-20 for released files: owner decision Q1.

## 11. References

See [`validation/sources.md`](validation/sources.md) for URLs, what was taken and grades.
