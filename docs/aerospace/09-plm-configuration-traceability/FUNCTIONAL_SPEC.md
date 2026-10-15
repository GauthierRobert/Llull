# Gap 09 — PLM, configuration management & quality traceability — Functional specification

Gap id: **PLM** · Status: draft spec (no implementation) · Date: 2026-10-15 ·
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

---

## 1. Summary

llull can model, parametrize, draw and export a part, but it cannot answer the questions an aerospace design organization
must answer for every piece of design data:

- *Which* part is this (part number)?
- *Which* revision, and is it **released**?
- *Who* approved it and when, and *what changed* since the previous revision and *why* (which change order)?
- *For which* serial numbers, MSNs or dates is it effective?
- *Can we prove* the file in the archive is bit-for-bit the one that was approved?

Today llull has a replayable feature history (architecture L8), named configurations (design-table variants), a drawing
title block with free-text `partNumber`/`revision`, and a server-side audit trail (JSONL, SHA-256 of params). None of these
is a **configuration-managed item**:

- the title block revision is just text;
- nothing prevents editing a "released" model;
- there is no change object;
- there is no effectivity;
- the content hash is non-cryptographic (FNV) or not canonical;
- the desktop product (KI6) is file-based with no vault, no locking and no signed release package.

Regulation requires a design organization to control design data and its changes (14 CFR 21.137(a) [R8]; EASA 21.A.239
design assurance [R11]; AS9100D 8.1.2 [R4]). It also requires keeping type-design data retrievable and tamper-protected for
the product's operational life (21.A.55 / AMC 21.A.5 [R9]). Without that control, llull output cannot be the **master**
of type-design data (14 CFR 21.31 [R6]). Today it can only be an unmanaged sketch tool. This gap closes that, offline first.

## 2. Aerospace context & value

### 2.1 What configuration management is (public framework)

SAE EIA-649C defines five CM functions [R1]:

- CM planning and management;
- configuration identification;
- configuration change management;
- configuration status accounting;
- configuration verification and audit.

NASA endorses the same five functions and their principles [R31]. MIL-HDBK-61B is the DoD guidance companion; it is
guidance only [R2]. ISO 10007:2017 gives the same process in QMS terms, from concept to disposal [R3]. ESA projects apply
ECSS-M-ST-40C Rev.1, which includes a machine-readable technical data package (TDP) schema [R30]. llull maps each function
to a concrete capability (§8).

### 2.2 Who does it today, with which tools

| Organization type | Typical stack (public vendor docs) | Pain for a small team |
| ----------------- | ---------------------------------- | --------------------- |
| OEM / Tier 1 | CATIA + ENOVIA/3DEXPERIENCE, NX + Teamcenter, Creo + Windchill (revision.iteration A.1, lifecycle templates, serial/MSN effectivity [R25][R35]) | n/a (server PLM, admins) |
| Tier 2/3 machine shop, startup, university cubesat | SOLIDWORKS PDM (revision schemes per workflow state [R28]), Onshape release management (release candidates, revision schemes [R27]), or "folders + Excel" | Server licence/admin cost; FreeCAD has no maintained PDM (Ondsel Lens shut down Nov 2024 [R37]) |
| Space agency projects | ECSS-M-ST-40C TDP, configuration item data lists [R30] | Manual TDP assembly |

### 2.3 Real programmes: why it matters (sourced)

| Case | What happened | Lesson for llull | Source |
| ---- | ------------- | ---------------- | ------ |
| Airbus A380 wiring (2005–2006) | Harnesses designed in different CATIA versions (V4 vs V5) did not fit the fuselage. EADS put the wiring problem cost, including airline compensation, at **EUR 2.5 bn**, and the press reported a **USD 6.1 bn** operating-profit impact over four years. | One authoritative, version-controlled configuration across sites and tool versions. Record tool/kernel/schema version in each release. | [R32] |
| NASA Genesis sample-return capsule (2004) | Deceleration switches were installed per a drawing that had been drawn backwards. A heritage design was assumed correct without verification. | Release needs independent check (checker ≠ author), traceable approval, and a diff against the heritage revision. | [R33] |
| A&D PLM Action Group (Airbus, Boeing, Rolls-Royce…) | OEMs benchmarked PLM vendors on EBOM → MBOM transformation including engineering and manufacturing changes. | As-designed vs as-planned/as-built BOM and change propagation are core aerospace PLM needs. | [R34] |
| Airbus service bulletins | SB revisions add or remove aircraft by MSN from the effectivity. | Effectivity must be first-class data (serial, MSN, date), resolvable per unit. | [R36] |

### 2.4 Value for llull

- **Offline, file-based PLM for small aerospace teams.** No server needed: a local vault plus signed release packages,
  in the KI6 desktop direction.
- **Agent-native CM.** Every CM action is a command, so an AI agent can prepare an ECO, revise, re-run checks, assemble an
  FAI skeleton, and *propose* a release. Release stays a human signature (FR-PLM-17).
- **Provable integrity.** A deterministic replay (L8) plus a canonical SHA-256 plus Ed25519 means a released revision can be
  re-verified decades later, which supports LOTAR [R22] (gap 04).

## 3. Personas & user stories

| Persona | Role |
| ------- | ---- |
| **DE** Design engineer | Models parts, implements ECOs |
| **CK** Checker / stress | Independent review, approves for release |
| **CM** Configuration manager | Owns part numbering, baselines, status accounting |
| **QA** Quality engineer | AS9102 FAI, audits (AS9100D) |
| **MF** Manufacturing engineer | Consumes released data, MBOM, as-built records |
| **EC** Export-control officer | Classifies technical data (ITAR/EAR/EU) |
| **AG** AI agent (CLI local / MCP cloud) | Drafts changes, runs checks, prepares packages |

User stories:

- **US-01 (DE)** — I assign a part number and get revision A, iteration 1, so the title block and exports carry managed
  identity.
- **US-02 (DE)** — I checkpoint iterations while working, so I can return to any work-in-progress state.
- **US-03 (CK)** — I review a frozen iteration and approve or reject it. While it is in review nobody can edit it.
- **US-04 (CM)** — Once released, the model cannot be changed except through a change order and a new revision.
- **US-05 (DE)** — I raise an ECR with a reason, get an ECO with classification (minor/major) and effectivity, revise to B,
  and see a diff A→B.
- **US-06 (MF)** — Given a serial number, MSN or build date, I get the revision that applies.
- **US-07 (CM)** — I freeze a product baseline of an assembly and compare it later with the working state.
- **US-08 (QA)** — I get an AS9102 FAI skeleton with every characteristic numbered (balloons) consistently with the drawing.
  For a partial FAI, I get only the characteristics changed by the ECO.
- **US-09 (QA/CM)** — Years later I verify that an archived release package is unchanged and was signed by the stated
  approver.
- **US-10 (EC)** — I record the export-control decision for an item. Every sheet and package carries the marking, and
  release is blocked until a decision exists (when policy demands it).
- **US-11 (DE, desktop)** — Two engineers sharing a folder cannot overwrite each other: check-out locks the item.
- **US-12 (AG)** — Through `llull` CLI or MCP I can run the full ECO workflow up to "in_review". Releasing requires a human
  approval signature.
- **US-13 (MF)** — I record the as-built configuration of serial SN-0007, including a part installed under a variance, and
  compare it with the as-designed baseline.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Part identity (PN, name, type). Revision schemes (asme-alpha default, numeric, custom list). Iterations. Lifecycle state machine (in_work, in_review, released, superseded, obsolete, cancelled). Release lock guard. ECR/ECO with classification and disposition. revise_item. Serial/MSN/date effectivity + resolver. Canonical SHA-256 content hash. Release snapshot. `verify_release`. Revision diff. Title-block auto-sync. PLM status query. Audit of PLM commands. CLI/MCP parity. |
| **V1** | Ed25519 signatures (record + verify). Signed immutable release package (zip + manifest) on desktop. Local content-addressed vault with history, check-out/check-in locking. Baselines (functional/allocated/product) + compare. Multi-item assemblies (components as items) + EBOM with PN/rev. Export-control marking. Characteristic numbering + AS9102 skeleton (needs gap 03). Hash-chained audit log. |
| **V2** | MBOM / as-planned and as-built records per serial, variance/deviation (RFV) records. Shared PDM server mode (server/ multi-user, same commands). STEP AP242 PDM / PLCS export of configuration data [R29]. ECSS TDP export [R30]. LOTAR package integration (gap 04). QIF import of FAI results. |
| **Out of scope** | ERP/MRP (routings, costing, inventory). Supplier portal. Full QMS (NCR/CAPA workflow; only references are stored). Legal export classification (llull records the human decision and never decides). PKI/CA operation (keys come from the OS or an HSM/smart card through the host). 21 CFR Part 11 compliance claims (it is compared, not targeted, see §8). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source | VC |
| -- | --- | ----------- | --------- | ------ | -- |
| FR-PLM-01 | MUST | A document can declare a managed **item**: part number (unique within the document/vault), name, item type (part, assembly, drawing, document), revision scheme. | Configuration identification | [R1][R3] | VC-PLM-01 |
| FR-PLM-02 | MUST | Revisions follow a configurable scheme: `asme-alpha` (default: A…Y skipping I,O,Q,S,X,Z, then AA…, max 2 chars), `numeric-2` (01, 02…), or a custom ordered list. Changing the scheme never relabels past revisions. | Industry practice | [R26] (secondary), [R27] | VC-PLM-04 |
| FR-PLM-03 | MUST | Within a revision, **iterations** (A.1, A.2…) record work-in-progress checkpoints. A new revision restarts at iteration 1. | Revision vs iteration distinction | [R25] | VC-PLM-01 |
| FR-PLM-04 | MUST | Each revision has a lifecycle state in {in_work, in_review, released, superseded, obsolete, cancelled}. Only the transitions of `validation/lifecycle_transitions.csv` are allowed; others are refused with an explanatory summary. | Change control, status accounting | [R1][R3] | VC-PLM-02, VC-PLM-08 |
| FR-PLM-05 | MUST | While a revision is in_review, released, superseded or obsolete, every command that changes its **release scope** (the definition: entities, history, parameters, configurations, materials, components, constraints, drawings…) is refused. View state (camera, selection) stays editable. | Approved data must not drift | [R8] (only current approved data used) | VC-PLM-03 |
| FR-PLM-06 | MUST | `release_item` freezes the revision: canonical SHA-256 content hash, release snapshot (definition), releasedAt/by, approvals, change order, effectivity. | Configuration baseline / verification | [R1][R9] | VC-PLM-03, VC-PLM-16 |
| FR-PLM-07 | MUST | Release requires approvals that satisfy a document **policy**: required roles; checker ≠ author when `requireIndependentChecker`; a linked change order when `requireChangeOrder`. | Independent check (Genesis lesson) | [R33], [R11] | VC-PLM-08 |
| FR-PLM-08 | MUST | Change requests (ECR) record title, reason, affected items, proposed classification, author, date. Change orders (ECO) record source ECRs, classification (minor/major, plus optional acoustical/emissions tags), effectivity, disposition (in-stock, WIP, fielded), state (open, implemented, cancelled). Implementing an ECO produces a change notice id (ECN). | Change management | [R7][R10][R1] | VC-PLM-05 |
| FR-PLM-09 | MUST | The minor/major classification is a recorded **human decision** with justification text. llull may show the regulatory definition (21.93 / 21.A.91) but never auto-classifies. | Classification is the applicant's responsibility | [R7][R10] | VC-PLM-05 |
| FR-PLM-10 | MUST | `revise_item` creates the next revision (in_work, basedOn = current) only under an open ECO that lists the item (policy). The previous revision stays released and unchanged. | Revision control | [R25] | VC-PLM-05 |
| FR-PLM-11 | MUST | Releasing revision N+1 sets the previous released revision to superseded and **closes its effectivity** at the cut-in point (serial/MSN: from−1; date: the day before). | Effectivity continuity | [R35][R36] | VC-PLM-06 |
| FR-PLM-12 | MUST | Effectivity supports serial-number ranges, MSN ranges and date ranges (open-ended allowed). `resolve_effectivity(kind, unit)` returns the applicable released/superseded revision or none. | Effectivity | [R35][R36][R38] | VC-PLM-07 |
| FR-PLM-13 | MUST | `plm_diff(from, to)` reports, per category, what changed between two revisions or iterations: parameters, feature steps (added/removed/edited/suppressed), entities, materials, drawings/title block, effectivity, plus the volume/mass delta when a kernel is present. | Change impact, partial FAI | [R5] | VC-PLM-12 |
| FR-PLM-14 | MUST | Drawing title blocks of a managed item show the managed part number and revision automatically, and inconsistencies are flagged by `check_model`/`verify_release`. | One source of truth | [R6] | VC-PLM-03 |
| FR-PLM-15 | MUST | Loading a document whose release-scope content no longer matches the recorded hash of a released revision reports an **integrity mismatch** and keeps the revision locked. | Tamper evidence (AMC 21.A.5) | [R9] | VC-PLM-13 |
| FR-PLM-16 | MUST | `verify_release` recomputes the content hash from the release snapshot (and optionally regenerates geometry) and reports match/mismatch plus signature validity. | Configuration verification & audit | [R1] | VC-PLM-13 |
| FR-PLM-17 | MUST | An agent (MCP/CLI) can run every PLM command except producing an approval **signature**, which needs a human-held key through the host. Agent-initiated releases are refused when `policy.humanSignatureRequired` is set (default true). | Accountability | [R19] (signature meaning, compared) | VC-PLM-22 |
| FR-PLM-18 | MUST | Every PLM command is a registry command, so it is reachable from UI, `llull` CLI and MCP with identical behaviour (L1/L5). | llull law | AR1 | VC-PLM-22 |
| FR-PLM-19 | MUST | Every PLM mutation appears in the audit trail with actor, command, params hash, timestamp, and (V1) a hash chain linking entries. | Audit trail | [R9][R19] | VC-PLM-21 |
| FR-PLM-20 | SHOULD | Signatures: record an Ed25519 signature (public key, signer, meaning: authorship/review/approval, timestamp) over a canonical manifest. Invalid signatures are refused. Valid ones are verifiable offline. | Data integrity, non-repudiation | [R15][R18][R19] | VC-PLM-17 |
| FR-PLM-21 | SHOULD | Signed **release package**: an immutable folder/zip containing native definition (canonical JSON), drawings (SVG/PDF), neutral exports (STEP AP242 when gap 04 lands), a manifest with SHA-256 per member, and signatures. Re-verification works with llull or any SHA-256/Ed25519 tool. | Immutable release, LOTAR | [R22][R30] | VC-PLM-18 |
| FR-PLM-22 | SHOULD | Desktop **local vault**: content-addressed object store (SHA-256), item/revision refs, history, check-out/check-in with exclusive locks visible to other llull instances on the same folder or share. Works offline. | Offline PDM (KI6) | [R23][R24] | VC-PLM-23 |
| FR-PLM-23 | SHOULD | Baselines (functional, allocated, product, or custom) freeze a set of {item, revision, contentHash}. `compare_baselines` lists added/removed/changed members. Members must be released. | Baselines | [R1][R2] | VC-PLM-11 |
| FR-PLM-24 | SHOULD | Assemblies: components can be managed items. `engineering_bom` returns a multi-level EBOM with PN, revision, state, quantity. Releasing an assembly requires all children released. | EBOM | [R34] | VC-PLM-10 |
| FR-PLM-25 | SHOULD | Export-control marking per item: regime (ITAR / EAR / EU dual-use / national / none / undetermined), classification text entered by the user, notice text. It is printed on every sheet and package, and release is blocked while `undetermined` if policy demands. | ITAR technical data includes drawings [R12]; EAR technology [R14] | [R12][R13][R14] | VC-PLM-20 |
| FR-PLM-26 | SHOULD | Characteristic accountability: assign stable characteristic numbers (balloons) to every dimension, tolerance, GD&T frame and note on released sheets. Ids are stable across regeneration; only new characteristics get new numbers. | AS9102 Form 3 | [R5]; gap 03 | VC-PLM-15 |
| FR-PLM-27 | SHOULD | `fai_report_skeleton` produces AS9102 Forms 1–3 data (JSON/CSV) prefilled from PLM, EBOM, materials and characteristics, full or partial (characteristics changed since a baseline revision). Measured results are left empty. | AS9102 FAI | [R5] | VC-PLM-15 |
| FR-PLM-28 | COULD | As-built records per serial with deviations (part revision installed + authority such as a variance id) and a comparison against the as-designed baseline. | As-designed vs as-built | [R34][R2] | VC-PLM-14 |
| FR-PLM-29 | COULD | Export configuration data to STEP AP242 PDM (XML) per PDM-IF recommended practices, and an ECSS TDP manifest. | Interop | [R29][R30] | VC-PLM-24 |
| FR-PLM-30 | COULD | Each release records the tool provenance: llull version, kernel (OCC version), document schema version, plugin versions. This supports a tool assessment argument (§8.5). | Tool assessment, A380 lesson | [R20][R21][R32] | VC-PLM-18 |
| FR-PLM-31 | MUST | All PLM timestamps are supplied by the caller (host clock), never read inside commands. Re-executing a plan reproduces identical state. | Determinism (L3/L8) | llull law | VC-PLM-01 |
| FR-PLM-32 | MUST | Performance: lock checks add ≤ 1 ms per command. Release of a 10 MB document takes ≤ 1 s (hash + snapshot). Verifying a 50 MB release package takes ≤ 2 s on the reference desktop. | Usability | budget | VC-PLM-19 |

## 6. Workflows

### 6.1 UI (desktop, offline)

1. **Identify.** Item panel → "Make managed item" → enter PN, name, type. Revision A.1 appears in the status bar and the
   title block updates.
2. **Work.** Edit normally. "Checkpoint" (Ctrl+Shift+S) creates A.2 with a comment. The history panel shows iterations.
3. **Submit.** "Submit for review" freezes the model (lock icon, edit tools greyed with tooltip "LL-1001 A is in review").
4. **Review.** The checker opens the review view: diff vs the previous release, `check_model`, mass properties. "Approve
   & sign" uses the host keystore and needs a password/OS prompt. "Reject" requires a comment.
5. **Release.** Once approvals are complete, the CM clicks "Release". The dialog shows ECO, effectivity, marking and the
   package contents. On confirm, the package is written to the vault and the state becomes released.
6. **Change.** "New ECR" → "Create ECO" (classification with the 21.93 / 21.A.91 definition shown as help text, effectivity
   cut-in, disposition) → "Revise" makes B.1 in_work → edit → submit → release. A superseded with its range closed.
7. **Look up.** The effectivity bar takes "SN 0005" and highlights the revision B content.
8. **Desktop vault.** File > Check out (lock) / Check in (new iteration). The vault browser lists items, revisions, states,
   locks and the holder.

### 6.2 CLI (`llull`, local agent or CI)

```bash
llull --app plm_status                                   # item, revision.iteration, state, locks, open ECOs
llull --app exec create_change_request '{"id":"ECR-0002","title":"…","reason":"…","affectedItems":["LL-1001"],"at":"…","by":"u-21"}'
llull --app exec create_change_order  '{"id":"ECO-0002","fromRequests":["ECR-0002"],"classification":"minor","effectivity":[{"kind":"serial","from":5}],"at":"…","by":"u-7"}'
llull --app exec revise_item '{"changeOrder":"ECO-0002","at":"…","by":"u-7"}'
llull --app exec set_parameter '{"name":"t","expression":"5"}'
llull --app exec plm_diff '{"from":"A","to":"B"}'
llull --app exec submit_for_review '{"comment":"ECO-0002 implemented","at":"…","by":"u-7"}'
llull release verify ./vault/LL-1001/B/manifest.json      # NEW host-level sub-command: hashes + signatures, no document needed
llull --doc part.llull.json exec fai_report_skeleton '{"partNumber":"LL-1001","revision":"B","faiType":"partial","format":"csv"}' > fai.csv
```

`exec <command> '<json>'` is the existing one-command form (`run` takes a plan file). `release verify` and the `--at`/`--by` /
`--sign-with` flags are new CLI surface (TECHNICAL_SPEC §7). `--at`/`--by` default to the host clock and the configured user, so agents do not invent timestamps. Release from CLI
prompts for the signing key unless `--sign-with <keyref>` is given. It is refused in non-interactive agent mode when
`humanSignatureRequired`.

### 6.3 MCP agent (cloud)

1. The agent reads `plm_status`, then `resolve_effectivity`, then `plm_diff`.
2. It drafts ECR/ECO and implements the change (`revise_item` + model commands), and runs `check_model` and
   `mass_properties`.
3. It calls `submit_for_review`. The tool result says "awaiting human approval (signature required)".
4. A human approves in the UI. The agent can then call `verify_release` and `fai_report_skeleton`.

The `plm` toolset is exposed as a view (`@mcp/toolsets`). `release_item` and `record_signature` are annotated
`destructiveHint` (irreversible business event).

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-01 | a document without PLM data | `set_item_identity {partNumber:"LL-1001"}` | item LL-1001 rev A.1 in_work; featureHistory length unchanged | VC-PLM-01 |
| AC-02 | rev A in_review | `add_box` | refused, document unchanged, summary names item, revision and state | VC-PLM-02 |
| AC-03 | rev A in_review with checker approval by another user | `release_item` | released; contentHash = SHA-256(JCS(release scope)); title block revision "A" | VC-PLM-03 |
| AC-04 | sample_document.json as rev A content | release | contentHash = `7e3943fb…f3c24f` (vectors/hash_vectors.json) | VC-PLM-16 |
| AC-05 | rev A released | `set_parameter t=5` | refused | VC-PLM-03 |
| AC-06 | rev A released, ECO-0002 open listing LL-1001 | `revise_item` | rev B.1 in_work, basedOn A; A still released with an unchanged hash | VC-PLM-05 |
| AC-07 | B released under ECO-0002 effectivity serial ≥ 5 | `resolve_effectivity serial 4` / `5` | A / B | VC-PLM-06, VC-PLM-07 |
| AC-08 | rev A superseded | `set_lifecycle_state in_work` | refused (not an allowed transition) | VC-PLM-08 |
| AC-09 | released file edited outside llull | `load_document` | loads, reports "content hash mismatch", revision stays locked | VC-PLM-13 |
| AC-10 | manifest signed with RFC 8032 TEST 1 key | verify | true. Tampered revision A→B: false | VC-PLM-17 |
| AC-11 | baseline BL-PBL-0003 with LL-1003 C; LL-1003 revised to D | `compare_baselines` | one changed member LL-1003 C→D (in_work) | VC-PLM-11 |
| AC-12 | sheet with ballooned characteristics, ECO-0002 changed t | `fai_report_skeleton partial` | Form 3 lists only changed characteristics; results null | VC-PLM-15 |
| AC-13 | an MCP agent session | `release_item` with `humanSignatureRequired` | refused with "human approval signature required" | VC-PLM-22 |
| AC-14 | item marked `undetermined`, `policy.requireMarking` | `submit_for_review` | refused until marking is decided | VC-PLM-20 |
| AC-15 | two desktop instances on the same vault | B checks out an item that A holds | refused with the holder's name; A's check-in releases the lock | VC-PLM-23 |

## 8. Standards & regulatory alignment

### 8.1 Configuration management functions (EIA-649C / ISO 10007 / MIL-HDBK-61B)

| Function [R1][R3] | llull capability |
| ----------------- | ---------------- |
| CM planning & management | Document/vault **policy** object (schemes, required roles, change-order rule, marking rule) |
| Configuration identification | Item PN, revision scheme, iteration, item type, baselines (functional/allocated/product, MIL-HDBK-61B vocabulary [R2]) |
| Change management | ECR → ECO → revise → release; classification minor/major (≈ Class II/I per EIA-649-1 [R39]); disposition; ECN |
| Status accounting | `plm_status`, `engineering_bom`, `resolve_effectivity`, audit trail, revision history |
| Verification & audit | `verify_release`, integrity check on load, `compare_baselines`, as-built vs as-designed |

### 8.2 AS9100D / EN 9100 clause 8.1.2 and AS9102C

AS9100D has a configuration-management clause, 8.1.2, applied "as appropriate" [R4]. llull does not certify an
organization. It provides the controls an AS9100 QMS procedure can reference. AS9102C (2023) FAI uses Forms 1–3. Form 3
is ballooned characteristic accountability [R5]. llull targets the data side through FR-PLM-26/27 and the mapping in
`validation/as9102_field_mapping.csv`. Official field numbering must be checked against the purchased standard.

### 8.3 Airworthiness design data

- **FAA.** Type design content (21.31) [R6]. Change classification (21.93) [R7]. Design-data control in the production
  quality system (21.137(a)) [R8].
- **EASA.** 21.A.91 classification [R10]. DOA design assurance (21.A.239) [R11]. TC holder record-keeping (21.A.55) and
  AMC to 21.A.5: kept for the operational life, legible, protected against alteration and tampering, transferred with the
  certificate [R9].

llull's role is the data-integrity substrate: immutable signed releases, a canonical hash, an audit trail, and retrieval
through deterministic replay plus neutral formats (gap 04 LOTAR [R22]).

### 8.4 Electronic signatures: comparison with 21 CFR Part 11 (not a target)

Aviation has no Part-11-equivalent e-signature rule for design data in the sources reviewed. Part 11 is FDA. Its
manifestation rule (printed name, date/time, meaning; linkage, 11.50/11.70 [R19]) is still a good design checklist. llull
adopts name + time + meaning + cryptographic record linkage (Ed25519 over the canonical manifest) and does **not** claim
Part 11 compliance (no identity-proofing, password-policy or validation package).

### 8.5 Tool qualification (DO-330 / DO-254)

DO-330 and the DO-178C §12.2 criteria cover tools used in an **airborne software** life cycle, as recognized by
AC 20-115D [R20]. A mechanical CAD tool whose output (geometry, drawings) is independently verified by analysis,
inspection (FAI) and test does not fall under DO-330 qualification. DO-254 practice: every tool is assessed, but a tool
whose output is independently assessed needs no qualification [R21]. No source found requires mechanical CAD/PDM
qualification. That is an inference, recorded as an assumption (A-3) in §10.

llull therefore supports a **tool assessment** argument: provenance in each release (FR-PLM-30), deterministic replay,
and `verify_release` regeneration. If llull's codegen ever produced airborne software, DO-330 criteria would apply to
that path. That case is out of scope.

### 8.6 Export control

- **ITAR.** Technical data explicitly includes blueprints and drawings (22 CFR 120.33) [R12].
- **EAR.** "Technology" includes technical data such as blueprints (15 CFR 772.1) [R14].
- **Destination control statements.** Harmonized wording (ITAR 123.9(b), EAR 758.6) is required on commercial invoices for
  tangible exports. Marking electronic technical data is good practice, not a clear requirement [R13][R14].

llull records a human classification and prints the user's notice. It never determines jurisdiction or classification.

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Edits accepted on a released revision through any surface (UI/CLI/MCP) | 0 (guard coverage 100 % of mutating commands, contract test) |
| Hash reproducibility: same definition → same contentHash across OS, Python/JS, document reload | 100 % (VC-PLM-16 vectors) |
| Release packages verifiable by third-party tools (sha256sum + any RFC 8032 verifier) | 100 % |
| Time from ECR to released revision B in the S1 scenario via CLI | < 2 min wall-clock (agent + human approval excluded) |
| FAI Form 3 rows auto-filled (charNo, location, requirement) on a ballooned sample sheet | ≥ 90 % of characteristics |
| Command lock-check overhead | ≤ 1 ms p95 |

## 10. Risks & assumptions

| Id | Risk / assumption | Mitigation |
| -- | ----------------- | ---------- |
| R-1 | Canonicalization drift (number formatting, key order, Unicode normalization) changes hashes between versions | RFC 8785 [R16] restricted profile; golden vectors in CI (Python + JS); NFC is **not** applied (bytes as given) and documented |
| R-2 | Kernel upgrade changes regenerated geometry for a released revision | Release hash covers the *definition*, not the tessellation. Geometry fingerprint (volume, bbox, face count) stored and drift reported, never silently accepted |
| R-3 | Users treat llull as a certified PDM/QMS | Docs and UI state that llull provides controls, and organization procedures provide compliance |
| R-4 | Key management (lost keys, shared keys) | Keys live in the OS keystore or a smart card via the host. Public keys are registered per user in the vault. Revocation list in the vault (V1) |
| R-5 | File-share locking is unreliable (SMB/NFS) | Lock file with atomic create plus a lease and holder id. "Steal lock" needs CM role and is audited. Git-LFS-style server lock API in V2 [R23] |
| R-6 | Undo/redo vs irreversible release | Release is undoable only until persisted to the vault; after that the store refuses undo of the release step (S2-09) |
| A-1 | One llull document = one managed top item. Components may become sub-items (V1) | Revisit for multi-part documents |
| A-2 | AS9102 field names come from public supplier guides; numbering not verified | Verify with the purchased AS9102C before a production gate |
| A-3 | CAD tools do not need DO-330 qualification when outputs are independently verified (inference, §8.5) | Confirm with a DER/CVE on the first certification project |
| A-4 | Revision letter exclusions (I,O,Q,S,X,Z) come from secondary sources | Scheme configurable; default can change without data migration |

## 11. References

- [R1] SAE EIA-649C Configuration Management Standard — SAE International — https://saemobilus.sae.org/standards/eia649c-configuration-management-standard (accessed 2026-10)
- [R2] MIL-HDBK-61B Configuration Management Guidance (2020) — US DoD (EverySpec) — https://everyspec.com/MIL-HDBK/MIL-HDBK-0001-0099/MIL-HDBK-61B_56174/ (accessed 2026-10)
- [R3] ISO 10007:2017 Quality management — Guidelines for configuration management — ISO — https://www.iso.org/standard/70400.html (accessed 2026-10)
- [R4] AS9100D clause 8.1.2 (catalogue-level info) — Advisera 9100 Academy — https://advisera.com/9100academy/knowledgebase/list-of-mandatory-documents-in-as9100-rev-d/ (accessed 2026-10)
- [R5] AS9102C First Article Inspection — public supplier guides (GND, Lockheed Martin SQAG001, Ideagen) — https://gndctl.com/resources/how-to-fill-out-as9102-forms/ ; https://lockheedmartin.com/content/dam/lockheed-martin/uk/documents/suppliers/SQAG001.pdf (accessed 2026-10)
- [R6] 14 CFR 21.31 Type design — Cornell LII / eCFR — https://www.law.cornell.edu/cfr/text/14/21.31 (accessed 2026-10)
- [R7] 14 CFR 21.93 Classification of changes in type design — Cornell LII — https://www.law.cornell.edu/cfr/text/14/21.93 (accessed 2026-10)
- [R8] 14 CFR 21.137 Quality system — eCFR — https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-21/subpart-G/section-21.137 (accessed 2026-10)
- [R9] Regulation (EU) 748/2012 Part 21, 21.A.55; AMC/GM to Part 21 (AMC1 21.A.5) — EASA / UK CAA — https://www.easa.europa.eu/sites/default/files/dfu/amc_gm_to_part_21_-_issue_2_amendment_16.pdf (accessed 2026-10)
- [R10] Part 21 21.A.91 Classification of changes to a TC — UK CAA regulatory library — https://regulatorylibrary.caa.co.uk/748-2012/Content/Regs/01220_21A91_Classification_of_changes_to_a_type-certificate.htm (accessed 2026-10)
- [R11] Part 21 21.A.239 Design assurance system — UK CAA / EASA — https://regulatorylibrary.caa.co.uk/748-2012/Content/AMC%20GM%201/AMC%20ELA%20No%201%20to%2021%20A%20239%20a.htm (accessed 2026-10)
- [R12] 22 CFR 120.33 Technical data — Cornell LII — https://www.law.cornell.edu/cfr/text/22/120.33 (accessed 2026-10)
- [R13] ITAR 123.9(b) destination control statement — Aviation Suppliers Association — https://www.aviationsuppliers.org/ASA-Member-Bulletin---January-2017---Destination-Control-Statement (accessed 2026-10)
- [R14] EAR 15 CFR 772.1, 758.6 — BIS / Cornell LII — https://www.bis.gov/regulations/ear/772 ; https://www.law.cornell.edu/cfr/text/15/758.6 (accessed 2026-10)
- [R15] RFC 8032 EdDSA — IETF — https://www.rfc-editor.org/rfc/rfc8032 (accessed 2026-10)
- [R16] RFC 8785 JSON Canonicalization Scheme — IETF — https://www.rfc-editor.org/rfc/rfc8785 (accessed 2026-10)
- [R18] FIPS 186-5 Digital Signature Standard — NIST — https://csrc.nist.gov/publications/detail/fips/186/5/final (accessed 2026-10)
- [R19] 21 CFR 11.50 Signature manifestations — Cornell LII — https://www.law.cornell.edu/cfr/text/21/11.50 (accessed 2026-10)
- [R20] FAA AC 20-115D — FAA — https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_20-115D.pdf (accessed 2026-10)
- [R21] How do you qualify tools for DO-254 programs — Siemens EDA — https://resources.sw.siemens.com/en-US/white-paper-how-do-you-qualify-tools-for-do-254-programs (accessed 2026-10)
- [R22] EN 9300 LOTAR series — BSI / LOTAR International — https://lotar-international.org/wp-content/uploads/2020/05/PV_2015-11-05_LOTAR_Overview_V1.pdf (accessed 2026-10)
- [R23] Git LFS File Locking — git-lfs project — https://github.com/git-lfs/git-lfs/wiki/File-Locking (accessed 2026-10)
- [R24] Git hash-function-transition — Git project — https://git-scm.com/docs/hash-function-transition (accessed 2026-10)
- [R25] Windchill Part Version History — PTC — https://support.ptc.com/help/windchill/r13.0.0.0/en/Windchill_Help_Center/ccm_oview/CCMOviewPartHistoryVersions.html (accessed 2026-10)
- [R26] ASME Y14.35 revision letters (forum quotation of Y14.35M-1997) — Eng-Tips — https://www.eng-tips.com/viewthread.cfm?qid=34343 (accessed 2026-10)
- [R27] Onshape Release management — PTC Onshape — https://cad.onshape.com/help/Content/Plans/enterprise_settings_release_management.htm (accessed 2026-10)
- [R28] Pre-release vs post-release revision schemes in SOLIDWORKS PDM — CATI — https://www.cati.com/?p=157569 (accessed 2026-10)
- [R29] Recommended Practices AP242 XML Configuration Management v1.2 — MBx-IF / PDM-IF — https://www.mbx-if.org/home/wp-content/uploads/2024/06/rec_prac_ap242xml_config_mgmt_v1.2.pdf (accessed 2026-10)
- [R30] ECSS-M-ST-40C Rev.1 — ECSS / ESA — https://ecss.nl/standard/ecss-m-st-40c-rev-1-configuration-and-information-management/ (accessed 2026-10)
- [R31] NASA Systems Engineering Handbook §6.5 — NASA — https://www.nasa.gov/seh/6-5-configuration-management (accessed 2026-10)
- [R32] Airbus superjumbo mess not just tangled in wires — Seattle Times — https://archive.seattletimes.com/archive/20061226/airbus260/airbus-superjumbo-mess-not-just-tangled-in-wires (accessed 2026-10)
- [R33] Genesis mishap (drawings) — NBC News / NASA APPEL — https://www.nbcnews.com/id/wbna6255641 (accessed 2026-10)
- [R34] A&D PLM Action Group EBOM/MBOM benchmark — Aras — https://aras.com/en/blog/a-d-plm-action-group-initiates-ebom-mbom-benchmark (accessed 2026-10)
- [R35] Windchill A&D Managing Effectivity — PTC — https://support.ptc.com/help/wnc/r12.1.0.0/fr/Windchill_Help_Center/WADM/WADMAdminManagingEffectivityProps.html (accessed 2026-10)
- [R36] Airbus A310 service bulletin revision (MSN effectivity) — govdocs corpus — https://corpora.tika.apache.org/base/docs/govdocs1/936/936684.pdf (accessed 2026-10)
- [R37] Ondsel — https://ondsel.com/about/ (accessed 2026-10)
- [R38] STEP effectivity_item (AP242 EXPRESS) — STEP Tools — https://steptools.com/stds/stp_aim/html/t_effectivity_item.html (accessed 2026-10)
- [R39] Engineering Change Proposal — AcqNotes — https://acqnotes.com/acqnote/careerfields/engineering-change-proposal-ecp (accessed 2026-10)

Full verification notes per source: [validation/sources.md](validation/sources.md).
