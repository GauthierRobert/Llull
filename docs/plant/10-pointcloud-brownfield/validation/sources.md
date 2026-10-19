# Gap 10 SCN — Sources

Accessed 2026-10-18. **Network limits during authoring.** Only PyPI (`pypi.org`, `files.pythonhosted.org`), the npm registry and
some `raw.githubusercontent.com` paths could be downloaded. `astm.org`, `asprs.org`, `libe57.org`, vendor sites (Autodesk, AVEVA,
Hexagon, Leica) and journal sites returned 403 or did not resolve. The shared web-search budget for this session was used up
before this pack began, so no search-engine extracts were collected. As a result:

- Every **format** fact that gates a VC was checked by running two independent readers on real files: our own reader
  (`data/tools/*_own_*.py`) and the reference library (pye57 / libE57Format, laspy / lazrs). For E57, the libE57Format unit-test
  assertions add a third check.
- Every **algorithm** expectation is a closed form computed on synthetic data. A published reference algorithm was run in a
  scratch venv to show the tolerance can be met (`data/reference_check_output.json`).
- Vendor product behaviour (Plant 3D, ReCap, AVEVA, CADWorx, Smart 3D, EdgeWise) is **grade C**: it comes from the authors'
  background knowledge and was not re-read in this session. No requirement or VC depends on it.

Grades: **A** = primary source read, reference code run, or ≥ 2 independent sources agree. **B** = one secondary extract.
**C** = located but not confirmed. Only A values and cited closed forms gate.

## Sources

| Id  | Source | What was taken | How it was checked | Grade |
| --- | ------ | -------------- | ------------------ | ----- |
| S1  | ASTM E2807-11(2019)e1, *Standard Specification for 3D Imaging Data Exchange, Version 1.0* (E57), catalogue page https://www.astm.org/e2807-11r19e01.html (URL as cited by the libE57Format README; the page itself was not reachable) | Format scope only: E57 = XML tree + binary sections in CRC-protected pages. No clause text is quoted. | Facts used (48-byte header with `ASTM-E57` signature, 1024-byte pages each ending in a big-endian CRC-32C, XML section at `xmlPhysicalOffset`, `data3D/points@recordCount`, ScaledInteger `scale`/`offset`, pose = unit quaternion w,x,y,z + translation) were confirmed by our reader, which parses all 12 files, and by libE57Format 3.x sources (S2). | A (via S2 + own reader) |
| S2  | libE57Format (A. Maloney, fork of E57RefImpl 1.1.332), Boost Software License 1.0, bundled in the pye57 0.4.19 sdist (`libE57Format/`); test data repository https://raw.githubusercontent.com/asmaloney/libE57Format-test-data/main/ (`self/`, `3rdParty/` CC0 1.0; `reference/` from libe57.org under the "Test Data License", text in `data/licenses/`) | 8 E57 files; unit-test assertions `test/src/test_SimpleReader.cpp` (ColouredCubeFloat 7 680 points, GUID "Coloured Cube File GUID"; bunnyDouble / bunnyInt32 30 571 points; ZeroPoints 0; empty 0 scans; bad-crc throws unless `ChecksumNone`) | Assertions read in the source. The same counts were reproduced by our reader and by pye57 (`data/e57_reference.json`). | A |
| S3  | pye57 0.4.19 (D. Caron), MIT, https://pypi.org/project/pye57/ (sdist and manylinux wheel); test files from https://raw.githubusercontent.com/davidcaron/pye57/master/tests/test_data/ | 2 small E57 files (`testWithNormals`, `translationWithoutRotation`). `test.e57` (4 scans, georeferenced poses) and `testSpherical.e57` (spherical coordinates, 370 530 points) are recorded by URL and hash only. | Installed from the wheel in a scratch venv; `data/tools/e57_pye57_reference.py` was run. `tests/test_main.py` asserts 4 scans and 281 300 points in scan 0 of `test.e57`; our reader agrees. | A |
| S4  | laspy 2.7.0 (G. Brown, H. Butler, T. Montaigu), BSD-2-Clause, sdist https://pypi.org/project/laspy/ `tests/data/`; lazrs 0.8.2 (MIT) for LAZ decoding | 10 LAS / LAZ files covering LAS 1.1–1.4, PDRF 1/3/4/6, EVLR, extra bytes, LAZ | `data/tools/las_own_header.py` (our reader) and laspy (points decoded) agree on every point count. Header bounds were compared with the decoded data (`data/las_reference.json`). | A |
| S5  | ASPRS LAS Specification 1.4 R15, maintained at https://github.com/ASPRSorg/LAS (README read; published at https://lasformat.org) | Public-header layout (signature `LASF`, version at byte 24, point-data offset at 96, PDRF at 104, scale at 131, offset at 155, max/min at 179, 1.4 64-bit point count at 247), PDRF 0–10, X = Xrecord·scale + offset | The README was read. The header layout was checked by our reader, which agrees with laspy on 10 files. The rendered specification itself was not reachable. | A (layout, via S4 + own reader) |
| S6  | COPC — Cloud Optimized Point Cloud specification 1.0 (Hobu, Inc.), https://raw.githubusercontent.com/copcio/copcio.github.io/main/README.md | A COPC file is a LAZ 1.4 file with PDRF 6/7/8 holding a clustered octree; `info` and `hierarchy` VLRs; modelled on EPT | Read directly | A |
| S7  | Potree / PotreeConverter 2.0 (M. Schütz), BSD-2-Clause, https://raw.githubusercontent.com/potree/PotreeConverter/develop/README.md; Schütz M., *Potree: Rendering Large Point Clouds in Web Browsers*, TU Wien 2016; Schütz, Ohrhallinger, Wimmer, *Fast Out-of-Core Octree Generation for Massive Point Clouds*, CGF 2020 | Octree LOD for streaming; Poisson-disk or random sampling per level; 3-file output | README and licence read; papers cited from the README, not read | A (README) / C (paper contents) |
| S8  | Schnabel R., Wahl R., Klein R., *Efficient RANSAC for Point-Cloud Shape Detection*, Computer Graphics Forum 26(2), 2007 | Primitive from minimal oriented samples (cylinder from 2 points + normals); score = inliers with distance ε and normal deviation α | Closed form implemented and run (`data/tools/reference_check.py`, CYL-A/B/C pass) | A (closed form + run) |
| S9  | Lukács G., Martin R., Marshall D., *Faithful least-squares fitting of spheres, cylinders, cones and tori for reliable segmentation*, ECCV 1998; Eberly D., *Fitting 3D Data with a Cylinder* (Geometric Tools) | Orthogonal-distance residual d = ‖(x−c)×a‖ − r; minimal 5-parameter cylinder | Residual used by the LM refinement and by the CRLB derivation | A (closed form) |
| S10 | Besl P. J., McKay N. D., *A Method for Registration of 3-D Shapes*, IEEE PAMI 14(2), 1992; Chen Y., Medioni G., *Object modelling by registration of multiple range images*, IVC 10(3), 1992; Rusinkiewicz S., Levoy M., *Efficient variants of the ICP algorithm*, 3DIM 2001; Chetverikov D. et al., *The Trimmed Iterative Closest Point algorithm*, ICPR 2002 | Point-to-point ICP, point-to-plane ICP, rejection and trimming | Point-to-point ICP with median-based rejection run on the bunny (ICP-A pass) | A (closed form + run) |
| S11 | Horn B. K. P., *Closed-form solution of absolute orientation using unit quaternions*, JOSA A 4(4), 1987; Umeyama S., *Least-squares estimation of transformation parameters between two point patterns*, IEEE PAMI 13(4), 1991 | Closed-form rigid transform from ≥ 3 non-collinear correspondences (SVD form with reflection guard) | Implemented and run (TGT-A pass) | A (closed form + run) |
| S12 | Ericson C., *Real-Time Collision Detection*, Morgan Kaufmann 2005, §5.1.5 (closest point on a triangle) | Point-to-triangle distance by Voronoi regions | Implemented; C2M-A distances are exact to 1e-12 | A (closed form + run) |
| S13 | Kay S. M., *Fundamentals of Statistical Signal Processing: Estimation Theory*, Prentice Hall 1993, ch. 3 (Cramér–Rao lower bound; for Gaussian noise, cov ≥ σ²(JᵀJ)⁻¹) | Derivation of the cylinder-fit tolerances (5 × the CRLB standard deviation) | Standard closed form; Jacobian computed by `gen_synthetic.py` | A (closed form) |
| S14 | Lague D., Brodu N., Leroux J., *Accurate 3D comparison of complex topography with terrestrial laser scanner: application to the Rangitikei canyon (N-Z)* (M3C2), ISPRS J. 82, 2013; Girardeau-Montaut D. et al., *Change detection on point cloud data acquired with a ground laser scanner*, ISPRS WG III/3, 2005 (C2C / cloud-to-mesh in CloudCompare) | Context for deviation methods (C2M, M3C2) | Bibliographic only | C |
| S15 | EN 10220 / ASME B36.10M outside diameters as already tabulated in llull `packages/domain-aec/src/industrial/piping/pipeSizes.ts` (DN 50 → 60.3 mm, DN 100 → 114.3 mm, DN 200 → 219.1 mm; snap tolerance `OUTSIDE_DIAMETER_TOLERANCE_MM` = 1.5 mm) | Synthetic radii and the DN snap expectation | Values are llull's existing table, owned by sibling gap 01-piping-specs-catalog; no new number is introduced here | A (llull table; sourcing owned by 01 PSC) |
| S16 | IPE 300 dimensions h 300, b 150, tw 7.1, tf 10.7 mm as already tabulated in llull `packages/domain-aec/src/steel/profiles.ts` (EN 10365 series) | Synthetic steel section STL-A | llull's existing catalogue | A (llull table) |
| S17 | Point Cloud Library (BSD-3), https://raw.githubusercontent.com/PointCloudLibrary/pcl/master/LICENSE.txt; Open3D (MIT), https://raw.githubusercontent.com/isl-org/Open3D/main/LICENSE; CloudCompare (GPL-2.0-or-later), https://raw.githubusercontent.com/CloudCompare/CloudCompare/master/license.txt | Licence of each open-source implementation considered (whether llull may link or bundle it) | Licence files read | A |
| S18 | npm registry: `laz-perf` 0.0.7 (Apache-2.0, "LAZ implementation compiled to WASM"), `copc` 0.0.9 (MIT), `potree-core` 2.0.15 (MIT), https://registry.npmjs.org/ | Candidate browser-side LAZ / COPC / LOD libraries and their licences | Registry metadata read | A (licence and version) |
| S19 | Vendor workflows: Autodesk ReCap (RCP project / RCS scan, proprietary), AutoCAD Plant 3D point-cloud attach and snapping, Navisworks, AVEVA E3D with LFM / Laser Modeller, Hexagon Smart 3D, CADWorx with Leica CloudWorx, ClearEdge3D EdgeWise automatic pipe extraction | Context only (FUNCTIONAL §2) | Not re-read in this session (sites blocked, search budget exhausted) | C |

## Downloaded files kept in `data/`

Every file keeps its upstream name. Licence texts are in `data/licenses/`. Total size is about 3.8 MB.

| File | Bytes | sha256 |
| ---- | ----- | ------ |
| `data/e57/ColourRepresentation.e57` (S2 `3rdParty/las2e57`, CC0) | 9216 | `cffe21f05e254994fea0d1444b574d160746d0743e515c3837b3721a4d97a5e6` |
| `data/e57/ColouredCubeDouble.e57` (S2 `self`, CC0) | 210944 | `58e7cfbb3e9cef777c4cd8f52aff2ff704fcf6dd3aea4b420430adaa1cdb978d` |
| `data/e57/ColouredCubeFloat.e57` (S2 `self`, CC0) | 118784 | `6dbf7972b358bd7dd0864c7893a4aa7b61a339fd6ee27c71b3031f763c977d33` |
| `data/e57/ZeroPoints.e57` (S2 `self`, CC0) | 2048 | `d0a44d8b97069cf5c52ca64d2495c5086717faaa4262066abb24c9bf39089051` |
| `data/e57/bad-crc.e57` (S2 `self`, CC0) | 1024 | `64d1b03f9459ae2a0aa9b10f5561696c470037ce760ba6e3b1844f9b90c54516` |
| `data/e57/bunnyDouble.e57` (S2 `reference`, libe57.org Test Data License) | 743424 | `5ec10af7a8b4cf7778d247ea20b2c3058e6488b55ef102ae187373d5cbe8b056` |
| `data/e57/bunnyInt32.e57` (S2 `reference`, libe57.org Test Data License) | 374784 | `6b3696c452a2dd0e325ab30b1ad28a40de87f1a56cd9d8a24ad81389b606c205` |
| `data/e57/empty.e57` (S2 `self`, CC0) | 1024 | `ab43ff6ac95d043eb012641ce99cc9281c54b5a50acca365e89d3da0ceea7d58` |
| `data/e57/testWithNormals.e57` (S3, MIT) | 3072 | `7a4ae0baa7f9704e0d3773be567642d412c387adf7b3c6f16dc1b3b2bf73ca1b` |
| `data/e57/translationWithoutRotation.e57` (S3, MIT) | 3072 | `72e1a6923f8898841d8d24aa2d7679afc3fe7cc5a40e85c75a8fc993c02476f4` |
| `data/las/1_4_w_evlr.las` (S4, BSD-2) | 32381 | `7123dad6ee56dfb52220a4b3fe22a0b92e62181557db7fbe915789b8d766139a` |
| `data/las/1_4_w_evlr.laz` (S4, BSD-2) | 8948 | `c16e65ec5c704f0a60d90b154cf21b1df9e5cd9b40cec58b2488754a0ced1a5b` |
| `data/las/autzen_trim.laz` (S4, BSD-2) | 603353 | `75867b3e75cfc3c2e96da9f753c04c9fbaa6a59468dea13e2859f3109b38bd66` |
| `data/las/extrabytes.las` (S4, BSD-2) | 66354 | `b8daf5a96114ac86c42fff13e07abdc736e00e1eb34188506a6895b1126ed75b` |
| `data/las/plane.laz` (S4, BSD-2) | 59344 | `2251306106cd2aaaf4d67b30a81704b421c7d46de0e49eebcd2d87efc00b5948` |
| `data/las/simple.las` (S4, BSD-2) | 36437 | `a0570ef57b685b77a6d3e3992cbdfeecdb2c3065d3780bbeaba490818258b734` |
| `data/las/simple.laz` (S4, BSD-2) | 18217 | `87ac5d2e8edb6cd3c63f1dd1b982d76b1b3c23ca634658ac6c658e1a70e73e71` |
| `data/las/simple1_1.las` (S4, BSD-2) | 30047 | `63d6a138863a75617161accc0e0b918bdebd6f365c9900573af66724be5b9848` |
| `data/las/simple1_3.las` (S4, BSD-2) | 62888 | `6753c0da6e89b9e9e1e866946746dadb2b2c31b7eb8fd4602bcaf6a1d1ad2cea` |
| `data/las/test1_4.las` (S4, BSD-2) | 32305 | `f4e840920885fc175ab90c0a50778165e64e3f9ccb049ea5e360f3e30bb932b1` |

Generated by this pack (`data/tools/gen_synthetic.py`, numpy 2.5.4, fixed seeds; re-running it reproduces every byte):

| File | Bytes | sha256 |
| ---- | ----- | ------ |
| `data/synthetic/clh-a.csv` | 508951 | `9dc5c064ce0ec48a5fbaf270a319f076f8bc714a10b6e95769b51d819ac9db23` |
| `data/synthetic/cyl-a.csv` | 108012 | `43c0812cee6f194dbfea984b53b870404bd7b8257c6b9769f9b2320b96cbfe61` |
| `data/synthetic/cyl-b.csv` | 222954 | `70c7707cbe1f36183db83f1e59068d9b533dd1e4dc43d81d45c776ffbb463297` |
| `data/synthetic/cyl-c.csv` | 46473 | `65fa2380920be713fd6c4ee44b2d471df61647dcddf96e7dfbc37bf540d63834` |
| `data/synthetic/elb-a.csv` | 177267 | `9ebd7457eb3b6f1a23d5abbd7dbb0c8fb0df063e3f003db5077d65cfc08b8adb` |
| `data/synthetic/stl-a.csv` | 216012 | `5d4c32da98c6634a34426bf1400cdb3e8b0a12aee25abe231b07745958b16427` |
| `data/synthetic/tgt-a-station1.csv` | 52962 | `027ee68e896b5b26b6c7a11e766381fcc7267929d44d1f1578153f1497b8b03b` |
| `data/synthetic/tgt-a-station2.csv` | 55257 | `1b413e40aa5a01c29e6e8df5c24402ca276164efd4b394f0a3e529ae93675ae8` |

## Not redistributed (URL and hash only)

| File | Why | URL | Bytes | sha256 |
| ---- | --- | --- | ----- | ------ |
| `test.e57` (pye57, MIT) | 13.7 MB, over the pack budget | https://raw.githubusercontent.com/davidcaron/pye57/master/tests/test_data/test.e57 | 13723648 | `9d5ab50157b27cb3eb501b7e3ff8223c1dad03a90d149d7b709b87d5de683bb8` |
| `testSpherical.e57` (pye57, MIT) | 5.2 MB | https://raw.githubusercontent.com/davidcaron/pye57/master/tests/test_data/testSpherical.e57 | 5168128 | `268b42e69bbbad85703933f24626b97736ec703b0a7c34550dcb6ed0830317e3` |
| `simple1_4.las` (laspy, BSD-2) | 0.8 MB, redundant with `test1_4.las` | laspy 2.7.0 sdist `tests/data/` | 814388 | see `las_own_header.py` output (not kept) |

The extracted numbers for `test.e57` and `testSpherical.e57` (scan counts, point counts, poses) are in
`data/e57_reference.json` → `notRedistributed`.

## Could not reach / not verified

- ASTM E2807 clause text (paywalled; site blocked). Only the facts our reader proves on real files are used.
- The rendered ASPRS LAS 1.4 R15 PDF at lasformat.org (blocked). The header layout is proven by the two readers.
- libe57.org data page (DNS failure). The `reference/` files came through the libE57Format test-data mirror, which carries the
  libe57.org licence.
- A public scanned plant / pipe dataset under 5 MB with a published ground truth was not found within the network limits.
  ETH / TU Delft / NavVis / Leica sample sets were unreachable. Real-scan pipe extraction is therefore validated only on
  synthetic data (U5 in README "What could not be verified").
- Vendor documentation (S19).
