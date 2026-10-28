# Air-gapped licensing procedure (VC-COM-01, 04, 05, 34, 37)

Runs on the pack 05 clean-VM images (`install-vm` driver). Not runnable before M2 (licensing) and M4 (reset, update) — the
commands below are the specified surface (TECHNICAL_SPEC §4).

## Setup

- VM A and VM B: same image, llull release candidate installed, **network adapter disabled** before first start.
- Host firewall / VM hypervisor logs every outbound connection attempt of the VM (Windows: `netsh advfirewall` logging of
  dropped and allowed connections, or a hypervisor-level capture); log cleared at start.
- Vendor side (a separate machine): the licence issuer CLI with a **test** signing key whose key id is in the candidate's
  pinned test key set (test builds only; release builds pin production keys).
- Transfer medium: a virtual USB drive or shared folder mounted read-only / write-only per step.

## A. Activation (VC-COM-01, 37)

1. VM A: `llull license status --json` → `LIC_MISSING`, `mode: read-only`.
2. VM A: open the sample document, `save`, `export_stl --save a.stl` → succeed (FR-COM-03).
3. VM A: try a mutating command (`add_box size=[10,10,10]`) → refusal `LIC_READ_ONLY`.
4. VM A: `llull license request --out req.llreq`; copy `req.llreq` to the medium. Inspect: only `product`, `appVersion`,
   64-hex `machine`, `createdAt` (VC-COM-04 check).
5. Vendor: issue `node-locked`, `perpetual`, `maintenanceUntil` = build date + 365 d, bound to the request's machine hash.
6. VM A: `llull license import licence.llic` → `LIC_OK`, `mode: full`; step 3 now succeeds.
7. Desktop app on VM A: Help › Licence… shows the same code and dates (VC-COM-09).
8. End of session: outbound log has **0** attempts (VC-COM-37).

## B. Wrong machine (VC-COM-04)

1. Copy `licence.llic` (and the whole licence state folder) from VM A to VM B.
2. VM B: `llull license status --json` → `LIC_MACHINE_MISMATCH`, read-only; open / save / export still succeed.

## C. Clock set back (VC-COM-05)

1. VM A licensed (A.6). Note `T = now`.
2. Set the VM clock to `T − 30 d` (hypervisor time sync off).
3. `llull license status --json` → `LIC_CLOCK_ANOMALY`, `mode: full`, `graceEndsOn = first detection + 14 d`.
4. Advance the clock past `graceEndsOn` (still earlier than `T`) → `mode: read-only`; data actions succeed.
5. Import a fresh licence file issued after step 4 → `LIC_OK`.

## D. Update from a LAN share (VC-COM-17, 37)

1. Put the signed installer + `releases.json` + `.sig` of the next build on a shared folder.
2. `llull update check --source <share>` → the build is listed; install it → succeeds offline.
3. Flip one byte of the installer → `llull update verify` → `REL_SIGNATURE_INVALID`.
4. Offer the previous version → `REL_DOWNGRADE`.

## E. Data removal (VC-COM-34)

1. After A–D, `llull reset --all --yes --json` → list of removed paths.
2. Search the user-data `llull/` tree and `~/.llull/` → no file left; user documents saved elsewhere untouched.

Record: `records/VC-COM-01-<date>.md` etc. with the VM image id, build version + commit, and the outbound log hash.
