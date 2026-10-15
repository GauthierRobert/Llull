# Gap 08 MAT — Validation pack

How to prove that a future implementation of aerospace materials and standard parts is correct. All external
facts come from [sources.md](sources.md) (S-ids). All derived numbers come from
[generate_mat_reference.py](generate_mat_reference.py), whose output is
[expected_results.json](expected_results.json).

## Files

| File | What it is | Status |
| ---- | ---------- | ------ |
| `sources.md` | Every external source with URL, access date 2026-10-15, what was verified and its grade. Ends with a list of what could **not** be verified. | complete |
| `materials_dataset.json` | 10 material entries in the draft library schema. Each value carries `source`, `basis` and `status` (`verified` / `secondary_unconfirmed` / `tbd`). Verified values exist for 2024-T3, 7075-T6 and Ti-6Al-4V (densities, moduli, ν, typical strengths). 7075-T7351, 6061-T6, 7050-T7451, 4130, 15-5PH, 718 and A-286 are identification-only stubs with `tbd` values (see "Known gaps"). It also holds fastener material minima (NAS6203 160/95 ksi, Hi-Lok 95 ksi). | partial |
| `fastener_catalog_sample.json` | Draft catalogue: NAS6203-6220 (grip/length rule plus 6 published checkpoints), MS20470 (AD3–AD6 shank, head min/max for AD4–AD6), Hi-Lok HL10/11/18/19 grammar plus the HL19-8-10 checkpoint, AN grammar (length code unresolved), MS21042L3, NAS1149 thickness set, and AC 43.13-1B installation rules. Licence notes are included. | draft |
| `generate_mat_reference.py` | Pure-stdlib generator. `python3 generate_mat_reference.py` writes the expected JSON; `--check` fails if the JSON is stale. It uses only `verified` inputs (it asserts this). | complete |
| `expected_results.json` | Derived expectations: unit conversions, mass properties, catalogue checkpoints, bolt grip selection, Hi-Lok grip, rivet selection. Each has value, tolerance and derivation. | generated |
| `plans/mass_7075_block_current.json` | `build_project` plan that runs on **today's** llull (create_material → add_box → assign_material → mass_properties). Expected mass 140.5 g. | runnable now |
| `plans/mass_ti_cylinder_proposed.json` | Draft plan using the proposed `load_material_library` / `set_material_property` with a lb/in³ density in a mm document. Expected mass 69.56719 g. | proposed commands |
| `plans/fastener_stack_nas6203_proposed.json` | Draft plan: two plates (0.25 + 0.26 in) → `select_fastener` → `insert_fastener_stack` → `bill_of_materials`. | proposed commands |

No public test *files* (STEP, PDF) are stored. MIL-HDBK-5J (about 70 MB, public, cancelled) must be pinned by
URL plus sha256 once it can be downloaded (the authoring sandbox was blocked). It goes in
`sources.lock.json` (TR-MAT-41) and is not committed. NAS/MS/Hi-Lok sheets are not stored because of
licensing (FUNCTIONAL_SPEC §8.3).

## Real use cases

| # | Use case | Public basis | What llull must do | VC |
| - | -------- | ------------ | ------------------ | -- |
| U1 | Transport-category fitting: single-load-path, so A-basis is required | 14 CFR 25.613 (99 %/95 %) [S1]; AC 25.613-1 accepts MIL-HDBK-5 A/B [S2] | Refuse to return B or S when A is requested; mark the source edition | VC-MAT-05 |
| U2 | Fail-safe skin panel: B-basis allowed | 14 CFR 25.613 (90 %/95 %) [S1] | Return B with basis and locator | VC-MAT-05 |
| U3 | MMPDS edition change: re-check margins | Reported 7075-T6 Fbru change 156 → 146 ksi between MMPDS-04 and -05 [S14] (secondary) | Diff two library versions and list affected parts | VC-MAT-13 |
| U4 | Weight statement for a machined Ti fitting | Supplier densities differ: 0.160 vs 0.163 lb/in³ [S15] | Keep both values with provenance, use the preferred one, report the source | VC-MAT-02, VC-MAT-04 |
| U5 | Joint design: bolted splice with NAS6203/6204 + MS21042 + NAS1149 | AC 43.13-1B grip/washer/protrusion rules [S6]; NAS620x thread lengths [S22] | Select the grip dash and shim, check protrusion, insert the stack, list it in the BOM | VC-MAT-07, VC-MAT-10, VC-MAT-11 |
| U6 | Riveted repair (MRO) per AC 43.13-1B | Edge 2 D, pitch 3 D [S7]; length = grip + 1.5 D [S19] | Select MS20470 length, check row layout | VC-MAT-09, VC-MAT-12 |
| U7 | Hi-Lok installation in a wing box | HL grammar, HL19-8-10 grip range [S26] | Select the pin by maximum-grip range | VC-MAT-08 |
| U8 | Airframe scale: 10⁵–10⁶ fasteners | 747-400 ≈ 6 M parts, half fasteners (secondary) [S32] | Performance budget for instances and BOM | VC-MAT-17 |

## Validation cases

Tolerances: "rel" = relative error. Unless stated, expected values are in `expected_results.json` under the
VC id prefix.

| VC | Proves | Setup | Expected | Tol | Source / derivation |
| -- | ------ | ----- | -------- | --- | ------------------- |
| VC-MAT-01 | FR-MAT-23, TR-MAT-14, TR-MAT-10 | Load a v2 document with legacy material `{steel, density 0.00785}` assigned to a 10×10×10 mm box | Mass 7.85 g, unchanged from today. Record shows basis `unspecified`, provenance `legacy`. Re-save produces v3 and preserves the material. | rel 1e-12 | V = 1000 mm³ × 0.00785 g/mm³ (analytic) |
| VC-MAT-02 | FR-MAT-04, TR-MAT-11 | Ti-6Al-4V record with density 0.160 (S15, Rolled Alloys) and 0.163 (S15, other supplier). Mark 0.160 preferred. | `mass_properties` reports `densitySource` = the 0.160 entry and both values are listed by `get_material`. Marking 0.163 preferred as well is refused (one preferred per key). | exact | sources.md S15 |
| VC-MAT-03 | FR-MAT-02, TR-MAT-01 | Convert 0.100, 0.101 and 0.160 lb/in³ | 2.76799, 2.79567, 4.42878 g/cm³ (rounded here; 12 significant digits in the JSON) | rel 1e-9 | `unitConversion[]`; exact constants |
| VC-MAT-04 | FR-MAT-05, TR-MAT-02 | (a) box 100×50×10 mm, 7075-T6 2.81 g/cm³; (b) same box at 0.101 lb/in³; (c) cylinder r10 h50 mm, Ti 0.160 lb/in³; (d) plate 100×100×5 mm with Ø10 hole, 2024-T3 2.78 g/cm³; (e) inch document box 2×1×0.25 in at 0.101 lb/in³ | (a) 140.5 g (b) 139.7835 g (c) 69.56719 g (d) 137.9083 g (e) 0.0505 lb = 22.90641 g | rel 1e-6 exact/closed-form; 5e-3 mesh | `massProperties[]` |
| VC-MAT-05 | FR-MAT-06, FR-MAT-03, TR-MAT-12 | Record with Ftu at basis S only. Query A, then B, then S. Repeat with `forCertification:true` on a `superseded` record. | A and B: `available:false` with candidate list [S value]. S: the value. forCertification: refused with reason "superseded source". | exact | 14 CFR 25.613 [S1]; MMPDS definitions [S3] |
| VC-MAT-06 | FR-MAT-11, TR-MAT-20 | Evaluate the NAS6203-6220 length rule for the 6 published part numbers | grip/length within 0.001 in of published: NAS6203-33 2.062/2.385; NAS6204-33 2.062/2.432; NAS6204-10 0.625/0.995; NAS6205-33 2.062/2.500; NAS6205-10 0.625/1.063; NAS6206-33 2.062/2.516 | abs 0.001 in | `catalogCheckpoints[]`; S22. Note: the distributor truncates grip 2.0625 to 2.062 and computes length from the truncated value. |
| VC-MAT-07 | FR-MAT-12, FR-MAT-13, TR-MAT-21 | `select_fastener` NAS6203–6206 for 10 stacks (0.020–3.000 in) with MS21042L3 / NAS1149 | e.g. t = 0.510 → NAS6203-9, washer [0.063], length 0.885, protrusion 0.124 ≥ 1/32 → ok. t = 0.300 → NAS6204-5 + [0.016]. t = 3.000 → fail (beyond the fixture grip range). t = 0.020 → NAS6206-1 is **fixture-only** (grip dash range [1, 40] is a test fixture; whether a -1 grip exists is TBD from the NAS sheet). Protrusion uses the length rounded to 0.001 in and one thread pitch beyond the nut maximum height (llull choices, TECHNICAL_SPEC §5.2 step 5). Full table in JSON. | exact (sixteenths) | `boltGripSelection[]`; AC 43.13-1B 7-37 [S6]; thread lengths S22; nut height S25 |
| VC-MAT-08 | FR-MAT-12, TR-MAT-21 | Hi-Lok HL19, 1/4 in and 3/16 in, 5 stacks including exact boundaries | 0.600 → HL19-8-10 (.5625–.625). 0.5625 → HL19-8-9. 0.5626 → HL19-8-10. 0.250 → HL19-6-4. 0.251 → HL19-6-5. | exact | `hiLokGripSelection[]`; S26 (HL19-8-10 range) |
| VC-MAT-09 | FR-MAT-14, TR-MAT-21 | MS20470AD3–AD6, 6 stacks | e.g. AD4, t = 0.125 → MS20470AD4-5 (L = 0.3125). AD4, t = 0.080 → AD4-5 (raw 0.2675, round up). Edge ≥ 0.25 in, pitch ≥ 0.375 in. | exact | `rivetSelection[]`; S7, S19 |
| VC-MAT-10 | FR-MAT-15, TR-MAT-22 | Run `plans/fastener_stack_nas6203_proposed.json` on OCC | 1 FeatureStep for the insert. Plate volumes each reduced by π·(d_hole/2)²·t (d_hole from the catalogue, TBD; test with user-supplied d = 0.190 in). Instances: NAS6203-9 ×1, NAS1149 0.063 ×1, MS21042L3 ×1. Undo restores a deep-equal document. Replay is id-stable. | volume rel 1e-6 | analytic; golden replay |
| VC-MAT-11 | FR-MAT-16, TR-MAT-23 | Same model with 2 stacks plus materials assigned to the plates | `standardParts`: NAS6203-9 ×2, MS21042L3 ×2, NAS1149(.063) ×2. `materials`: one row per material with total mass = Σ VC-MAT-04 style volume × density. Legacy `rows` unchanged. | exact counts; mass rel 1e-6 | derivation |
| VC-MAT-12 | FR-MAT-18, TR-MAT-25 | `insert_fastener_row` MS20470AD4 at pitch 0.30 in (< 3 D = 0.375) and edge 0.20 in (< 2 D = 0.25) | No-op with 2 reasons citing 3 D / 2 D. With `allowViolations:true`: inserted with 2 warnings. | exact | S7 |
| VC-MAT-13 | FR-MAT-24, TR-MAT-15 | Library v1 (Fbru 156 ksi) vs v2 (146 ksi) for a synthetic 7075-T6 key | diff lists 1 changed value old 156 → new 146 with both provenances | exact | Synthetic fixture modelled on S14 (not real data) |
| VC-MAT-14 | FR-MAT-08, FR-MAT-21, TR-MAT-31, TR-MAT-16 | Import a `licensed-no-redistribution`, `storage:'private'` library with a unique sentinel value (e.g. 123.456789). Assign it, save, snapshot, export_code, live-sync log. | The sentinel appears in none of the outputs. The document carries only `{libraryId, version, sha256}`. Reload with the provider gives the same mass; without the provider, the record stays `unresolved` with the saved sha256 and `mass_properties` returns `available:false` (no number). A provider with a different sha256 also leaves it unresolved (`hash mismatch`). | exact (string search) | fuzz test |
| VC-MAT-15 | FR-MAT-09, TR-MAT-30, TR-MAT-32 | Record marked ITAR; call `export_step_exact` via (a) desktop CLI and (b) cloud MCP | (a) result requires `confirmExportControlled:true`, summary names the marking. (b) refused. Unmarked document: unaffected. | exact | 22 CFR 120.34 [S28], 15 CFR 734.7 [S29] (policy, not legal advice) |
| VC-MAT-16 | FR-MAT-07, TR-MAT-13 | Synthetic temperature table (percentOfRT: 70 °F 100 %, 300 °F 80 %, 500 °F 50 %) on an RT value of 60 ksi | 400 °F → 65 % → 39 ksi; 600 °F → `available:false` (no extrapolation) | rel 1e-12 | linear interpolation (synthetic; real MIL-HDBK-5 curve points TBD, Fig. 3.2.3.1.1(a) [S9]) |
| VC-MAT-17 | FR-MAT-15/16 performance | 10⁴ instances of 3 part numbers | BOM ≤ 1 s, mass ≤ 1 s, file growth ≤ 1 KB per instance | budget | TECHNICAL_SPEC §8 |
| VC-MAT-18 | FR-MAT-10, TR-MAT-40/41 | CI check over the seed library | Every value has `basis`, a `sourceId` present in `sources.lock.json` with sha256, and a locator. `superseded` is set. | exact | policy |
| VC-MAT-19 | FR-MAT-17, TR-MAT-24 | Generate MS20470AD4 geometry | Head Ø within [0.238, 0.262] in, head h within [0.054, 0.064] in. NAS620x head (dims unknown) is `representative` and excluded from mass. | range | S24 |
| VC-MAT-21 | FR-MAT-20 (V2) | `joint_capacity` on one NAS6204 stack in two sheets, with fastener Fsu and sheet Fbru records at (i) basis A + A, (ii) A + B, (iii) B + S | (i) basis A, (ii) basis B, (iii) basis `mixed` with the per-input list (TECHNICAL_SPEC §5.6). Capacity values **TBD** — needs verified Fsu/Fbru allowables (seed library, M4); until then only the basis propagation is asserted. | exact (basis); TBD (values) | TECHNICAL_SPEC §5.6 |
| VC-MAT-20 | FR-MAT-19, FR-MAT-22, TR-MAT-26 | Import a user catalogue for a new family (synthetic "ACME-100") without code change. Gap 06 imports a composite record through the same envelope. | Decode, select and BOM work. The composite record validates with basis B and CMH-17 provenance. | exact | — |

### FR → VC coverage

| FR | VC |
| -- | -- |
| FR-MAT-01 | VC-MAT-02, VC-MAT-18 |
| FR-MAT-02 | VC-MAT-03, VC-MAT-04 |
| FR-MAT-03 | VC-MAT-05 |
| FR-MAT-04 | VC-MAT-02, VC-MAT-13, VC-MAT-18 |
| FR-MAT-05 | VC-MAT-04 |
| FR-MAT-06 | VC-MAT-05 |
| FR-MAT-07 | VC-MAT-16 |
| FR-MAT-08 | VC-MAT-14 |
| FR-MAT-09 | VC-MAT-15 |
| FR-MAT-10 | VC-MAT-18 |
| FR-MAT-11 | VC-MAT-06 |
| FR-MAT-12 | VC-MAT-07, VC-MAT-08 |
| FR-MAT-13 | VC-MAT-07 |
| FR-MAT-14 | VC-MAT-09 |
| FR-MAT-15 | VC-MAT-10, VC-MAT-17 |
| FR-MAT-16 | VC-MAT-11, VC-MAT-17 |
| FR-MAT-17 | VC-MAT-19 |
| FR-MAT-18 | VC-MAT-12 |
| FR-MAT-19 | VC-MAT-20 |
| FR-MAT-20 | VC-MAT-21 (V2 placeholder: basis propagation now, capacity values TBD) |
| FR-MAT-21 | VC-MAT-10 (replay), VC-MAT-14 |
| FR-MAT-22 | VC-MAT-20 |
| FR-MAT-23 | VC-MAT-01 |
| FR-MAT-24 | VC-MAT-13 |

## Running

```bash
cd docs/aerospace/08-materials-standards-libraries/validation
python3 generate_mat_reference.py --check    # expected_results.json is fresh
# today (no new commands needed):
node server/bin/llull.cjs run docs/aerospace/08-materials-standards-libraries/validation/plans/mass_7075_block_current.json --doc /tmp/mat.llull.json --dry-run --json
# expect the last step's data.mass = 140.5 (g)
```

The `*_proposed.json` plans use commands that do not exist yet. They are the acceptance fixtures for
M2/M5/M6 (TECHNICAL_SPEC §10).

## Known gaps in this pack (honest status)

1. **MIL-HDBK-5J design allowables are not in the dataset.** The primary PDF could not be fetched (DNS and
   proxy blocks), and the session's web-search budget ran out. Before M4, a human or agent with access must
   read Tables 3.2.3.0(b1) (2024), the 7075 tables, and the chapter 5 (Ti-6Al-4V) and chapter 2 (4130, 15-5PH)
   tables. Fill `materials_dataset.json` values with `status: verified` and locators, then regenerate.
2. Seven of the ten materials are stubs (identification only).
3. Temperature curves are not digitised. VC-MAT-16 uses a synthetic table.
4. Fastener dimensions are incomplete: NAS620x head, NAS1149 ID/OD, MS21042 beyond L3, MS20470AD3 head, hole
   diameters. These must be imported from licensed sheets by the user, or legally cleared distributor data.
5. Rivet length and shop-head rules come from secondary sources (S19). Confirm the AC 43.13-1B wording
   (Chapter 4) before release.
6. The AN dash-number meaning is unresolved (OQ-MAT-05). AN is excluded from the selection tests.
