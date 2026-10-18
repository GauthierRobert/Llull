# Gap 04 PID — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: `gitlab.com` (REST API v4), `pypi.org` and
`files.pythonhosted.org` could be downloaded; `dexpi.org`, `help.autodesk.com`, `isa.org`, `iso.org`,
`engineeringtoolbox.com` and GitHub web pages were blocked (HTTP 403 on CONNECT or DNS failure) and were read only
through search-engine extracts. Grades:

- **A**: the primary source was read (or reference code / a validator was run on it), or two or more independent
  sources agree.
- **B**: one secondary extract, or extracts that disagree.
- **C**: located, numbers or wording not confirmed. Never used as a pass / fail gate.

## Sources

| Id | Source | What was taken | How it was checked | Grade |
| --- | --- | --- | --- | --- |
| S1 | DEXPI e.V., *TrainingTestCases* ("Public Example PIDs"), GitLab project 8453791, https://gitlab.com/dexpi/TrainingTestCases, folder `dexpi 1.3/example pids/`, branch `master` (last activity 2025-07-11). Licence: **CC BY 4.0** (project licence field and `LICENSE` file). | 11 DEXPI 1.3 verification reference files (`*-VER.EX0*.xml`, Proteus schema 4.1.1, exported by "P&ID Toolbox" 1.1.0, pnb plants & bytes) copied to `data/dexpi13/` with the licence text. | Counted with `data/scripts/census_proteus.py` and `connectivity_proteus.py` (python3 -I, `xml.etree`, read-only). `C01V04-VER.EX01.xml` is byte-identical (cmp) to the copy shipped in the pyDEXPI 1.2.0 sdist (S4). Counts for C01 agree with the independent DEXPI 2.0 encoding (S2) on all 14 compared keys. | A |
| S2 | DEXPI e.V., *Specification* repository, GitLab project 8826512, https://gitlab.com/dexpi/Specification; releases V1.2 (2017-05-19), V1.3.0 (2021-05-31), V1.4.0 (2024-12-11), V2.0.0 (2025-10-10), V2.0.1 (2026-09-30) from the releases API. | `src/documentation/_static/reference_pid.xml` (DEXPI 2.0.1 XML of the DEXPI reference P&ID, imports `https://data.dexpi.org/models/2.0.1/{Core,Plant}.xml`) and `DEXPI_XML_Schema.xsd`, copied to `data/dexpi20/`; changelog 2.0.1; introduction (DEXPI 2.0 = Plant + Process models in one specification; new XML format, root `<Model>`); `metamodel_and_exchange_format.rst` (ID / IDREF `#id` / nameReference rules). | `xmllint --noout --schema DEXPI_XML_Schema.xsd reference_pid.xml` → "validates" (run 2026-10-18). Census by `data/scripts/census_dexpi20.py`. The repository has no LICENSE file; the published specification states CC BY 4.0 (S3), which is the basis for redistribution here, with attribution. | A |
| S3 | DEXPI P&ID Specification 1.4, `builds/PDF/DEXPI_PID_Specification_1.4.pdf` in S2 (46 512 104 bytes, sha256 `9d52e0b3a80a88ea060571eda7588408d339f01c91f4e2ed732b1e2ebf5e38be`, created 2024-12-11). Licence: CC BY 4.0 (stated on its licence page). Not copied (size). | §3 "Implementation in Proteus Schema": "The exchange format for DEXPI 1.4 is Proteus Schema 4.2.0"; class → tag + `ComponentClass`/`ComponentClassURI`; attributes as `<GenericAttribute>` in `<GenericAttributes Set="DexpiAttributes">`; null vs absent attribute rule; §8.54.26–27 `SourceItem`/`SourceNode` = `Connection@FromID` / zero-based `@FromNode`; §9.23.9 `ProcessInstrumentationFunctionCategory` ("typically one or two letters … there are no formal DEXPI restrictions for valid strings"). | Text extracted with `pdftotext` and read. | A |
| S4 | pyDEXPI 1.2.0, Process Intelligence Research (TU Delft), PyPI sdist `pydexpi-1.2.0.tar.gz`, https://files.pythonhosted.org/packages/c2/ba/36c1e002e5351f967f8fb630210ce671e69a30fc4ff96b7375d0a60db51c/pydexpi-1.2.0.tar.gz (11 294 532 bytes, sha256 `03b1185a78e15685bcbffa702913479e2609358a28294af191248c3fce711837`). Licence: **AGPL-3.0** (not MIT). Supports DEXPI 1.3. | Test assertions on C01: `len(actuatingSystems) == 3`, shape catalogue `== 24`, diagram group 12 holds 11 piping network systems, every segment passes `piping_network_segment_validity_check` (VALID), parser raises no warning/error; validity codes `INTERNAL_VIOLATION`, `CONNECTION_CONVENTION_VIOLATION`, `MULTIPLE_NODE_REFERENCE_VIOLATION` (`pydexpi/toolkits/piping_toolkit.py`). | Read as text; code not executed (sandbox rule) and nothing copied (AGPL). Its numbers agree with S1 census. | A (agreement with S1) |
| S5 | Engineering ToolBox, "Process Instrumentation — ISA Codes", https://www.engineeringtoolbox.com/isa-intrumentation-codes-d_415.html (cites ANSI/ISA S5.1-1984 (R1992)) | First letters, first-letter modifiers, succeeding readout / output letters | search-engine extract only (site blocked) | B alone; A where S6 agrees |
| S6 | ISA 5.1 letter tables on instrumentationblog.in, tagsight.io, pathnovo.com, mechcodex.com, instrunexus.com, formacion-industrial.com (search extracts, 2026-10-18) | Same letter meanings; M modifier "middle, intermediate" (one extract: "momentary") | several extracts agree with S5 row by row; disagreements recorded in `data/isa51_letters.json` | A per agreeing row; B for M, I, J, K, X modifiers |
| S7 | industrialmonitordirect.com, "PLC and DCS Tag Naming Conventions ISA-5.1" (extract) | modifier J = scan; tag structure (letters + loop number) | single extract | B |
| S8 | Autodesk, AutoCAD Plant 3D / P&ID Help: "P&ID Validation Error Reference" (2016, 2017, 2022 help sets, GUID-DF42724D-EB2E-497F-8A33-0E8C42C3D279) and "P&ID Validation Settings Dialog Box" (2017, 2025, GUID-3FDD798F-FB2A-432C-804E-7A616ABFB79A); "Correct Validation Errors" (P&ID 2010) | Error categories: non-terminating lines, unconnected components (tanks/vessels need ≥ 1 line; every attachment point connected), size mismatch, spec mismatch, flow direction conflicts, unresolved off-page connectors; Validate Config command | search extracts of several help editions agree | A for category names; wording paraphrased |
| S9 | Autodesk Plant 3D Help: "About Validating Plant 3D Models", "To validate a 3D model for disconnected parts, placeholder parts, or property mismatches", "To validate a Plant 3D model against a P&ID drawing", "About Validating P&ID Drawings and Plant 3D Models" (2016, 2017, 2027 help sets) | 3D validation: disconnected parts, placeholder parts, property mismatches; P&ID ↔ 3D validation; P&ID and 3D objects do not share data, so drift is found only by validation | search extracts | B (wording), categories used as design inputs only |
| S10 | ISO 10628-2:2012 *Diagrams for the chemical and petrochemical industry — Part 2: Graphical symbols*, catalogue records (iteh.es, sis.se, SIST EN ISO 10628-2:2013) | Scope: graphical symbols for chemical / petrochemical diagrams; collective application standard of ISO 14617; not for electrotechnical diagrams (IEC 60617); replaces 1997 edition; confirmed 2024-03-14 | catalogue extracts | A (public catalogue facts only; no symbol geometry taken) |
| S11 | IEC 62424:2016 ed. 2 *Representation of process control engineering — Requests in P&I diagrams and data exchange between P&ID tools and PCE-CAE tools*, catalogue (webstore.iec.ch/publication/25442, VDE preview) | Scope; CAEX-based exchange; clause 6.3.4 "PCE categories and processing functions" (content not read) | catalogue extracts | A (scope only); letters not used |
| S12 | ANSI/ISA-5.1 *Instrumentation Symbols and Identification*, isa.org product pages for the 2009, 2022 and 2024 editions | edition list only | search extracts | A (existence); content not read |
| S13 | Autodesk App Store, "DEXPI Data Bridge" (app 75fd9d89-871a-4ea9-833d-cd172a9a8184): commands DEXPI_EXPORT, DEXPI_IMPORT, DEXPI_MAPPING_EDITOR; Plant 3D 2023–2025 | competitor state of the art: DEXPI in Plant 3D is an add-in with a mapping file | single extract | B (context only) |
| S14 | OPC Foundation, *OPC UA for DEXPI* (OPC 30250), https://reference.opcfoundation.org/DEXPI/; DEXPI talk at ISO/TC 184/SC 4 (standard.no, 2024-10-23); "Update on DEXPI Standards", CAPE-OPEN annual meeting 2025 (colan.org); Wiley Process Technology, "DEXPI 2.0" (2026-03-13) | DEXPI 1.3 uses a Proteus extension (4.0.1 / 4.1.x); DEXPI 2.0 merges Process (BFD/PFD) and Plant (P&ID) models with a new serialization | extracts; release facts confirmed by S2 releases API | A (with S2) |
| S15 | ProteusXML schema, https://github.com/ProteusXML (cited by S3 for Proteus 4.2.0) | schema file not obtained (GitHub blocked) | — | C |

## Downloaded files

| File (in `data/`) | Bytes | sha256 | Origin | Licence |
| --- | --- | --- | --- | --- |
| `dexpi13/C01V04-VER.EX01.xml` | 445 726 | `a2b172f04e0dcf9a668e158c6dee3b5fd0dd4e9027b572dc39e54470562b809c` | S1 `dexpi 1.3/example pids/C01 DEXPI Reference P&ID/` | CC BY 4.0, © DEXPI e.V. |
| `dexpi13/C02V03-VER.EX02.xml` | 157 666 | `dfe4323c18d018caa4b28ec789b3dbee21be73c6a07c7cbd0791ceebd322113b` | S1 C02 Process Column (BASF) | CC BY 4.0 |
| `dexpi13/C03V04-VER.EX02.xml` | 68 507 | `a1c892f3bc21338c2546baf71e10abf11e3653b7cd6956b1a24bcfab0db88f14` | S1 C03 Piping (Equinor) | CC BY 4.0 |
| `dexpi13/E03V01-VER.EX01.xml` | 3 113 | `a26bda5dda7d3b8bd6b661a5c2f8803463f94027e97ff142bcd3a0f35b8e1357` | S1 E03 Pump With Nozzles | CC BY 4.0 |
| `dexpi13/E06V01-VER.EX01.xml` | 6 288 | `2a6b4762cd1c85c9fcf329f885ca368769a84ebd5dbf5966c6a0781bb4038351` | S1 E06 Pump, HeatExchanger, Nozzles Connected With PNS | CC BY 4.0 |
| `dexpi13/I01V01-VER.EX01.xml` | 4 918 | `fa9a947c0967f0fb9312eb6793354056d4f6b96e6f11425e924a07169d9b9de2` | S1 I01 Measurement | CC BY 4.0 |
| `dexpi13/I02V01-VER.EX01.xml` | 5 106 | `b3b8c59b7005e44e57ec56b8df407fed4115ee6411988eed4ba040ea834c291d` | S1 I02 Control | CC BY 4.0 |
| `dexpi13/I06V01-VER.EX01.xml` | 12 311 | `949b2bcf9bf42b7529171b3f5b3bdd722c5b324640b23ee6af4adc101f2cf79b` | S1 I06 CCR flow indication and high alarm, flow control, control valve | CC BY 4.0 |
| `dexpi13/P01V01-VER.EX01.xml` | 3 684 | `1c88ab8aec8ac9d721b454aa9dc1fe669e6efbea871a36e39beeb9a5fdac4076` | S1 P01 Pipe FromTo Nozzles | CC BY 4.0 |
| `dexpi13/P02V01-VER.EX01.xml` | 4 259 | `6084e2bbaba4f018551f2db6744fba2976b95a15de172e6cf5f342df009f6611` | S1 P02 Pipe From OPC to Nozzle | CC BY 4.0 |
| `dexpi13/P04V01-VER.EX01.xml` | 4 651 | `535a01b3433bdceb0128db8369178c156507ee3d3dbdd9786eae5c30d1c9b543` | S1 P04 Pipe With Intersection | CC BY 4.0 |
| `dexpi13/LICENSE-CC-BY-4.0.txt` | 18 650 | `7e7170e3cebf88a9f60c7b8421418323c09304da1af4d5e90f4da1dc1c8a2661` | S1 `LICENSE` | — |
| `dexpi20/reference_pid.xml` | 1 481 865 | `acd39c74292aef3f6f00581fc78b05814acf2318815abd28c14ebefba12fdd94` | S2 `src/documentation/_static/` | CC BY 4.0 per S3 licence page, © DEXPI e.V. |
| `dexpi20/DEXPI_XML_Schema.xsd` | 28 664 | `0bd6568b7c52fd59ac4ef6d8547ab2b2aa890c009a3a1bfbc5d7cc18c53b36e6` | S2 `src/documentation/_static/` | CC BY 4.0 per S3 |

Not copied: `DEXPI_PID_Specification_1.4.pdf` (S3, 46.5 MB, hash above) and the pyDEXPI sdist (S4, AGPL-3.0, hash above).

Attribution for every DEXPI file: "DEXPI reference and verification examples © DEXPI e.V., licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/); unchanged copies."

## Not verified (not used as gates)

- ISO 10628-2 symbol geometry and registration numbers (paywalled; the DEXPI files carry
  `SymbolRegistrationNumberAssignmentClass` values, which are imported as data, not interpreted).
- IEC 62424 category / processing-function letters (clause 6.3.4 not read). The DEXPI reference P&ID uses them
  (`PICSA`, `TICSA`); llull parses them with the ISA table and reports the convention it used.
- ISA 5.1-2024 changes relative to 2009 (edition currency grade C).
- Proteus 4.2.0 XSD (S15). The DEXPI 1.3/1.4 export is validated by census equality and re-import, not by schema.
- Autodesk exact error message texts (paraphrased).
