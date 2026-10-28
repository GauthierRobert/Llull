# 04 DSF — Sources

Grades ([`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md)): **A** primary source read (vendor / OS / standard
documentation, paper page) or measured / read in llull's code; **B** one secondary source; **C** located, content not
confirmed. Accessed 2026-10-28. Only grade A values and spec budgets gate pass / fail. Quotes are exact unless marked
"paraphrase".

## External sources

| Id | Source | URL | Taken | Grade |
| -- | ------ | --- | ----- | ----- |
| S1 | About Saving Drawings — Autodesk (AutoCAD LT 2023 help) | https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-LT/files/GUID-5692ECA7-091D-446B-B946-BC8FF893E296.htm | "By default, the program automatically saves your drawing 10 minutes after the last time it was saved."; paraphrase: a `.bak` keeps the previous version, rename it to `.dwg` to recover | A |
| S2 | Open and Save Tab (Options) — Autodesk (2021 help) | https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-LT/files/GUID-B0644A61-DE0C-485D-A251-AEC7CE261E07.htm | Minutes Between Saves = `SAVETIME`; Create Backup Copy = `ISAVEBAK`; "Full-Time CRC Validation … a cyclic redundancy check (CRC) should be performed each time an object is read into the drawing"; temporary save extension `.ac$` | A |
| S3 | Drawing Recovery Manager — Autodesk (2026 help) | https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-LT/files/GUID-3F8671B7-B5E7-4092-96C7-C7C330E6C06C.htm | lists "all drawing files that were open at the time of a program or system failure"; up to 4 files per drawing (recovered DWG, SV$, BAK, original); the user chooses which is saved | A |
| S4 | RECOVER (Command) — Autodesk (2018 help) | https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-LT/files/GUID-78F5B1AB-583F-410F-85DA-6D03768832C8.htm | "Repairs and then opens a damaged drawing file … extracts as much data as it can" | A |
| S5 | DWL2 new DWL in AutoCAD 2008 — JTB World blog | https://blog.jtbworld.com/2007/04/dwl2-new-dwl-in-autocad-2008.html | DWL2 = XML with username, machinename, fullname, datetime; "A DWL file is automatically created when a file is opened and then deleted when the file is closed"; left behind after a crash | B |
| S6 | DWG format description — Library of Congress | https://www.loc.gov/preservation/digital/formats/fdd/fdd000445.shtml | "The AC1032 version of DWG has been used from AutoCAD 2018 through AutoCAD 2020"; no published specification | B |
| S7 | Backup/Recover Options — SOLIDWORKS help | https://help.solidworks.com/2024/english/SolidWorks/sldworks/HIDD_OPTIONS_BACKUPS.htm | page JS-rendered, not read; search snippets mention backups per document and auto-recover minutes; **no default confirmed** | C |
| S8 | Versions and history — Onshape help | https://cad.onshape.com/help/Content/Document/versions_and_history.htm | "Onshape keeps a history of all the changes made to every document by every user"; restore "to a specific point in history at any time"; "Versions are immutable" | A |
| S9 | Restoring — Onshape help | https://cad.onshape.com/help/Content/Document/restoring.htm | "the Restore operation is displayed as the latest change" | A |
| S10 | User interface basics — Onshape help | https://cad.onshape.com/help/Content/Home/user_interface_basics.htm | undo / redo "available per user, per tab, per session" | A |
| S11 | Revit 2014 help (backups) — Autodesk | https://help.autodesk.com/cloudhelp/2014/ENU/Revit/files/GUID-9E552B34-7C91-4159-B810-4295B2854AA7.htm | "By default, non-workshared projects have 3 backups, and workshared projects have up to 20 backups." (2014; current default not verified) | A |
| S12 | Specifying the Number of Backup Files — Revit 2014 help | https://help.autodesk.com/cloudhelp/2014/ENU/Revit/files/GUID-A9EE1E44-CCAA-464B-AAC3-438C01078B27.htm | "By default, Revit saves up to 3 backup files for each project." | A |
| S13 | Borrow Elements — Revit 2025 help | https://help.autodesk.com/cloudhelp/2025/ENU/Revit-Collaborate/files/GUID-27E3B22D-79D3-44F5-A630-6E5F614585B4.htm | borrowing gives "exclusive rights to edit the element"; requests granted when the owner synchronizes and relinquishes | A |
| S14 | MoveFileExW — Microsoft Learn | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw | `MOVEFILE_REPLACE_EXISTING`; `MOVEFILE_WRITE_THROUGH` "does not return until the file is actually moved on the disk"; SMB 3.0 supported; no explicit atomicity statement | A |
| S15 | ReplaceFileW — Microsoft Learn | https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew | keeps creation time, ACLs, streams; `REPLACEFILE_WRITE_THROUGH` "This value is not supported."; all three files on one volume; partial-failure codes 1175–1177 | A |
| S16 | FlushFileBuffers — Microsoft Learn | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers | "causes all buffered data to be written"; costly per write; SMB 3.0 supported | A |
| S17 | rename(2) — man7.org | https://man7.org/linux/man-pages/man2/rename.2.html | "If newpath already exists, it will be atomically replaced … there is no point at which another process attempting to access newpath will find it missing" | A |
| S18 | fsync(2) — man7.org | https://man7.org/linux/man-pages/man2/fsync.2.html | "Calling fsync() does not necessarily ensure that the entry in the directory containing the file has also reached disk. For that an explicit fsync() on a file descriptor for the directory is also needed." | A |
| S19 | File system — Node.js docs | https://nodejs.org/api/fs.html | rename: "In the case that newPath already exists, it will be overwritten"; fsync implementation "operating system and device specific"; no Windows flags exposed | A |
| S20 | write-file-atomic — npm (GitHub README) | https://github.com/npm/write-file-atomic | temp file, fsync, rename; writes to one file queued and serialized | B |
| S21 | Write-Ahead Logging — sqlite.org | https://www.sqlite.org/wal.html | "WAL does not work over a network filesystem" | A |
| S22 | How To Corrupt An SQLite Database File — sqlite.org | https://www.sqlite.org/howtocorrupt.html | locking bugs "especially true of network filesystems"; "most consumer-grade mass storage devices lie about syncing" | A |
| S23 | Atomic Commit In SQLite — sqlite.org | https://www.sqlite.org/atomiccommit.html | assumes buffered, reordered writes and working fsync; warns flush primitives "are broken on some versions of Windows and Linux"; Windows network file systems' locking "subtly broken", recommends a secondary locking mechanism | A |
| S24 | SQLite As An Application File Format — sqlite.org | https://www.sqlite.org/appfileformat.html | writes "are atomic … even during system crashes or power failures"; continuous update instead of File / Save; persistent undo / redo | A (vendor whitepaper) |
| S25 | SQLite Over a Network — sqlite.org | https://www.sqlite.org/useovernet.html | network sync "can be less robust"; exclusive locks have operated incorrectly and "led to database corruption" | A |
| S26 | Pillai et al., All File Systems Are Not Created Equal, OSDI 2014 — USENIX | https://www.usenix.org/conference/osdi14/technical-sessions/presentation/pillai | "eleven widely-used systems … a total of 60 vulnerabilities"; tools BOB and ALICE | A |
| S27 | Files are hard — Dan Luu | https://danluu.com/file-consistency/ | rename atomicity holds for normal operation, not crashes; parent directory needs fsync | B |
| S28 | FIPS 180-4 Secure Hash Standard — NIST | https://csrc.nist.gov/pubs/fips/180-4/upd1/final | digests "are used to detect whether messages have been changed since the digests were generated" | A |
| S29 | PNG Specification, Third Edition — W3C | https://www.w3.org/TR/png-3/ | per-chunk four-byte CRC over type and data, "can be used to check for corruption" | A |
| S30 | Command pattern — Refactoring.Guru | https://refactoring.guru/design-patterns/command | undo by command history + state backup, or by inverse operations, which "can be hard or even impossible" | B |
| S31 | Berlage, A selective undo mechanism for graphical user interfaces based on command objects, ACM TOCHI 1(3) 1994 — DOI 10.1145/196699.196721 | https://doi.org/10.1145/196699.196721 | citation located; text not read (selective undo is out of scope; kept as the reference for a later per-source undo) | C |
| S32 | RenderProcessGoneDetails — Electron | https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details | reasons `clean-exit`, `abnormal-exit`, `killed`, `crashed`, `oom`, `launch-failed`, `integrity-failure`, `memory-eviction` | A |
| S33 | webContents; app — Electron | https://www.electronjs.org/docs/latest/api/web-contents ; https://www.electronjs.org/docs/latest/api/app | `render-process-gone` "Emitted when the renderer process unexpectedly disappears"; `child-process-gone` for Utility and other processes | A |
| S34 | crashReporter — Electron | https://www.electronjs.org/docs/latest/api/crash-reporter | Crashpad; `uploadToServer` defaults to true, false keeps dumps in `crashDumps` (offline use must set false) | A |
| S35 | CreateFileW — Microsoft Learn | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew | share mode 0 prevents later opens requesting read / write / delete (`ERROR_SHARING_VIOLATION`); `FILE_SHARE_DELETE` allows delete and rename | A |
| S36 | LockFileEx — Microsoft Learn | https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex | exclusive region lock; released at process exit with timing that "depends upon available system resources"; SMB 3.0 | A |
| S37 | Opportunistic Locks — Microsoft Learn | https://learn.microsoft.com/en-us/windows/win32/fileio/opportunistic-locks | oplocks are for client caching and coherency, not application locking | A |
| S38 | Oplock overview — Microsoft Learn (WDK) | https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/oplock-overview | SMB clients cache file data under oplocks; break on an incompatible open | A |
| S39 | proper-lockfile — README | https://github.com/moxystudio/node-proper-lockfile | `mkdir` lock "works atomically on any kind of file system, even network based ones"; "O_EXCL is broken on NFS"; stale default 10,000 ms, mtime refreshed every stale / 2 | B |
| S40 | How SQLite Is Tested — sqlite.org | https://www.sqlite.org/testing.html | I/O error testing (VFS fails after n operations: disk full, hardware, network); crash testing (child crashes mid-write; VFS reorders and corrupts unsynced writes); OOM stepping | A |
| S41 | FeatureScript standard library — Onshape | https://cad.onshape.com/FsDoc/library.html | imports pin a version; a "held back" feature regenerates with the older version's behaviour | A |

Not verified (not used as gating values): SOLIDWORKS defaults; Fusion automatic recovery interval (forum pages blocked);
AutoCAD `SAVEFILEPATH`, `.sv$` location and the single-`.bak` rule (support KB pages returned 403); current Revit backup
defaults; a paper on undo in feature-based CAD; Electron guidance on reloading a crashed renderer; SMB leases; atomicity of
exclusive create on SMB; Node.js Windows rename / fsync specifics.

## llull code and measurements (grade A, read 2026-10-28 on f1351cff)

| Id | What | Where |
| -- | ---- | ----- |
| L1 | Atomic replace with `.bak`, retry on Windows sharing errors, orphan cleanup | `server/src/writeFileAtomic.ts` |
| L2 | Backend autosave: one `autosave.json`, 300 ms debounce, async, `.bak`, flush on signals / uncaught | `server/src/autosave.ts`, `server/src/liveDocument.ts`, `server/src/lifecycle.ts`, `desktop/src/backendEnv.ts:65` |
| L3 | Undo: snapshot stacks, `HISTORY_LIMIT = 100`, one per backend | `packages/protocol/src/history.ts`, `server/src/commandBus.ts` |
| L4 | Renderer autosave only offline; `RestoredBanner` | `src/ui/hooks/useAutosave.ts`, `src/ui/components/RestoredBanner.tsx` |
| L5 | Local mode discards offline edits on reconnect | `src/ui/store/store.ts:22,93`, `src/ui/store/localMode.ts` |
| L6 | Desktop: no `render-process-gone` handler; backend exit not restarted | `desktop/src/main.ts`, `desktop/src/backend.ts:98-104` |
| L7 | Desktop Open / Save: no lock, no on-disk change check | `desktop/src/documents.ts` |
| L8 | CLI `--doc`: read-execute-write, no lock; one-level `.bak` undo | `server/src/cli/backend.ts:63-147` |
| L9 | Envelope v3, readers v1–v3, migrations, newer refused, value validation | `packages/core/src/commands/persistence/serialization.ts` |
| L10 | SC-D1 kill-during-save: 25 runs, ~0.5 MB, 4,000 entities, kill ≤ 200 ms after first save — passing | `server/tests/saveKill.test.ts`, [`../../../decisions/SC1-solidcraft-parity.md`](../../../decisions/SC1-solidcraft-parity.md) |
| L11 | SC-D2 damaged corpus never throws | `tests/unit/documentCorpusDamaged.test.ts`, `tests/corpus/documents/` (12 files v1–v3) |
| L12 | Vault lock (O_EXCL, 8 h lease, stale rule) | `server/src/plm/vault/locks.ts`, `desktop/tests/vaultLocks.test.ts` |
| L13 | Owner rule "no backward compatibility" (2026-10-22) | project memory `no-backward-compat.md` (owner instruction, not in the repo) |
