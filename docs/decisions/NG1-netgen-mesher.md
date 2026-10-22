# NG1 — Netgen replaces Gmsh as the FE mesher (no GPL code in llull)

**Status:** decided and built 2026-10-22 (owner task "replace Gmsh with Netgen as llull's finite-element mesher, so no GPL code is linked
into llull"), branch `feat/netgen-mesher`. Rule C7 (best-suited stack, record the choice); follows RS1 §2 (native sidecars) and LC1 (local
only). Supersedes the Gmsh rows of SV1 and the Gmsh mesher of PR #106 (`llull-gmsh`, deleted).

## 1. Decision

`fea_mesh` keeps its sidecar, `llull-mesh` (solver/bins/llull-mesh), and its request / response protocol byte for byte (server/src/fea and
every FEA command unchanged apart from wording and the install hint). Inside, Gmsh is replaced by **Netgen 6.2.2604** (nglib + ngcore,
shared libraries) behind a new cxx facade crate, `solver/crates/llull-netgen`, built against the **same OCCT 7.9.2 prefix** the native kernel
uses. Gmsh, its loader crate `llull-gmsh`, its CI steps and its bundling are gone.

## 2. Licences (why Netgen, and what we must keep doing)

| Component | Licence | How llull uses it | Obligation |
| --- | --- | --- | --- |
| Gmsh 4.x (before) | GPL-2.0-or-later | `llull-mesh` loaded `libgmsh` at run time (dlopen) and called its C API | GPL: a program built to call a GPL library is, in the FSF's reading, a combined work, whether linked or dlopened. Incompatible with an `UNLICENSED` (proprietary) llull. |
| Netgen 6.2 (now) | LGPL-2.1 (`LICENSE`, upstream repo) | `llull-mesh` links `nglib` + `ngcore` **dynamically** (shared libraries, unmodified) | LGPL-2.1 §6(b): a "work that uses the Library" may be distributed under our own terms when it uses a suitable shared-library mechanism; we ship the libraries' licence, notice and source location, and must allow users to replace them (relink not needed: drop-in shared libraries). |
| OCCT 7.9.2 | LGPL-2.1 + Open CASCADE exception | already linked dynamically by `llull-kernel` (RS1 §2 rule 7); now also by `llull-mesh` | unchanged; same prefix, same notices. |
| zlib 1.3.1 | zlib licence | linked statically into `nglib` (Netgen needs it for its file formats) | keep the licence text (bundled as `Netgen-zlib-LICENSE.txt`). |

Points the owner should be aware of (not legal advice):

- **Header code.** The facade (`llull-netgen/cpp/*.cxx`) compiles against Netgen's C++ headers (`OCCGeometry`, `Mesh`, `MeshingParameters`,
  ngcore arrays), so some inline / template code from those headers ends up in `llull-mesh` itself. LGPL-2.1 §5 lets object code use
  header material such as data-structure layouts, accessors and small inline functions freely; for anything beyond that, the executable is
  still a work that uses the library and §6 applies. OCCT's exception covers the same situation for OCCT; Netgen has no such exception.
- **§6 terms.** For a work under §6 the LGPL requires that our licence terms for `llull-mesh` "permit modification of the work for the
  customer's own use and reverse engineering for debugging such modifications". The bundled `Netgen-NOTICE.txt` states it; **llull's own
  licence (currently `UNLICENSED`) must not forbid it for `llull-mesh`** when llull is distributed. The same already applied to OCCT.
- Netgen is built from the unmodified upstream release tarball (sha256-pinned); the build recipe is public in our tree
  (`solver/scripts/build-netgen.mjs`), so "the source of the library" requirement is met by pointing at the upstream tag + our recipe.

Alternatives looked at: TetGen (AGPL / commercial — no), CGAL 3D mesher (GPL / commercial — no), fTetWild (MPL-2.0, but no B-rep face
traceability and no OCC geometry), MMG (LGPL, remesher, needs an initial mesh). Netgen is the one LGPL mesher that meshes OCCT B-reps
directly and keeps every element on its B-rep face.

## 3. What was built

- `solver/scripts/build-netgen.mjs`: pinned Netgen release tarball (`v6.2.2604`, sha256 `0a614193…954c`) + zlib 1.3.1 (sha256
  `9a93b2b7…df23`), one cmake recipe (no Python, no GUI, no superbuild, OCC on, STL on), shared `nglib` / `ngcore`, built against the OCCT
  prefix of `build-occt.mjs` (rebuilt whenever that prefix's stamp changes), per-user default prefix next to OCCT's
  (`%LOCALAPPDATA%\llull\netgen-6.2.2604`, `~/.cache/llull/...`), stamp `llull-netgen.json`, licence texts. Linux / macOS: the libraries
  find OCCT at `$ORIGIN/../../occt/lib` (the desktop bundle) and at the OCCT prefix (dev).
- `build-occt.mjs`: `TKDESTL` added (Netgen's OCC module links it); a prefix missing a listed toolkit is rebuilt (the stamp records them).
- `solver/crates/llull-netgen`: cxx facade. Rust sees an opaque `Shape` (STEP import + scale, planar faces fragmented together, solids
  fragmented together with their owners, defeaturing, trimmed face / edge distances, face area / centroid / radius, size sample points)
  and `mesh` / `mesh_stl` returning first-order points, tets with their solid, surface elements with their **B-rep face number** and
  segments with their **B-rep edge number** (Netgen's own face / edge maps, so numbering cannot drift). Every C++ / OCCT exception is an
  `Err`; Netgen's global state is serialised behind one lock; its console output is discarded (stdout carries the response).
- `solver/bins/llull-mesh` on top of it (same modules, Gmsh calls replaced):
  - solids from STEP: exact B-rep, targets resolved on B-rep faces / edges (trimmed distances, same 1e-3 / 1e-6 diagonal thresholds and
    messages as before), kernel face map TR-FEA-32 by area + centroid on the same faces (`faceMap[].tag` = Netgen / B-rep face number);
  - solids from STL (Manifold kernel): Netgen STL meshing; facets classified into face regions with the 40° angle exactly as before; a mesh
    face element belongs to the region of its nearest input facet (`llull-bvh`);
  - order 2: straight mid-edge nodes added by llull-mesh (no curving), C3D10 node order as before; every tet oriented to a positive volume;
  - conformal bonding: OCCT general fuse (BOPAlgo_Builder) of all parts into one shape, meshed once; a solid owned by two parts =
    `FEA_BONDING_OVERLAP` as before;
  - defeaturing: OCCT `BRepAlgoAPI_Defeaturing` (Gmsh's `occ.defeature` was the same OCCT algorithm), same selection rules;
  - local sizes: per-face / per-edge Netgen maxh + size points over the refined faces / edges (Netgen's local-size octree, grading 0.3);
    a refined point seeds a ball of radius 1.5 × globalSize (the reach of the old Ball field) at the requested size;
  - global size: Netgen maxh = **0.9 × globalSize** for volume meshes, 1.0 × for shells (calibration, §4).
- **Shells / plane stress (midsurface parts): fully supported, nothing refused.** Planar OCCT faces fragmented together, Netgen surface mesh;
  `shell_quad`: Netgen quad-dominant mesh with every element split into quads (a quad into 4, a triangle into 3), i.e. all quads like the old
  recombine + subdivision; S3/S6/S4/S8 and CPS*; orientation by the face normal; facesNear / edgesNear / pressure side as before.
- Host: `INSTALL_HINT.mesher`; `llull-mesh` that starts but cannot load its Netgen / OCCT libraries (Windows `STATUS_DLL_NOT_FOUND`, Linux /
  macOS loader messages) answers `FEA_TOOL_MISSING` (`librariesMissing`, server/src/fea/nativeMesher.ts). New analyses record
  `mesh.mesher: 'netgen'`; `'gmsh'` stays a valid value so older documents load (their input hash is unchanged).
- Desktop bundle (`desktop/scripts/prepare-native.mjs`): `llull-mesh` + `nglib` / `ngcore` (Windows next to the exe, else `netgen/lib`) +
  OCCT whenever the kernel or the mesher is bundled; `Netgen-NOTICE.txt` (source, sha256, relink / replace statement), LGPL text, authors,
  zlib licence; the smoke test requires `(Netgen 6.2.2604, OCCT 7.9.2)` with no build-machine search path. CI builds and caches Netgen in
  both native jobs; `llull-mesh` and `llull-netgen` build under `LLULL_NATIVE_KERNEL=1` (no longer default members: they link native libraries).

## 4. Parity with Gmsh (measured 2026-10-22, Windows 11, MSVC 14.44)

Corpus: the 73 mesh requests the server FE suites send (captured while they ran on Gmsh 4.15.2), replayed through both meshers.

- Every request that Gmsh refused is refused with the **same code and message** (ambiguous / unresolved targets, bonding overlap,
  bonding without STEP, malformed request); every request Gmsh meshed, Netgen meshes.
- Element counts, Netgen / Gmsh (solid meshes, maxh 0.9 × globalSize): ≥ 3000 Gmsh elements: median 1.09, 19 / 19 within ±25 %
  (nodes: median 1.10, 17 / 19); 300–3000: median 0.98, 14 / 18 within ±25 %; < 300 (parts only 2–3 elements across): median 0.32 — Gmsh
  over-fills tiny domains (193 tets in a 10 mm cube at size 5), Netgen stays near the nominal size. A plain box is the other outlier
  (box 20 × 10 × 10 at size 1.5: 5144 vs 3029). Shells: 1.00–1.01.
- `mesh_requests.rs` pins two references within ±25 % (plate with hole, order 2: Gmsh 15 451 elements / 25 756 nodes; quad shell 40 × 20:
  3200 / 3321).
- Server FE suites (`server/tests/fea*.test.ts`, `nativeMesher.test.ts`, real CalculiX 2.21 + native kernel): Gmsh 111 / 112, Netgen
  112 / 113 (one test added); the only failure on both is the pre-existing VC-TMC-05 / VC-TMC-50 (`feaThermomech.test.ts`: the mapped
  thermal result reads stale). Two judges failed on the first Netgen run and were mesher bugs, fixed: the clamped edge of an all-quad S8
  shell missed the quarter-point nodes of split edge segments (8.6 % deflection error), and point refinements were seeded too sparsely
  (NAFEMS T1 at h 0.02).
- Same request, same mesh (single-threaded Netgen; tested).

## 5. Differences that remain

- Netgen elements are not Gmsh's: node numbering, element shapes and exact counts differ; results agree within the suites' judges.
- `facetedParts` meshes (STL) are Netgen STL meshes: Netgen detects its own edges (dihedral 40° here) and projects nodes on the facets.
- `set_mesh_controls.optimize` (`default | netgen | high_order | none`) was never read by llull-mesh (Gmsh or Netgen); Netgen always runs
  its own optimisation (3 passes). Unchanged.
