# Gap 08 DAT — Sources

Accessed 2026-10-18. Network limits of the authoring sandbox: `raw.githubusercontent.com` / `git clone` of public
buildingSMART repositories and PyPI worked. `help.autodesk.com`, `docs.aveva.com`, `standards.buildingsmart.org`,
`ifc43-docs.standards.buildingsmart.org`, `cfihos.kraken.im`, `iogp.org`, `mimosa.org`, `posccaesar.org`, `oilit.com`
and Wikipedia were blocked (proxy 403 or DNS failure for direct fetch). Their content is known only from search-engine
extracts and is graded accordingly. The web-search budget of the session ran out before a second CFIHOS query, so the
CFIHOS register columns are not confirmed.

Grades:

- **A**: primary source read, reference code run, or two or more independent sources agree.
- **B**: one secondary extract.
- **C**: located, numbers or content not confirmed. Never a pass / fail gate.

| Id | Source | What was taken | How it was checked | Grade |
| -- | ------ | -------------- | ------------------ | ----- |
| S1 | buildingSMART International, *Sample-Test-Files*, folder `IFC 4.3.2.0 (IFC 4.3 ADD2)/Simple-Scene/`, commit `80d976a9b193a26a8e928c3e79bff67af1de68a8` (2026-09-04), https://github.com/buildingSMART/Sample-Test-Files — licence CC BY 4.0 | `Infra-Plumbing.ifc` and `Building-Hvac.ifc`, copied unmodified to `data/bsi/` | `git clone --filter=blob:none`; sha256 recorded below; both pass `ifcopenshell.validate --rules` (0 errors); entity counts measured with IfcOpenShell (`data/reference/bsi_sample_stats.json`) and cross-checked by `grep` of the STEP text | A |
| S2 | buildingSMART International, *IFC4.3.x-development*, commit `7256780bd95fcc5b3653e07b3e8ec2f8389c9f3d` (2026-10-12), https://github.com/buildingSMART/IFC4.3.x-development — licence CC BY-ND 4.0 (development version; official HTML at standards.buildingsmart.org/IFC/RELEASE/IFC4_3/) | Enumerations `IfcPipeSegmentTypeEnum`, `IfcPipeFittingTypeEnum`, `IfcValveTypeEnum`, `IfcDistributionSystemEnum`, `IfcFlowDirectionEnum`, `IfcDistributionPortTypeEnum`, `IfcTankTypeEnum`, `IfcPumpTypeEnum`, `IfcHeatExchangerTypeEnum`, `IfcCompressorTypeEnum`; the *Port Connectivity* and *Port Nesting* concept text of `IfcDistributionPort` ("RelatingPort is set to a port having FlowDirection=SOURCE and the RelatedPort … SINK"; ports nested with `IfcRelNests`); `IfcRelConnectsPorts.NoSelfReference` | Markdown files read in the repository; the enumeration sets compared item by item with S3 — all 10 agree (`enumCrossCheck` in `data/reference/ifc4x3_add2_plant_schema_facts.json`). Only facts transcribed, no document redistributed | A |
| S3 | IfcOpenShell 0.9.0.post1, PyPI wheel, https://pypi.org/project/ifcopenshell/ — LGPL-3.0-or-later | The IFC4X3_ADD2 EXPRESS schema compiled into the library (attributes, abstract flags, subtypes, enumerations); the IFC4X3 property-set templates (`Pset_PipeSegmentTypeCommon`, `Pset_PipeFittingTypeCommon`, `Pset_ValveTypeCommon`, `Pset_DistributionPortCommon`, `Pset_DistributionPortTypePipe`, `Pset_TankTypeCommon`, `Pset_PumpTypeCommon`, `Pset_PipeConnectionFlanged`, `Pset_DistributionSystemCommon`); `ifcopenshell.validate --rules` (schema + EXPRESS WHERE rules); `ifcopenshell.api` used to write the reference files | Reference code run (`data/scripts/*.py`, run with `python3 -I` in a scratch venv). Found: `IfcFacilityPart` is abstract in IFC4X3_ADD2 (use `IfcFacilityPartCommon`); `api.system.connect_port` writes a reciprocal pair of `IfcRelConnectsPorts` per connection (18 for 9) | A |
| S4 | ifctester 0.9.0, PyPI wheel, https://pypi.org/project/ifctester/ — LGPL-3.0-or-later; bundles buildingSMART IDS 1.0 `ids.xsd` (sha256 `8975dc18bd18f08a345a430a22bf317a54d94671b7db01400042fa43b6c0d1f3`, 13 158 bytes) | IDS 1.0 checker run on the reference files and the S1 samples (`data/reference/ids_results.json`) | Reference code run; the IDS file `data/reference/plant-handover.ids` parses with ifctester (schema-validated on load) | A |
| S5 | openpyxl 3.1.5, PyPI, https://pypi.org/project/openpyxl/ — MIT | Writer / reader of the XLSX round-trip fixtures (`data/reference/equipment-list-*.xlsx`), sheet and cell protection flags | Reference code run, fixtures read back cell by cell | A |
| S6 | ISO 16739-1:2024 *Industry Foundation Classes (IFC) for data sharing in the construction and facility management industries — Part 1: Data schema*, Edition 2, 2024-03, https://www.iso.org/standard/84123.html | Title, edition, date, status "Published"; IFC 4.3 is this edition; scope extended to infrastructure (bridges, roads, railways, waterways, ports) | ISO catalogue page extract + Genorma listing (published 2024-03-22; EN ISO 16739-1:2024 2024-04-03) + buildingSMART announcements ("IFC 4.3 formally approved and published as an ISO standard", 2024) agree | A |
| S7 | Autodesk, *AutoCAD Plant 3D 2026 User's Guide* — "To Export Data from the Data Manager", "About Exporting Data from the Data Manager" (help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/GUID-C09E92A6-…, GUID-D375BC3C-…); same topic in the 2016–2023 guides | Data Manager export to XLSX (default) or CSV; one row per plant object, one column per property; read-only columns write-protected in the exported sheet, except properties in *Acquire* mode; an import topic and "To Accept or Reject Changes in Imported Data" exist | Search extracts of the 2026 and older guides agree on formats and read-only protection (A); the accept / reject review step is known only by its topic title (B) | A / B |
| S8 | Autodesk, *AutoCAD Plant 3D / P&ID User's Guide* — "To Work with Properties" (2026), "To Set Up a Tag Format" (2023, 2026), "To assign a tag format to a class definition" (2015/2017), "About P&ID Line (SLINE) Grouping" (2015), "About Pipe Line Numbers" (2017) | Class definitions in Project Setup; property name without spaces + display name; name / type change = delete and re-add; tag format = subparts of class properties, drawing properties or delimiters; tag format linked through the `TagFormatName` property default; P&ID default line-segment tag *Size-Spec-Service-Line Number*; line number is a property of the line group | Search extracts of several help versions; one extract per topic | B |
| S9 | AVEVA, *E3D Design* documentation (docs.aveva.com/bundle/e3d-design/…) and *AVEVA E3D Model Conversion User Guide 2.1* (help.aveva.com/AVEVA_Everything3D/2.1/ModConv/ModConv2.03.5.html) | Hierarchy WORLD → SITE → ZONE → EQUI / PIPE → BRAN; elements owned in strict order; ZONE = geographical or administrative division; PIPE owns branches of one pipe specification; BRAN has a known head and tail; EQUI owns primitives and nozzles; mapping E3D PIPE → Smart 3D Pipeline, BRAN → Pipe Run, EQUI → Equipment | Search extracts | B |
| S10 | IOGP JIP36 *CFIHOS* (Capital Facilities Information Handover Specification): IOGP news "Year of renewal for CFIHOS"; MIMOSA meeting presentation, March 2021; ExxonMobil / IOGP presentation 2022; oilit.com articles 2019–2023; cfihos.kraken.im "master tag-equipment register" | CFIHOS moved from USPI-NL to IOGP (JIP36); purpose (common language to hand over information that exists in EPC systems, for operators, contractors, suppliers); Reference Data Library = naming of tag / equipment classes, properties, pick lists, units, documents; v1.5 released (2021); v2.0 planned for Q3 2023 (release not confirmed); intent to move to ISO 15926; a master tag-equipment register with controlled columns (manufacturer, parent tag, process unit, safety-critical flag, …) | Search extracts only; no CFIHOS file downloaded; column list not confirmed | C (version, columns); B (purpose, ownership) |
| S11 | ISO 15926 *Industrial automation systems and integration — Integration of life-cycle data for process plants including oil and gas production facilities* (Wikipedia; POSC Caesar Association pages and papers, 2008–2012) | Part 2 data model (IS since 2003); Part 4 reference data (POSC Caesar RDL incl. ANSI pipe and fittings classes); Part 8 OWL/RDF implementation; Part 12 life-cycle integration ontology in OWL 2; PCA RDL downloadable as OWL | Search extracts; current part list and status of later parts (e.g. -14) not confirmed | B (parts 2/4/8); C (others) |
| S12 | Hexagon, *SmartPlant Foundation Help — Loading Tags Work Process* (docs.hexagonppm.com/r/en-US/SmartPlant-Foundation-Help/644339) | An EPC keeps tag numbers consistent across disciplines by pre-allocating tags (data sheets to vendors) or by importing vendor Excel data and allocating numbers | Search extract | C |
| S13 | llull repository at the session branch (this repo) | Current state: `export_ifc`, `building_schedule`, `quantity_takeoff`, `bill_of_materials`, `add_equipment`, `add_pipe_run`, the production-gate IFC oracle | Files read (paths in TECHNICAL_SPEC §1) | A |

## Downloaded and generated files

| File (under `data/`) | Origin | sha256 | Bytes | Licence |
| -------------------- | ------ | ------ | ----- | ------- |
| `bsi/IFC4X3_ADD2_Infra-Plumbing.ifc` | S1, unmodified | `a6ac7a0f4c80c91f04a1a66b73899be064f9c3992b2e886c92f0e3145c0ca50f` | 350 835 | CC BY 4.0 © buildingSMART International Ltd. |
| `bsi/IFC4X3_ADD2_Building-Hvac.ifc` | S1, unmodified | `22891586f153793d098811caec8a510cd404f6c2f1979fb329eeeebc3f475642` | 111 304 | CC BY 4.0 © buildingSMART International Ltd. |
| `bsi/LICENSE-buildingSMART-Sample-Test-Files.txt` | S1 `LICENSE` | `3e20c50b6edfdb4be207f64495586115d0574c8394538109d74f79e1d8976d18` | 317 | — |
| `reference/sc-dat-01-reference.ifc` | generated, `scripts/make_reference_ifc.py … sc-dat-01` (IfcOpenShell API) | `40b631a959a32211147d6495ce1a20e6bb1cf70d927d5e123dab016aa630b218` | 17 080 | this repo |
| `reference/sc-dat-02-reference.ifc` | generated, `… sc-dat-02` | `dd5b8b1f538f46ab6cbf13547351b69b536d36603c5fc971cb5f3f54fced83f1` | 17 077 | this repo |
| `reference/sc-dat-02-negative.ifc` | generated, `scripts/make_negative.py` (self-connected port, USERDEFINED valve without ObjectType, duplicate tag) | `13cc84acc80e8e14b502ae782978c8409163183bfe560ffd72f43950f0429857` | 17 154 | this repo |
| `reference/sc-dat-0*-*.stats.json`, `bsi_sample_stats.json` | `scripts/plant_stats.py` | see `git` | < 2 kB each | this repo |
| `reference/sc-dat-02-negative.validate.json` | `ifcopenshell.validate --rules --json` output (2 errors) | `1e30b354290e1ed8bf48bd10f47c4f58303625df66ef2e38a1d28047dda75ec9` | 1 577 | this repo |
| `reference/plant-handover.ids` | written for this pack (IDS 1.0) | `1a8def55c95366f2dfa31a35bebaf67ca7009000d12b12408d8845649370451d` | 2 283 | this repo |
| `reference/ids_results.json` | `scripts/run_ids.py` (ifctester) | `2815fc825c384325d7c2da26a6f6d23344d0adeac72cc0d0b013f84ed036b919` | 2 025 | this repo |
| `reference/equipment-list-sc-dat-01.xlsx`, `…-edited.xlsx` | `scripts/make_xlsx_fixtures.py` (openpyxl) | `69fe42b7…06c3`, `cfd59f91…27d9` | 5 201, 5 203 | this repo |
| `reference/ifc4x3_add2_plant_schema_facts.json` | `scripts/schema_facts.py` (S3) + cross-check against S2 | `5db18f4b1b13111803f8a27dbf0349e51a0c366166778c06d1f46ecb43bd428c` | 34 410 | facts from CC BY-ND / LGPL sources, attributed |
| `tag_format_cases.json`, `sc_dat_01_reports_expected.json` | closed forms of this pack (formats and plan inputs; derivations inside) | `46950d39…7b`, `7c1b2e97…27b` | 4 887, — | this repo |

The reference IFC files carry random GlobalIds (IfcOpenShell `guid.new`), so a regenerated file differs in bytes but
not in the counts the VCs gate on. Regenerate with:

```bash
python3 -m venv /tmp/v && /tmp/v/bin/pip install ifcopenshell==0.9.0.post1 ifctester==0.9.0 openpyxl==3.1.5 pytest
/tmp/v/bin/python -I data/scripts/make_reference_ifc.py out.ifc sc-dat-01
/tmp/v/bin/python -I -m ifcopenshell.validate --rules out.ifc     # 0 error(s) found
/tmp/v/bin/python -I data/scripts/plant_stats.py out.ifc
```

## Not verified (never gates)

- CFIHOS register columns, property codes and class identifiers; CFIHOS 2.0 release status (S10).
- ISO 15926 parts beyond 2 / 4 / 8 / 12 and their current status (S11).
- How the Plant 3D import review (accept / reject per change) presents the diff (S7, topic title only).
- Smart 3D's own hierarchy names beyond the E3D mapping table (S9).
- The official IFC 4.3 HTML pages (blocked): the port-connectivity text was read in the development repository (S2);
  the attribute and rule facts were confirmed by the compiled ADD2 schema (S3).
