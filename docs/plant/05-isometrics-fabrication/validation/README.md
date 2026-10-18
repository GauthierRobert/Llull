# Gap 05 ISO — Validation pack

This pack proves that llull's isometric and fabrication commands are right: PCF read / write, weld and spool
derivation, cut lists, bills of material, the isometric projection and its dimensions, slope annotation, sheet
splitting and orthographic piping GA annotation. Every reference value is either arithmetic on a fixture whose
coordinates are given (closed form), a closed form of projection geometry with a cited source, a sourced rule (graded
A/B/C in [sources.md](sources.md)), or `TBD — measure`. **No expected value was produced by running llull** (the
commands do not exist yet). The reference values were computed by `data/pcf_reference_parse.py` (Python stdlib,
`python3 -I`), an independent implementation that the TypeScript code is compared against.

How the cases will run (AF-23):

- Unit tests in `tests/unit/plant/fabrication/*.test.ts` read `data/iso-01-L101-dn100.pcf` and
  `data/iso-01-L101-dn100.expected.json` directly.
- `server/tests/packReplay05.test.ts` runs every plan in `plans/` through `build_project`, the same path as
  `llull run plan.json --json`, and compares the `expected` rows (value, tolerance) of each plan.
- `tests/golden/plant_iso_l101.json` pins the exported PCF and SVG hashes (determinism, VC-ISO-17).

## Gate policy

Only **grade A** rules, closed forms and fixture arithmetic gate pass / fail. Grade B rules (for example the
field-fit allowance applied to each adjoining cut, the column-5 indent, sheet `1A` stability) define llull's documented
behaviour and are tested as llull rules, not as claims about ISOGEN. Grade C values are never used. Codes and the
weld-numbering order are llull definitions (spec), tested for stability, not against an external value.

The pack's PCF fixture is **authored**: no public sample PCF could be downloaded (sources.md). Its syntax follows the
records confirmed by two or more sources (`data/pcf_keywords.json`, grade A rows). Checking it against a licensed
ISOGEN or Plant 3D `PLANTPCFTOISO` is open question OQ-ISO-01; until then "accepted by ISOGEN" is not claimed.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/iso-01-L101-dn100.pcf` | authored PCF, line L-101 DN100: 3 weld-neck flanges, 7 pipes, 3 LR elbows, 1 equal tee with a vertical branch, 1 site weld (SKEY WS); MATERIALS section | fixture (closed form) |
| `data/iso-01-L101-dn100.expected.json` | reference script output: counts, pipe lengths, 13 welds with numbers, 2 spools, cut list, BOM, round-trip flags, iso axes | closed form |
| `data/pcf_reference_parse.py` | stdlib reference parser, canonical writer, analyser (`--weld-gap`, `--field-fit-allowance`) | — |
| `data/pcf_keywords.json` | PCF syntax rules, header and pipeline keywords, component types with their points, end-connection codes, attributes, CAESAR II attribute map | A / B per row |
| `data/skey_catalogue.json` | SKEYs used by the MVP (ELBW, TEBW, FLWN, WW / WS / WF …) and the unconfirmed ones | A / B / C per row |
| `data/iso_drawing_conventions.json` | isometric projection closed forms, llull `iso` frame derivation, 13 drawing conventions, ISO 6412-1 / -2 catalogue facts | A / B per row |
| `expected_results.json` | index of every VC: inputs, expected value, tolerance, source, FR / TR, test file | — |
| `plans/sc-iso-0*.json` | CLI scenarios (`build_project` actions + `expected` rows); `unbuilt` lists the commands they need | — |

## Fixture geometry (data/iso-01-L101-dn100.pcf)

```
plant axes: +X east, +Y north, +Z up; mm
P0 (0,0,3000) flange face ── east 5000 ──► P1 (5000,0,3000) ── north 4000 ──► P2 (5000,4000,3000)
   │ field weld W2 at x = 2500                                                    │ down 2000
   ▼                                                                               ▼
                       P4 (8000,4000,1000) flange face ◄── east 3000 ── P3 (5000,4000,1000)
                                     tee centre (7105,4000,1000) ── branch up 500 ──► flange face (7105,4000,1500)
route centreline 5000 + 4000 + 2000 + 3000 + 500 = 14500 mm
take-outs: 3 LR90 x 2 x 152 = 912; tee run 2 x 105 = 210; tee branch 105; 3 flanges x 76 = 228; total 1455
pipe = 14500 - 1455 = 13045 mm = 2424 + 2348 + 3696 + 1696 + 1848 + 714 + 319
```

## Real use cases

| # | Use case | What llull must do | VC / plan |
| - | -------- | ------------------ | --------- |
| U1 | A fabricator sends PCFs exported from Plant 3D / E3D; the owner wants a count of what to buy | read PCF, report counts, lengths, BOM | VC-ISO-01, 08, SC-ISO-01 |
| U2 | The agent models a line in llull and the shop wants a PCF for its own ISOGEN / spool software | write PCF one file per line, lossless | VC-ISO-03, 04, 17, SC-ISO-02 |
| U3 | Shop needs spool drawings and a cut list for a line with one site weld | weld list, spool split, cut list with gap / allowance | VC-ISO-05, 06, 07, SC-ISO-01 |
| U4 | Site needs the final isometric of a line with tables | true iso, north arrow, centreline dims, elevations, tables | VC-ISO-10, 11, SC-ISO-03 |
| U5 | A drain must fall 1:100 | slope annotation and value | VC-ISO-12, SC-ISO-04 |
| U6 | A long rack line does not fit one sheet | split at welds with continuation marks; stable re-issue | VC-ISO-13, SC-ISO-05 |
| U7 | Erection contractor needs a GA plan with line labels and elevations | orthographic piping GA | VC-ISO-15, SC-ISO-06 |
| U8 | The agent must prove its own output before handing it over | `check_isometric` with stable codes | VC-ISO-02, 16, SC-ISO-07 |

## Validation cases

| VC | What | Reference | Tolerance | Test |
| -- | ---- | --------- | --------- | ---- |
| VC-ISO-01 | Parse the fixture: 15 components (FLANGE 3, PIPE 7, WELD 1, ELBOW 3, TEE 1), total pipe 13045 mm | fixture arithmetic | counts exact, 1e-6 mm | `pcfRead.test.ts` |
| VC-ISO-02 | Syntax refusals: TAB, > 1024 chars, missing ISOGEN-FILES, short END-POINT, missing units → stable codes with line paths, document unchanged | rules S3, S4, S7 | exact code + path | `pcfRead.test.ts` |
| VC-ISO-03 | read → write is byte-equal on the MVP subset (sha256 56d1b90a…) | reference writer | byte-equal | `pcfRoundTrip.test.ts` |
| VC-ISO-04 | llull route → PCF → preview: 14500 route = 13045 pipe + 1455 take-out; same topology | closed form + PSC B16.9 LR90 152 (A), tee 105 (B) | 1e-6 mm | `packReplay05.test.ts` |
| VC-ISO-05 | 13 welds (12 shop, 1 field), numbers W1..W13, branch welds after the main run | rule TR-ISO-06; SKEY WS (A) | exact | `welds.test.ts` |
| VC-ISO-06 | 2 spools split at the site weld; 1 spool without it | S6, S7, S11 (A rule) | exact | `spools.test.ts` |
| VC-ISO-07 | Cut lengths for gap 0 / 3 mm and WF allowance 100 mm | closed form | 1e-6 mm | `cutList.test.ts` |
| VC-ISO-08 | BOM (3 FLWN, 13.045 m pipe, 3 elbows, 1 tee) = MATERIALS totals = cut-list sum; spools sum to the line | identity | exact / 1e-6 m | `bom.test.ts` |
| VC-ISO-09 | Bolting: 3 flanged joints → 3 gaskets, 24 studs 5/8 in | B16.5 via PSC (A) + joint rule (B) | exact | `bom.test.ts` |
| VC-ISO-10 | Iso axes: east −30°, north +30°, up 90°, 120° apart, scale √(2/3); north arrow +30° | S18, S19 (A) | 1e-9° | `isoProjection.test.ts` |
| VC-ISO-11 | Dimension labels = 3D centreline distances; east string 76 + 2424 + 2348 + 152 = 5000 | CV-03 (A) + arithmetic | exact | `isoDimensions.test.ts` |
| VC-ISO-12 | SLOPE 1:100, 1 %, 0.5729386977°, fall +X | closed form, CV-05 (A) | 1e-9° | `isoSlope.test.ts` |
| VC-ISO-13 | 20 pieces, ≤ 8 per sheet, split at welds → 3 sheets, matching continuation welds, stable re-issue | rule TR-ISO-12; S22 (B) | exact | `isoSheets.test.ts` |
| VC-ISO-14 | Weld numbers kept after adding a weld; new weld W14 | HIGHEST-WELD-NUMBER (A) | exact | `welds.test.ts` |
| VC-ISO-15 | GA plan: label L-101-DN100-A1A, CL EL +3000 / +1000, BOP 2942.85 | closed form | 0.01 mm | `pipingGa.test.ts` |
| VC-ISO-16 | `check_isometric` codes ISO_DISCONNECTED, ISO_SKEY_MISSING, ISO_OPEN_END, ISO_SPOOL_TOO_LARGE | spec codes | exact set | `checkIsometric.test.ts` |
| VC-ISO-17 | Same plan twice → same PCF / SVG bytes and weld numbers | AF-13 | exact | golden |
| VC-ISO-18 | 1000-component line within the performance budget | TBD — measure with `llull run … --json` | budget | quality gate |

## Reproducing the reference values

```bash
D=docs/plant/05-isometrics-fabrication/validation/data
python3 -I $D/pcf_reference_parse.py $D/iso-01-L101-dn100.pcf                  # gap 0 (the .expected.json)
python3 -I $D/pcf_reference_parse.py $D/iso-01-L101-dn100.pcf --weld-gap 3     # VC-ISO-07 gap3
sed 's/    SKEY WS/    SKEY WF/' $D/iso-01-L101-dn100.pcf > /tmp/wf.pcf
python3 -I $D/pcf_reference_parse.py /tmp/wf.pcf --field-fit-allowance 100     # VC-ISO-07 WF
```

## Not covered here (owned by sibling packs)

- Catalogue dimensions (B16.9, B16.5, B36.10M) and their grades: `01-piping-specs-catalog`.
- Placing fittings, branches, flanges and end connections in llull: `02-spec-driven-routing`.
- Stress isometrics and the CAESAR II neutral / PCF attribute hand-off: `07-pipe-stress-flexibility`.
- Line lists and IFC piping export: `08-plant-data-reports-interop`.
