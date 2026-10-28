# 08 XCH — Procedures for CLI round-trip and review cases

Records of `review` cases go to `../records/<VC id>-<date>.md` with the front matter of [`../../../VALIDATION.md`](../../../VALIDATION.md) §5.

## P1 Drawing round trip (VC-XCH-116, 117; driver `cli`)

For each corpus file `f` of [`../data/corpus.json`](../data/corpus.json) with `format` dwg or dxf:

1. Verify `sha256(f)`; skip (and fail) on mismatch.
2. Oracle census `O(f)`: DXF → ezdxf (MIT) record census and [`dxf_census.mjs`](dxf_census.mjs) (must agree); DWG → LibreDWG
   `dwgread` JSON output (GPL-3.0, test machine only, never shipped) and ACadSharp `DwgReader` (MIT); the two must agree,
   else the file is marked `oracle-disagrees` and excluded from gating with a finding.
3. `llull open_drawing file=f --doc t.llull.json --json` → fidelity report `R`; assert `sum(R.levels[t]) == R.census[t] == O(f)[t]`.
4. `llull export_drawing format=<f.format> version=<f.acadVer> --save g --doc t.llull.json`.
5. Oracle census `O(g)` and value comparison against `O(f)`:
   - counts per type equal for every type at level ≥ L3 (VC-116);
   - for entities matched by handle: layer, colour (ACI and true colour), linetype, lineweight, text content, attribute
     tag / value equal; geometry: max distance between matched curve samples (64 samples per curve) ≤ 1e-9 × diagonal of
     the drawing extents;
   - block names, block entity counts and insert transforms equal.
6. `llull export_drawing` to each other write version (AC1015, AC1018, AC1024, AC1027, AC1032, and DXF R12): the oracle
   re-reads with no error and `$ACADVER` equals the version asked (VC-117).

## P2 DWG TrueView acceptance (VC-XCH-118; driver `review`)

Reviewer role: CAD manager or engineer who uses AutoCAD daily. Build under review: packaged desktop app (version + commit).

1. Export `acs-dwg-ac1032` after P1 step 3–4 and the round-trip of `lr-dwg-2013` as AC1032.
2. Open both in DWG TrueView (free Autodesk viewer [R15], current version recorded). Record: recovery / "drawing needs
   recovery" prompt (must be absent), AUDIT-style errors reported by the viewer (must be 0 if shown), each layout tab
   present, visual comparison against the source file opened side by side (blocks, hatches, dimensions, text, linetypes).
3. Save screenshots; hash them into the record. Decision accept / reject.

## P3 Licence inventory (VC-XCH-137; driver `review`)

Reviewer role: counsel (or the owner with counsel's written answer attached).

1. Generate the inventory of the packaged app: every native binary, crate (`cargo about` or equivalent), npm package and
   Python wheel with licence and version.
2. Assert mechanically: no GPL / AGPL component in the bundle (LibreDWG, libdxfrw, veraPDF must be absent); every MPL-2.0
   component has its notice and a source-availability statement; every LGPL component is a separately replaceable library or
   executable; notices file present.
3. Counsel answers TECHNICAL_SPEC §11 Q2 (a)–(d) and Q3 in the record.

## P4 SHX rendering (VC-XCH-111 review part; driver `review`)

With the reviewer's own licensed SHX fonts in a user font folder: open a drawing whose styles use `txt.shx`, `romans.shx`
and a big font; compare with DWG TrueView: glyph shapes and text widths match (width difference ≤ 1 % of the string
length, measured on screenshots at a known zoom). The fonts are never copied into the repository or the record.

## P5 Parasolid decision (VC-XCH-128; driver `review`)

Owner decision record: demand evidence from the pilot (01 PIL), translator options and cost, decision (defer / buy / build).
