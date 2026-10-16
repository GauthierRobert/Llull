# Gap 09 PLM — validation plan

This folder holds everything needed to validate a future implementation of
[FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC.md](../TECHNICAL_SPEC.md):

- scenario scripts with expected states;
- cryptographic test vectors (generated and independently re-verified);
- an AS9102 field-mapping table;
- a sample signed release package manifest;
- a draft `build_project` plan.

The proposed commands do not exist yet. Files that use them are **contracts** for the implementation.

## 1. Files

| File | Kind | Purpose | Proves |
| ---- | ---- | ------- | ------ |
| `generate_vectors.py` | generator (Python 3.9+, `cryptography`) | Rebuilds every file in `vectors/` and the sample manifest, deterministically. It asserts its own invariants (RFC 8032 re-derivation, hash invariance, negative signatures). | VC-PLM-04, 07, 16, 17 |
| `verify_vectors.mjs` | cross-check (Node ≥ 20, only `node:crypto`) | Recomputes canonical JSON, SHA-256 and Ed25519 verification in the JS runtime llull ships on (server/desktop). 22/22 PASS on Node v22.22.0 (negatives verified, not only listed). | VC-PLM-16, 17 |
| `sample_document.json` | input | Small llull v2 document envelope produced by llull itself (`build_project`: parameters w/t, `set_units`, `add_box` 60×40×t, `add_cylinder`, a configuration, a material → 4 feature steps, 2 entities) and serialized with `serializeDocument`; it loads with `load_document`. Used as release content of LL-1001 rev A. Values are illustrative and not engineering data. | VC-PLM-16 |
| `vectors/hash_vectors.json` | generated | SHA-256 known answers, canonicalization cases, release-scope hash of the sample, invariance and sensitivity cases | VC-PLM-16 |
| `vectors/ed25519_vectors.json` | generated | RFC 8032 §7.1 TEST 1–3 (re-verified), manifest signature (deterministic, TEST 1 key), 4 negative cases | VC-PLM-17 |
| `vectors/revision_sequence.json` | generated | `asme-alpha` and `numeric-2` sequences, iteration examples | VC-PLM-04 |
| `vectors/effectivity_resolution.json` | generated | Serial/MSN/date ranges after ECO-0002 and 12 resolution cases | VC-PLM-07 |
| `release_package_manifest.sample.json` | generated | Sample immutable release package manifest: members with SHA-256, document content hash, tool provenance, marking, Ed25519 signature | VC-PLM-17, 18 |
| `scenarios/S1_release_eco_revB.json` | scenario | Release A → ECR → ECO (serial effectivity ≥ 5) → revise B → edit → release B (A superseded) → resolve effectivity → verify | VC-PLM-01, 02, 03, 04, 05, 06, 07, 12 |
| `scenarios/S2_lifecycle_guards.json` | scenario | Illegal transitions, checker ≠ author, edit locks, view-state exemption, obsolescence, undo, tamper on load, bad signature | VC-PLM-02, 03, 08, 09, 13, 17 |
| `scenarios/S3_baseline_bom_fai.json` | scenario | Multi-item EBOM, product baseline + compare, as-built deviation, characteristic numbering, partial FAI skeleton | VC-PLM-10, 11, 14, 15 |
| `lifecycle_transitions.csv` | table | Allowed/refused state transitions with preconditions and side effects | VC-PLM-08 |
| `as9102_field_mapping.csv` | table | AS9102 Forms 1–3 fields (publicly described names) → llull data paths, auto-fill status | VC-PLM-15 |
| `plans/plm_release_eco_revB.plan.json` | draft plan | `build_project` actions reproducing S1 from an empty document, including title-block sync via `update_sheet` | VC-PLM-06, golden |
| `expected_results.json` | expected values | Value / tolerance / unit / source for every numeric or literal expectation | all |
| `sources.md` | sources | Every external source, access date, what was verified, and how (see its "How sources were verified") | — |

Regenerate and re-check:

```bash
cd docs/aerospace/09-plm-configuration-traceability/validation
python3 -I generate_vectors.py      # prints: ok: 444ca1de…f43a (manifest hash)
node verify_vectors.mjs             # 22 x PASS, exit 0
```

## 2. Real use cases (why these tests matter)

| Use case | Source | What the tests reproduce |
| -------- | ------ | ------------------------ |
| Airbus A380: harness design across CATIA V4/V5 sites did not fit. EADS reported EUR 2.5 bn wiring-problem cost incl. compensation. | [R32] | Tool provenance in each release manifest (`tool{}`), canonical content hash independent of tool round trips (VC-PLM-16, 18) |
| NASA Genesis: switches installed per a drawing drawn backwards; heritage design assumed. | [R33] | Independent checker enforced (S2-02), `plm_diff` against the heritage revision (S1 step 13), title block ↔ release consistency (VC-PLM-03) |
| Airbus SB revisions managing MSN effectivity | [R36] | MSN range resolution, cut-in closes the previous revision (VC-PLM-06/07) |
| A&D PLM Action Group EBOM→MBOM benchmark (Airbus, Boeing, Rolls-Royce) | [R34] | EBOM with PN/rev and as-built vs as-designed comparison (S3) |
| EASA AMC 21.A.5: records protected against alteration and tampering, kept for operational life | [R9] | Tamper detection on load (S2-10), signed immutable package verifiable without llull (VC-PLM-17/18), hash-chained audit (VC-PLM-21) |

## 3. Validation cases

Every case runs unattended as a CLI script (AF-23): `llull $D run <plan> --json` or `llull $D exec <command> '<json>' --json`
(`D="--doc v.llull.json"`; scenario steps are the same calls), then a comparison of `data` / `data.error.code` / exit code with
`expected_results.json`. Scenario steps run as a human caller unless stated; agent-caller cases say so. Only VC-PLM-18/23
(desktop host) and VC-PLM-24 (external checker) need more than the CLI.

Tolerances are exact unless stated. "Source" is (a) a cited standard/source, (b) a derivation, or (c) TBD with the measuring tool.

| VC | Title | Procedure | Expected | Source | FR / TR |
| -- | ----- | --------- | -------- | ------ | ------- |
| VC-PLM-01 | Identity, first revision, iterations | S1 steps 1–3 | A.1 in_work; checkpoint on a clean definition is a no-op (iterations stay 1; B reaches B.2 in S1 14); featureHistory length unchanged; re-running the plan yields identical `plm` | (b) scheme rule; L8 | FR-01, 03, 31; TR-02, 05, 32 |
| VC-PLM-02 | Review freeze / reject | S1 4–5, S2-03 | add_box refused in in_review; reject → in_work | (b) transition table | FR-04, 05 |
| VC-PLM-03 | Release freezes content and locks edits | S1 6–8, S2-04/05; contract test over `listCommands()` | contentHash = release-scope SHA-256; every mutating command refused or no scope change; camera edit allowed; title block shows rev A | [R8] intent; (b) | FR-05, 06, 14; TR-03, 04, 17, 18, 30 |
| VC-PLM-04 | Revision schemes | `vectors/revision_sequence.json` | 9 → J, 14 → P, 20 → Y, 21 → AA, 420 → YY; numeric 10 → "10" | (b) from the [R26] rule (secondary), configurable | FR-02 |
| VC-PLM-05 | ECR → ECO → revise | S1 9–12, S2-06 | ECR accepted, ECO open, B.1 in_work basedOn A; A unchanged (deep-equal); revise without ECO refused | [R1] change mgmt; [R7][R10] classification recorded, never inferred | FR-08, 09, 10 |
| VC-PLM-06 | Release B supersedes A, effectivity closed | S1 14–15 | A superseded with serial 1–4; B released serial ≥ 5; ECO-0002 implemented, ECN-0002 | (b) | FR-11 |
| VC-PLM-07 | Effectivity resolution | `vectors/effectivity_resolution.json` (12 cases) + S1 16–17 | serial 4 → A, 5 → B; MSN 11 → A, 12 → B; date 2026-11-01 → null, 2027-03-01 → B | (b); concept [R35][R36] | FR-12 |
| VC-PLM-08 | Illegal transitions & approval policy | `lifecycle_transitions.csv` rows with allowed=no; S2-01/02/07 | refused, document unchanged, summary names the rule | (b) | FR-04, 07 |
| VC-PLM-09 | Obsolescence | S2-08 | B obsolete, hash unchanged, serial 99 resolves to null | (b) | FR-04 |
| VC-PLM-10 | EBOM | S3 step 1 | 3 rows, total quantity 5, 0 unreleased children | (b) | FR-24 |
| VC-PLM-11 | Baseline & compare | S3 2–3 | 4 members incl. root; LL-1003 C→D reported; baseline with in_work member refused | [R2] baseline vocabulary; (b) | FR-23 |
| VC-PLM-12 | Revision diff | S1 13 | parameters changed `t: 4 → 5`, 0 feature steps added | (b) | FR-13 |
| VC-PLM-13 | Integrity & verification | S2-09/10/11, S1 18 | tampered file → mismatch reported, still locked; `verify_release` true on an untouched revision; undo blocked after persistence | [R9] tamper protection | FR-15, 16; TR-33 |
| VC-PLM-14 | As-built vs as-designed | S3 4 | one difference LL-1003 C (designed) vs B (built) with authority RFV-0012 | (b) | FR-28 |
| VC-PLM-15 | Characteristic accountability & FAI skeleton | S3 5–6 + `as9102_field_mapping.csv` | balloons stable across regenerate; partial FAI lists only ECO-changed characteristics; results null; Form 1 PN/rev filled | [R5] (secondary for field names) | FR-26, 27 |
| VC-PLM-16 | Canonical hash | `vectors/hash_vectors.json` in Python and JS | SHA-256("abc") = `ba7816bf…f20015ad`; sample scope `7e3943fb…f3c24f` (1551 B); after camera/selection/key-order change: same; after t = 5: `c913cadc…91017e` | [R17] (a); (b) | FR-06; TR-06, 17 |
| VC-PLM-17 | Ed25519 signatures | `vectors/ed25519_vectors.json`; S2-12 | RFC 8032 TEST 1–3 verify; manifest signature `78343a41…1b5f460c` verifies; 4 negatives fail; `record_signature` with bit-flipped signature refused; test keys refused by the production trust store | [R15] (a), [R18] | FR-20; TR-07, 19 |
| VC-PLM-18 | Release package | write package for S1 rev A; verify with `sha256sum` + `verify_vectors.mjs`-style verifier; flip one byte | all members match the manifest; flipped byte → member mismatch; manifest `documentContentHash` = revision contentHash; tool provenance present | (b); [R22] intent | FR-21, 30 |
| VC-PLM-19 | Performance | `tests/perf/plm.bench.ts` | guard ≤ 1 ms p95; release 10 MB ≤ 1 s; package verify 50 MB ≤ 2 s | (c) TBD, measure with vitest bench on the reference desktop | FR-32 |
| VC-PLM-20 | Export marking | S1 step 2 variant with `regime:'undetermined'` + `requireMarking` | submit refused; with a regime set, the statement appears in sheet SVG and manifest `marking` | [R12][R14] (data types); decision is human | FR-25 |
| VC-PLM-21 | Audit chain | run S1 through the server; edit one audit line | `llull audit verify` passes on the original, fails at the edited line; rotation keeps the chain | [R9] | FR-19 |
| VC-PLM-22 | Surface parity & agent gate | run S1 via CLI (`llull --doc v.llull.json run plans/plm_release_eco_revB.plan.json --json`, human caller) and via MCP; compare final `plm` (id-normalized); agent `release_item` | identical state; agent release refused with "human approval signature required"; `toToolSchemas()` snapshot lists plm tools | llull L1/L5 | FR-17, 18; TR-15, 16 |
| VC-PLM-23 | Vault locks | two desktop sessions on one vault folder | second check-out refused naming the holder; lease expiry + audited break | [R23] (lock semantics reference) | FR-22 |
| VC-PLM-24 | Neutral PDM export (V2) | AP242 XML configuration export of S3 baseline | passes PDM-IF recommended-practice checks | (c) TBD, measure with the PDM-IF/CAx-IF validation tools [R29] | FR-29 |
| VC-PLM-25 | Stable codes + remediation | `llull $D exec create_change_order '{"id":"ECO-9","fromRequests":["ECR-404"]}' --json`; `exec set_item_identity '{"partNumber":"bad pn!","name":"x","itemType":"part"}'`; `exec revise_item '{}'` on a released rev without ECO; S2-01/02/04/06/12 | codes `PLM_ECO_UNKNOWN`, `PLM_PN_INVALID`, `PLM_ECO_REQUIRED`, `PLM_STATE_TRANSITION`, `PLM_CHECKER_IS_AUTHOR`, `PLM_LOCKED`, `PLM_SIGNATURE_INVALID`; each with ids/paths and remediation; exit 1 | TECHNICAL_SPEC §7.2 | FR-33; TR-14 (AF-11) |
| VC-PLM-26 | Human gate (agent caller) | S1 replayed with caller = agent; S2-13 | identity → `submit_for_review` succeed; `record_approval`, approval `record_signature`, classification on `create_change_order`, `release_item` refused with `PLM_HUMAN_GATE`, document unchanged; `plm_status.data.nextHumanAction` names the roles | AF-34 | FR-17; TR-16 (AF-34) |
| VC-PLM-27 | Readiness check, review & unverified propagation | `check_release_readiness --json` on rev A in_review with one unaccepted gap-03 PMI item and an `unverified` material; then human `release_item` (S2-14) | `status` "fail"; findings `PLM_REVIEW_PENDING` (PMI id) + warning `PLM_UNVERIFIED_INPUT`; release refused `PLM_REVIEW_PENDING`; after review accepted, release succeeds and manifest `unverified[]` lists the material; `plm_status.data.policy.humanSignatureRequired.defaulted` true | AF-20, AF-31, AF-32, AF-33 | FR-34, 35, 36 |

## 4. Scenario runner contract (for the implementer)

- `start.document` is loaded with `load_document`. Each `step.command` / `params` goes through `execute()` (or the CLI for
  VC-PLM-22).
- Keys in `expect` are dotted paths into the resulting document (`plm.item.revisions.A.state`) or into the command result
  (`data.*`, `summaryContains`, `summaryMatches` (regex), `refused`, `documentUnchanged` (deep-equal with the previous
  document), `readOnly` (affected = [], document identity unchanged)).
- `...Unchanged`, `...DiffersFrom` and `...Equals` keys compare against earlier values in the same run.
- Notes and non-machine expectations (`note`) are documentation and are skipped by the runner.

## 5. What is NOT validated here (and why)

- AS9102C official form layout and field numbers: paywalled. The mapping uses publicly described field names (sources.md R5).
- Legal correctness of any export classification: human decision by design.
- DO-330 tool qualification: not applicable to mechanical CAD in the sources reviewed (FUNCTIONAL_SPEC §8.5). VC-PLM-18
  covers the provenance that a tool assessment would rely on.
- No real public CAD/PLM test file was pinned. No openly licensed AS9102 or PLM exchange sample was reachable from this
  session (network restricted to package registries, see sources.md). The vectors here are generated and fully
  reproducible. RFC 8032 vectors come from the pinned PyPI wheel `cryptography_vectors` 44.0.0 (sha256 `458ed682…d5d7`),
  which is not stored (36.8 MB).
