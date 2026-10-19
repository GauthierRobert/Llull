# Gap 05 ISO — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: direct fetches of vendor help sites (Autodesk, AVEVA,
Hexagon, CADMATIC, PTC), standards bodies (iso.org), Google Sites, Scribd, pdfcoffee and GitHub HTML / API were all
refused (proxy 403 or DNS failure; WebFetch could not resolve any host). Reachable: PyPI, npm and some
`raw.githubusercontent.com` paths (including GitHub wiki raw pages). Everything else was read through search-engine
extracts only. Grades:

- **A**: the primary source was read, or two or more independent sources agree.
- **B**: one secondary extract.
- **C**: the source was located but its content is not confirmed. C-grade values never gate a test.

No public sample PCF could be downloaded: no PyPI or npm package parses ISOGEN PCF (the `pcf` names are Valve particle
files, PowerApps component framework, bitmap fonts), the open-source PCF tools found (Revit PCF Importer / Exporter,
PipeCAD / IsoAlgo) ship no sample PCF at a guessable raw path, and the pages that print sample PCF text (S4, S5, S8,
S17) could not be fetched. The pack therefore ships **one authored PCF** (`data/iso-01-L101-dn100.pcf`) written to the
record syntax confirmed below. Its expected values are arithmetic on its own coordinates (closed form), so they gate;
its conformance to ISOGEN is B until OQ-ISO-01 is closed (run the file through a licensed ISOGEN / Plant 3D
`PLANTPCFTOISO` or the free IsoAlgo viewer).

## Source table

| Id  | Source | What was taken | How it was checked | Grade |
| --- | ------ | -------------- | ------------------ | ----- |
| S1  | Piping Component File Reference Guide, version 2016 (13.0), May 2016, Alias Ltd / Intergraph (Hexagon); copies indexed on scribd.com/document/371120830 and pdfcoffee.com | existence, edition, ~388 pages, contents (syntax, header, component information sheets) | search extracts only; full text not read | C (content) |
| S2  | "Intergraph makes Isogen PCF documentation available", Chemical Processing, 2015, https://www.chemicalprocessing.com/industrynews/2015/intergraph-makes-isogen-pcf-documentation-available-/ | the PCF reference documentation is free to download and use | two search extracts (news item + the Revit PCF Exporter README linking the Intergraph press release) | A |
| S3  | shtirlitsDva, Revit PCF Exporter wiki: `PCF-compliance`, `Export-to-Caesar-II`, `Pipe-supports`, `Tap-connections` (raw: https://raw.githubusercontent.com/wiki/shtirlitsDva/Revit-PCF-Exporter/<page>.md). Repository licence GPL-3.0 (`LICENSE.md`); wiki licence not stated | header unit keywords, pipeline-header keyword list, component type list, attribute keywords, SUPPORT uses CO-ORDS, HIGHEST-WELD-NUMBER, CAESAR II COMPONENT-ATTRIBUTE1..10 map | **downloaded and read in full** (sha256 below); it is one implementer's reading of S1, so it is a secondary source | B (A where another source agrees) |
| S4  | Far East Piping Reference, "PCF/APCF/Super PCF", https://sites.google.com/site/fareastpiperreference/pcf | sample PCF layout: ISOGEN-FILES first, END-POINT lines with bore, PIPELINE-REFERENCE, FLWN, MATERIALS block with ITEM-CODE + DESCRIPTION at the end | search extracts (two queries) | B |
| S5  | PTC Community thread "Pro/piping branch issue" (https://community.ptc.com/3d-part-assembly-design-327/pro-piping-branch-issue-39267) and CAD.de upload `16.1050-80.pcf` | real header block `ISOGEN-FILES`, `UNITS-BORE MM`, `UNITS-CO-ORDS MM`, `UNITS-BOLT-DIA MM`, `PIPELINE-REFERENCE` | search extracts | B (A with S3, S4 for the header) |
| S6  | AVEVA Everything3D 1.1 ISODRAFT User Guide / Reference Manual: "SPOOL", "Numbering in Spool Drawing Isometrics", "WELD Symbol Keys", https://help.aveva.com/AVEVA_Everything3D/1.1/ISOUG/ISOUG6.06.02.html, …/ISOUG6.06.03.html, …/ISORM/ISORM4.04.25.html | weld SKEYs WS site / WF field-fitted / WW shop; spools and fields set at SHOP flag changes; forced spool breaks; numbering of spools, parts, welds stored in the database; ISODRAFT's own weld numbers not kept between revisions; spool numbers run continuously across drawings | search extracts (two queries) | B (A for WS/WF with S8, S13) |
| S7  | PCF Reference Guide copy on pdfcoffee.com (`pc-f-reference-guide-9`) | item code / description start in column 5; max line 1024 characters; no TAB; SPOOL-IDENTIFIER CO-ORDS … TEXT …; HIGHEST-WELD-NUMBER → N+1; ERECTION / OFFSHORE items end a spool | search extracts | B (A where S3 / S11 agree) |
| S8  | PTC Creo Piping help: "Example: Weld Components in a PCF File", "Creating Pipe Component Information" (support.ptc.com/help/creo/creo_pma/r12/…) | END-POINT = coordinates + nominal size + end type; CENTRE-POINT = coordinates; bends = 2 END-POINT + CENTRE-POINT; tees need CENTRE-POINT + BRANCH1-POINT; weld items with SKEY WF / WS, REPEAT-WELD-IDENTIFIER, WELD-ATTRIBUTE | search extracts | B (A with S4, S7) |
| S9  | ISOGEN Symbol Key (SKEY) Definitions Reference Guide, Hexagon, version 2016 (pdfcoffee, studocu, CAD.de `SymbolKeys.pdf`) | SKEY = family + end condition; ELBW, ELSW, TEBW, FLWN, REBW; end codes BW SW FL CP SC PL | search extracts of three copies | A (ELBW, TEBW, FLWN, end codes) / B (others) |
| S10 | Autodesk support, "Missing description in bill of materials (BOM) in Isometrics created with PLANTPCFTOISO in AutoCAD Plant 3D" | DESCRIPTION lines sit at the bottom of the PCF paired with ITEM-CODE | search extract | B (A with S4 for the MATERIALS layout) |
| S11 | Autodesk AutoCAD Plant 3D help 2018–2025: "About Iso Styles and Themes", "Iso Style Setup", "To Work with PCF Files"; Autodesk support "Isometric cut piece list with field fit welds show up blank…"; AU handouts ES10519-L and ES10494 | four default iso styles (check, stress, final, spool); final iso has the BOM and is the document of record; spool sizing by cube size, weight or model property; split long pipe with field welds; field-fit welds are erection items in the PCF; four iso tables (BOM, cut piece list, weld list, spool list) | search extracts (three queries) | A |
| S12 | Autodesk Plant 3D help, "To Work with PCF Files" | PCF export from the Isos tab; one PCF per selected line number | search extract | B |
| S13 | CADMATIC Plant, "PCF Export", https://docs.cadmatic.com/plant/Content/Piping%20Isometrics/Application/Manage/link_pcf.htm | component keyword list (… OLET, PIPE, REDUCER-CONCENTRIC, REDUCER-ECCENTRIC, REINFORCEMENT-PAD, SAFETY-DISC, SUPPORT, TEE, VALVE, WELD); WS = site / field weld; WELD-ATTRIBUTE3 "Shop Weld" / "Field Weld" by SKEY | search extracts (two queries) | B |
| S14 | "PCF Component Guide" and "Isogen Files" (Personal ISOGEN) copies on pdfcoffee.com | ERECTION-ITEM bolts and flanges, FABRICATION-ITEM pipe and gaskets; FABRICATION / ERECTION attribute needed when bolts are included with a nozzle | search extracts | B |
| S15 | PASS/START "PCF file import", https://www.passuite.com/kbase/doc/start/WebHelp_en/pcf.htm; PCF Component Guide (ELCL / TECL) | further keywords ELBOLET, FLANGE-REDUCING-CONCENTRIC, ELBOW-TEED; clamped-end SKEYs | search extracts | B |
| S16 | "Isodraft List of SKEY (Symbol Key)", https://pdmsmacro.wordpress.com/2013/07/08/485/ | SKEY end-condition letters; FLSJ slip-on | search extract | B (end codes A with S9) / C (FLSJ) |
| S17 | PypeServer KB, "Importing PCF files", https://pypeserver.zohodesk.com/portal/en/kb/articles/importing-pcf-files | pipe values (schedule, wall) belong in the MATERIALS section per the PCF specification; TEE-SET / TEPL example; pipe-to-pipe saddle connections are not defined by PCF | search extracts | B / C (TEPL) |
| S18 | "Isometric projection", Wikipedia, https://en.wikipedia.org/wiki/Isometric_projection | 120° between projected axes; tilt arcsin(1/√3) = arctan(1/√2) ≈ 35.264° | search extract; recomputed in `pcf_reference_parse.py` | A |
| S19 | Ramesh, "Axonometric projections" lecture, Carnegie Mellon, https://www.andrew.cmu.edu/user/ramesh/teaching/course/48-175/lectures/10.AxonometricProjections.pdf | equal foreshortening √(2/3) = 0.8165; axes at 30° | search extract; recomputed | A |
| S20 | Project Materials, "Piping Isometrics: How to Read and Understand Them", https://blog.projectmaterials.com/epc-projects/engineering/piping-isometrics/; S. V. Lele, "Piping isometric drawings", http://www.svlele.com/isoinfo.htm; studylib "Piping isometrics: drawing & dimensioning guide" | north arrow up-right (alternative up-left, never down); not to scale; centreline dimensions; coordinates / elevations; SLOPE ratio + arrow; 22.5° offsets; squaring-in planes | search extracts of three independent pages | A (CV-01..03, 05) / B (CV-04, 06) |
| S21 | CADS Schroer, "Piping isometric drawing: overview, tips and downloads", https://www.cad-schroer.com/news/articles/piping-isometric-drawing-overview-tips-and-downloads/; ScienceDirect topic "Piping isometric" | not to scale; dimensions and slopes on isos | search extracts | B (A with S20) |
| S22 | Hexagon Smart 3D / Isogen documentation (docs.hexagonppm.com): Change Management sheet "1A"; option switch 53 position 3 (spool weld numbers match the full isometric; not for Smart 3D models) | sheet content stability across re-extraction; spool vs full iso weld numbering | search extract | B |
| S23 | Piping Designers, "Section 13D: Locating field welds" (pipingdesigners.com, 2014); open-exam-prep NCCER boilermaker "Spool fabrication workflow"; Industrial Monitor Direct "Pup spool maximum length" | spools split to a shipping box; field-fit weld = extra length left and trimmed on site; ISODRAFT adds a specified allowance to each cut length associated with a field-fit weld; B31.3 sets no maximum spool length | search extract | A (shipping rule, no B31.3 limit) / B (allowance rule) |
| S24 | ISO 6412-1:2017 catalogue page, https://www.iso.org/standard/73352.html (+ SCC, UNE, Singapore listings) | title, edition 2 (2017-12), confirmed 2023, replaces 1989, scope (all pipes, rigid / flexible, any material; usable for ducts) | catalogue extracts from several national bodies | A |
| S25 | ISO 6412-2:2017 catalogue page, https://www.iso.org/standard/73353.html (+ AFNOR, SCC, Standards NZ, BSI EN ISO 6412-2:2018) | title, edition 2, 12 pages, confirmed 2023, ISO/TC 10/SC 10, scope (supplementary rules for isometric representation) | catalogue extracts from several national bodies | A |
| S26 | 01-piping-specs-catalog pack, `validation/data/asme_b16_9_buttweld_fittings.json` (sibling gap) | DN100 LR 90° elbow centre-to-end 152 mm (grade A there), straight tee run 105 mm (grade B there) | read from the sibling file 2026-10-18 | A / B as graded by PSC |
| S27 | 01-piping-specs-catalog pack, `validation/data/asme_b16_5_wn_rf_flanges.json` | class 150 NPS 4: 8 bolts, 5/8 in (grade A there) | read from the sibling file | A |
| S28 | eryar, PipeCAD README, https://raw.githubusercontent.com/eryar/PipeCAD/master/README.md | IsoAlgo: PCF / IDF viewer and DXF isometric generator; application not open source, Python plugins MIT | downloaded and read | A (existence) |
| S29 | shtirlitsDva, Revit PCF Importer README, https://raw.githubusercontent.com/shtirlitsDva/Revit-PCF-Importer/master/README.md | an open PCF import implementation exists (no licence file at the root) | downloaded and read | A (existence) |
| S30 | Bentley ConstructSim Executive help, "Digital Isometrics" | PCF developed by Alias Ltd; produced by AutoPLANT, Plant4D, CADWorx, CATIA, Pro/Engineer | search extract | B |
| S31 | CADS Schroer M4 ISO / M4 ISO FX product pages | commercial PCF → unscaled isometric converters exist | search extract | B (market context only) |
| L1  | llull source tree at this commit | current state (TECHNICAL_SPEC §1) | read in the repository | A |

## Downloaded files (not redistributed)

The Revit PCF Exporter wiki pages are read for keyword facts; the wiki has no stated licence, so the pages are not
copied into `data/`. Facts are transcribed into `data/pcf_keywords.json` with the source id.

| File | URL | Size (bytes) | sha256 |
| ---- | --- | ------------ | ------ |
| PCF-compliance.md | https://raw.githubusercontent.com/wiki/shtirlitsDva/Revit-PCF-Exporter/PCF-compliance.md | 10094 | 4e87cdcf426c1afa4200429ef1ceb119c97de4977f31c9c1327d2bc4d7629ea7 |
| Export-to-Caesar-II.md | …/Export-to-Caesar-II.md | 3247 | eba61e4640ef1bb6798932a4d8743b1caac46f117ca795a814902a3309e10ee4 |
| Pipe-supports.md | …/Pipe-supports.md | 2257 | 0a4489aab2c51915a7e08d8b17e11b6bd39792cdb8d02ec57cd221b00ab56eee |
| Tap-connections.md | …/Tap-connections.md | 1615 | ebfe428c5362b3af14c6ed88a0cc142aca6b8b8086c89fd8c8c82f30f9c35e56 |
| Overview.md | …/Overview.md | 2494 | eaa87aa0d2011905d2e2fcb664bb7b783dd5d69b0a084465fab4bf932ac81684 |
| Sample.md | …/Sample.md | 283 | e34c959857c91b81047bc4f65cd2ef720adb67eea64a5abf6ea4276bc24295de |
| PipeCAD README.md | https://raw.githubusercontent.com/eryar/PipeCAD/master/README.md | — | read only |

## Files in `data/` (authored by this pack; same licence as the repository docs)

| File | Size (bytes) | sha256 | Content |
| ---- | ------------ | ------ | ------- |
| iso-01-L101-dn100.pcf | 3160 | 56d1b90a4796939e1885c597f20306bc459ec6fa86c583ce0a8e1e5bea81cefd | authored sample PCF (15 components) |
| iso-01-L101-dn100.expected.json | 5613 | cdf6a1b5032f99a02e8868599677b3e31295a2fad0b6c838cf22d1d8fa6e91d5 | output of the reference script (gap 0, allowance 0) |
| pcf_reference_parse.py | 11376 | 8a9899edecc892c1b5925a023f16f275891e0dbb0a6417155a7cbf418b01910f | stdlib reference parser / writer / analyser (`python3 -I`) |
| pcf_keywords.json | 7274 | a0e5c3d2e6cb1c5c19ac800f44e4f3841442011b6b8fdea404a028b48928c1a3 | transcribed keyword and syntax table with source ids |
| skey_catalogue.json | 2265 | e010af92906334086ff775126cbdc54b9f011ffe8e2462770b25077e481abc81 | transcribed SKEY rows with grades |
| iso_drawing_conventions.json | 5071 | 34f48de56b7a13530606a716465ad7fde9ff5637f04f7d9b79f580e3e7b4496f | projection closed forms, drawing conventions, ISO 6412 catalogue facts |

## Unreachable or not verified (not used as gates)

- The PCF Reference Guide (S1), the SKEY guide (S9) and the ISOGEN option-switch reference: located, not readable.
- Every sample PCF printed on a web page (S4, S5, S8, S17): only fragments seen in extracts.
- help.autodesk.com, help.aveva.com, docs.hexagonppm.com, docs.cadmatic.com, support.ptc.com, iso.org: blocked for
  direct fetch (CONNECT 403 / DNS).
- SKEYs VTFL, CPBW, KABW, FLSO, GASK: searched, not confirmed.
- A standard field-fit allowance (100 / 150 mm): no source; the allowance is always an explicit parameter.
- ASME B16.5 weld-neck length through hub for NPS 4 class 150: not in the PSC data; the sample's 76 mm flange length
  is a fixture value, not a catalogue claim.
