# Gap 12 CFD — Local GPU flow simulation (CFD): functional specification

Status: specification written 2026-10-18, not implemented. Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md). Operator model:
[`../AGENT_FIRST.md`](../AGENT_FIRST.md).

**Owner directives (2026-10-18), binding on this pack:**

1. **CLI only.** The `llull` CLI is the agent surface. MCP will be removed from llull, so this pack plans no MCP tool or toolset.
   Where `TEMPLATE.md` / `AGENT_FIRST.md` say "UI + MCP + CLI", read "UI + CLI".
2. **Local only, never cloud.** Every solve runs on the user's machine (desktop app, or CLI on a document file). No remote compute,
   no upload of geometry or results (AF-41).
3. **GPU first.** The solvers run on the local GPU when there is one, and fall back to the CPU otherwise. Other languages than
   TypeScript are allowed for speed and quality.

This pack replaces the "CFD hand-off to OpenFOAM / SU2" items of 10 AER (FR-AER-13, M4) and 11 FLD (FR-FLD-11, M5). Both now point here.

## 1. Summary

llull can say how much lift and drag a wing or a cyclist has with engineering formulas (10 AER) and how a nozzle performs in 1D
(11 FLD). It cannot show **the flow itself**: where the air speeds up, where shocks sit, where it separates, how it moves around a
group of buildings. That picture (a body coloured by Mach or pressure, with streamlines around it) is what an aircraft, launcher,
drone, car, cyclist or building designer expects from a "wind tunnel in the computer", and what tools such as Autodesk CFD,
SimScale, Ansys Discovery or SolidWorks Flow Simulation give.

This gap adds a **local, GPU-accelerated CFD capability** driven from the CLI:

- **Geometry preparation** that turns any llull model into a valid flow body without manual meshing: one watertight surface,
  small features found and reported, openings tagged, a flow domain sized by sourced rules, a memory estimate before the run.
- **Two GPU solvers on a Cartesian grid** that need no body-fitted mesh:
  - **low speed** (Mach < 0.3: buildings, cars, cyclists, drones): a lattice-Boltzmann solver with LES turbulence;
  - **compressible** (Mach 0.3 to 5: aircraft, launchers, shocks): an Euler finite-volume solver on cut cells with adaptive refinement.
- **Results** as numbers first (forces, coefficients, peak Mach, separation, speed-up ratios) and as pictures: surface colours with a
  legend, streamlines, slices, in the viewport and as PNG files from the CLI.

## 2. Aerospace, building and sport context

| Domain | Typical question | Tool used today | What llull adds |
| ------ | ---------------- | --------------- | --------------- |
| Aircraft / UAV conceptual design | where are the shocks at Mach 0.85? Is the flow attached on the wing at 8°? | SU2, OpenFOAM, Cart3D, Ansys Fluent, Star-CCM+ | an Euler solution of the CAD model in minutes on a laptop GPU, with no meshing step |
| Launcher / re-entry body | bow shock position and stagnation pressure at Mach 2–5; pressure on fins | Cart3D, SU2, hand formulas (NACA 1135) | the same picture plus the closed-form checks that 11 FLD already validates |
| Space-shuttle-like reference images (the owner's examples) | surface Mach colour map and streamlines of a winged body at supersonic speed | commercial CFD post-processors | the same output, from the CLI, on the local GPU |
| Buildings / urban wind | pedestrian wind comfort, façade pressures, wind around a group of towers | wind tunnel, OpenFOAM, SimScale LBM, Autodesk CFD | low-speed LBM on the building model of the AEC plugins, domain sized by COST 732 / AIJ rules |
| Cars, cyclists, drones | drag at speed, wake, effect of a position or a fairing | wind tunnel, OpenFOAM, SimScale | drag and the flow picture on the CAD model; CdA feeds 10 AER `road_load_power` |

## 3. Personas and user stories

- **Operator: an AI agent driving the `llull` CLI** (AF-01..05). "Simulate this body at Mach 2, 2° angle of attack, and tell me the
  drag coefficient and where the highest pressures are." The agent creates a case, runs the preparation check, solves, reads `data`,
  and saves a PNG to show the owner.
- **Owner: not an engineer** (a drone founder, an architect, a cyclist). They want a picture and a sentence on how reliable it is.
  Every result names its solver, its resolution, its convergence state and what it does not model (AF-31, AF-35, AF-36).
- **Qualified reviewer**: an aerodynamicist or wind engineer who uses a result for a design load or a permit. CFD results never
  claim certification value; any result marked as a design load carries `reviewRequired: true` (AF-33).

User stories:

1. As an agent, I run `cfd_prepare` on an assembly and get, before any solve, a pass / warn / fail list: watertight or not, which
   edges are open, which features are smaller than two cells, the domain size, the cell count and the GPU memory needed (FR-CFD-01..06).
2. As an agent, I solve a winged body at Mach 2 and get Cd, Cl, Cm, the peak surface Mach and the stagnation pressure, plus a PNG of
   the body coloured by Mach with streamlines (FR-CFD-10, 20..24).
3. As an architect owner, I ask "is it windy at the entrance of my two towers?" and get the speed-up ratio at 1.5 m above the ground
   at the points I chose, and a picture (FR-CFD-11, 23).
4. As a cyclist owner, I compare two positions and get CdA for each from the flow solution, which `road_load_power` turns into watts
   (FR-CFD-11, 21).
5. As an agent, I check that a result is trustworthy: the residuals fell, the forces stopped moving, and three resolutions agree
   within the reported grid-convergence index (FR-CFD-30..32).

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | `cfd_create_case` / `cfd_prepare` (watertight union, checks, small-feature report, domain sizing, memory estimate); native GPU sidecar (Rust + wgpu: Vulkan / Metal / DX12; CPU fallback); low-speed LBM D3Q19 with Smagorinsky LES, half-way bounce-back walls, uniform grid with nested refinement boxes; compressible Euler cut-cell solver, HLLC + MUSCL, octree refinement, local time stepping for steady states; forces and coefficients; surface fields (Cp, Mach, speed); streamlines from rakes; slices; viewport overlay with legend; `render_view` PNG; progress, timeout, cache by content hash; stale results after geometry edits |
| V1 | cumulant collision (D3Q27) and interpolated bounce-back walls; atmospheric boundary-layer inlet and pedestrian comfort maps; automatic defeaturing through 07 FTR feature recognition; adaptive refinement driven by error indicators in the LBM solver; time-accurate runs with animations; surface "oil-flow" lines; viscous drag estimate added to Euler forces (flat-plate friction from 10 AER) |
| V2 | optional high-accuracy body-fitted mode with **PyFR** (BSD-3, GPU backends CUDA / HIP / OpenCL / Metal) on a Gmsh mesh, for RANS-like viscous detail; nozzle and plume flows (11 FLD); propeller / rotor actuator disks |
| Out of scope | cloud or remote solving; MCP tools; certification-grade results; combustion, multiphase, conjugate heat transfer, aeroelasticity; FluidX3D or any solver whose licence forbids commercial or defence use (§10) |

## 5. Functional requirements

| Id | Priority | Requirement | Rationale | Source |
| -- | -------- | ----------- | --------- | ------ |
| FR-CFD-01 | MUST | Build one watertight, outward-oriented flow surface from the chosen solids (kernel union removes internal faces); refuse with the open-edge count and positions when it is not watertight | every Cartesian or body-fitted solver needs a closed body | Aftosmis et al. 1998 [R5] |
| FR-CFD-02 | MUST | Report features smaller than two cells of the target resolution (thin walls, small holes, gaps) with ids, sizes and positions; let the agent exclude entities or coarsen | the first cause of bad CFD is geometry finer than the grid | — |
| FR-CFD-03 | MUST | Tag boundaries as `wall`, `inlet`, `outlet`, `symmetry`, `ground` (by entity or face), stored as document data and replayed | openings (intakes, nozzles) and ground planes are boundary conditions, not geometry | — |
| FR-CFD-04 | MUST | Size the flow domain automatically from the regime: buildings by COST 732 / AIJ (5H sides, top and upstream, 15H downstream, blockage < 3 %); external aero by named llull defaults; refuse a blockage above the limit | domain errors bias every result | COST 732 [R1], AIJ [R2] |
| FR-CFD-05 | MUST | Estimate cell count, GPU memory and run time before solving; refuse when the memory needed exceeds the device, with the largest resolution that fits | a local GPU has a hard memory limit | — |
| FR-CFD-06 | MUST | Pick the solver from the regime (free-stream Mach < 0.3: LBM; 0.3 ≤ M ≤ 5: Euler); refuse a forced solver outside its range | LBM is a low-Mach method; Euler is inviscid | Krüger et al. [R7], Toro [R9] |
| FR-CFD-10 | MUST | Compressible inviscid solution (Euler) on an adaptive Cartesian cut-cell grid, steady state, Mach 0.3–5, any angle of attack and sideslip, free stream from 10 AER `standard_atmosphere` | shocks, Mach and pressure fields of aircraft and launchers | Aftosmis [R5], Toro [R9] |
| FR-CFD-11 | MUST | Low-speed solution (lattice Boltzmann with LES) for Mach < 0.3, steady or time-averaged, with velocity inlet, pressure outlet, ground plane and symmetry | buildings, cars, cyclists, drones | Krüger [R7], Geier [R8] |
| FR-CFD-12 | MUST | Run on the local GPU through a vendor-neutral API (Vulkan, Metal, DX12) and fall back to the CPU with a warning when no adapter is usable | owner directive 3; Windows, macOS and Linux desktops | wgpu [R11] |
| FR-CFD-20 | MUST | Forces and moments on each body and in total, with coefficients for a stated reference area, length and moment point; CdA in m² | the numeric result an agent reads (AF-21) | — |
| FR-CFD-21 | MUST | Surface fields per vertex: pressure, Cp, Mach (Euler), speed and near-wall speed (LBM); min / max with their positions | a number for every colour (AF-21) | — |
| FR-CFD-22 | MUST | Streamlines from rakes (line, plane grid, sphere around a point), each with points and a scalar (Mach or speed) per point; stop reasons reported | the second half of the reference images | — |
| FR-CFD-23 | MUST | Probe values at points and on slices (plane cut), including speed-up ratio U/U_ref at pedestrian height | wind comfort, wake surveys | AIJ [R2] |
| FR-CFD-24 | MUST | Viewport overlay (surface colours, streamlines, slices, legend with unit and range) and `render_view` PNG of the same data from the CLI | AF-22: the agent shows the owner what it computed | — |
| FR-CFD-30 | MUST | Convergence evidence: residual history, force history, steady-state criterion; a run that does not meet it ends `converged: false` with code `CFD_NOT_CONVERGED`, never a silent result | AF-32 | — |
| FR-CFD-31 | MUST | Grid study on request: the same case at three resolutions with the observed order and GCI from the existing `lib/convergence.ts` | trust in a number depends on grid independence | Roache GCI (PHY-00) |
| FR-CFD-32 | MUST | Every result names solver, version, device, resolution, case and geometry hashes, and what is not modelled (viscosity for Euler; wall-resolved boundary layers for LBM); results go `stale` when the geometry or case changes | AF-13, AF-35 | — |
| FR-CFD-33 | MUST | Refusals and warnings carry stable `CFD_*` codes with ids and a one-line remediation | AF-11 | — |
| FR-CFD-34 | MUST | Long runs report progress, respect `--timeout`, can be stopped, and are cached by content hash (a re-run of an unchanged case reuses the stored result) | AF-40 | — |
| FR-CFD-35 | SHOULD | Atmospheric boundary-layer inlet (log law) and pedestrian comfort classes | urban wind studies | Richards & Hoxey [R3] |
| FR-CFD-36 | SHOULD | Interpolated (cut-distance) LBM walls and cumulant collision for better accuracy at the same cell count | accuracy per GB of GPU memory | Bouzidi et al. [R10], Geier [R8] |
| FR-CFD-37 | COULD | Body-fitted high-accuracy mode through PyFR | viscous detail where a Cartesian grid is too coarse | PyFR [R12] |

## 6. Workflows

CLI first (`llull-cli` skill). The document changes go through commands; the solve is a host transport, like `fea_solve` today.

```bash
llull cfd_create_case '{"id":"m2","entityIds":["body"],"regime":"auto","freestream":{"mach":2,"altitudeM":20000,"alphaDeg":2},"reference":{"areaM2":12,"lengthM":8}}' --file model.llull
llull cfd_prepare caseId=m2 --json --file model.llull      # pass / warn / fail list, memory estimate; nothing is solved
llull cfd_solve caseId=m2 --progress --timeout 1800 --file model.llull
llull cfd_report caseId=m2 --json --file model.llull       # forces, coefficients, peaks, convergence, provenance
llull cfd_streamlines caseId=m2 rake='{"kind":"plane","origin":[-1,0,-1],"u":[0,4,0],"v":[0,0,2],"count":[24,8]}' --file model.llull
llull render_view overlay=cfd:m2:mach --save m2.png --file model.llull
```

With `--app`, the open desktop app shows the residuals during the solve and then the overlay (the user watches it live). The UI is
the review surface: a "Flow" panel lists cases, results and their state, and toggles the overlay layers. It never starts a different
computation from the CLI path.

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| a sphere of radius R voxelised at 16, 32, 64 cells per radius | `cfd_prepare` | volume error within the derived bound and decreasing with h | VC-CFD-10 |
| a box with one face removed | `cfd_prepare` | fail `CFD_GEOMETRY_NOT_WATERTIGHT` with the open-edge count | VC-CFD-11 |
| a 1:1:2 building block | `cfd_prepare` regime `buildings` | domain 5H / 5H / 15H, blockage 0.79 % (closed form) | VC-CFD-12 |
| plane Poiseuille flow at 16 / 32 / 64 cells | LBM | profile error falls with observed order ≥ 1.8 | VC-CFD-20 |
| a sphere at Re 20 / 50 / 100 / 200 | LBM | Cd within 10 % of Schiller-Naumann | VC-CFD-21 |
| the Sod shock tube | Euler | wave positions within 2 cells of the exact solution | VC-CFD-30 |
| a wedge at Mach 2 (10°) and Mach 3 (15°) | Euler | shock angle within 0.5°, surface Cp within 2 % of NACA 1135 | VC-CFD-31 |
| a sphere at Mach 0.3, 0.8, 2, 2.5 | Euler | stagnation Cp within 2 % of the isentropic / Rayleigh pitot value | VC-CFD-32 |
| potential flow about a sphere sampled on a grid | `cfd_streamlines` | stream function conserved; offset at x = 0 within 1e-3 R | VC-CFD-40 |
| the same case on GPU and CPU | `cfd_solve` | fields within 1e-4 relative, forces within 1e-5 | VC-CFD-26 |
| a case needing more memory than the device | `cfd_solve` | refused `CFD_MEMORY_EXCEEDED` before allocating, with the largest resolution that fits | VC-CFD-50 |
| a solved case whose body is then moved | `cfd_report` | `stale: true`, code `CFD_RESULT_STALE` | VC-CFD-52 |

## 8. Standards and regulatory alignment

- No CFD certification standard is claimed. CS-25 / 14 CFR 25 loads and EN 1991-1-4 wind actions need validated methods and
  qualified review; results are design-exploration estimates (AF-33).
- Urban wind domain and blockage rules follow COST Action 732 [R1] and the AIJ guidelines [R2] (grade B: secondary extracts; the
  primary documents are to be pinned before the rules become gates, see `validation/sources.md`).
- Compressible verification uses NACA Report 1135 relations already validated by 11 FLD.

## 9. KPIs

- 100 % of grade-A VCs automated (unit tests + CLI scenarios run against `validation/expected_results.json`).
- An agent goes from a model to a picture and a drag coefficient in ≤ 5 CLI calls.
- A draft case (≈ 16 M cells) finishes in ≤ 10 min on a mid-range 8 GB GPU (target; measured by VC-CFD-54).
- No result without solver, resolution, convergence state, provenance and stale flag.

## 10. Risks and assumptions

- **Cartesian grids are coarse at walls.** Immersed and cut-cell walls do not resolve boundary layers at practical cell counts.
  Pressure, Mach, shocks and streamlines are good; skin friction and separation onset are not. Each result says so, and the V2
  body-fitted mode exists for that reason.
- **Euler is inviscid.** Drag from the Euler solver is wave + induced + pressure drag only. The viscous part is reported separately
  (V1, flat-plate estimate from 10 AER) and never mixed silently.
- **LBM is low-Mach.** Above Mach 0.3 the LBM solver refuses (FR-CFD-06).
- **GPU memory caps resolution.** 8 GB gives tens of millions of cells (TECHNICAL_SPEC §8). The pre-solve estimate and refusal
  keep the run from crashing the desktop.
- **GPU determinism.** Floating-point order differs between devices. Results are reproducible on the same device and driver; across
  devices they match within VC-CFD-26 tolerances. The provenance names the device.
- **Licences.** FluidX3D was considered and rejected: its licence forbids commercial use, military and defence-industry use, and
  training AI models on its source [R13]. llull writes its own solver; PyFR (BSD-3) is the only third-party solver planned.
- **Network-limited sourcing.** Several primary sources (FEATFLOW benchmark pages, NASA NPARC archive, AIJ data) could not be
  fetched from the authoring sandbox. Values from them are grade B or TBD and are not gates until pinned (`validation/sources.md`).

## 11. References

- [R1] Franke J., Hellsten A., Schlünzen H., Carissimo B. (eds.), Best practice guideline for the CFD simulation of flows in the urban environment — COST Action 732, 2007 (domain 5H / 15H and blockage 3 % as quoted by secondary sources, accessed 2026-10).
- [R2] Tominaga Y. et al., AIJ guidelines for practical applications of CFD to pedestrian wind environment around buildings — J. Wind Eng. Ind. Aerodyn. 96:1749–1761, 2008; AIJ benchmark cases A–G (SimScale validation pages https://www.simscale.com/docs/validation-cases/aij-case-c/, accessed 2026-10).
- [R3] Richards P. J., Hoxey R. P., Appropriate boundary conditions for computational wind engineering models using the k-ε turbulence model — J. Wind Eng. Ind. Aerodyn. 46–47:145–153, 1993.
- [R4] NACA Report 1135, Equations, tables and charts for compressible flow, 1953 (via 11 FLD [R1]).
- [R5] Aftosmis M. J., Berger M. J., Melton J. E., Robust and efficient Cartesian mesh generation for component-based geometry — AIAA J. 36(6):952–960, 1998; NASA Cart3D description (https://ntrs.nasa.gov/citations/20020050405, accessed 2026-10).
- [R6] Sod G. A., A survey of several finite difference methods for systems of nonlinear hyperbolic conservation laws — J. Comput. Phys. 27:1–31, 1978.
- [R7] Krüger T. et al., The Lattice Boltzmann Method — Principles and Practice, Springer 2017.
- [R8] Geier M., Schönherr M., Pasquali A., Krafczyk M., The cumulant lattice Boltzmann equation in three dimensions: theory and validation — Comput. Math. Appl. 70(4):507–547, 2015, doi:10.1016/j.camwa.2015.05.001.
- [R9] Toro E. F., Riemann Solvers and Numerical Methods for Fluid Dynamics, 3rd ed., Springer 2009 (exact Riemann solver ch. 4, HLLC ch. 10).
- [R10] Bouzidi M., Firdaouss M., Lallemand P., Momentum transfer of a Boltzmann-lattice fluid with boundaries — Phys. Fluids 13:3452, 2001.
- [R11] wgpu, cross-platform Rust graphics and compute API on Vulkan, Metal, D3D12 and OpenGL, MIT / Apache-2.0 — https://github.com/gfx-rs/wgpu (README and LICENSE.MIT read 2026-10-18).
- [R12] PyFR, high-order flux reconstruction solver, BSD 3-clause, backends C/OpenMP, CUDA, OpenCL, HIP, Metal; entropy-filter shock capturing since v2.0 — https://github.com/PyFR/PyFR (LICENSE read 2026-10-18), https://pyfr.readthedocs.io/en/v2.1/.
- [R13] FluidX3D LICENSE.md — https://github.com/ProjectPhysX/FluidX3D (read 2026-10-18): clause 2 "Commercial use is not allowed", clause 3 "Military use is not allowed", clause 4 no AI training on the source.
- [R14] Schiller L., Naumann A., A drag coefficient correlation — Z. Ver. Dtsch. Ing. 77:318–320, 1933 (formula and Re < 800 range as quoted by OpenFOAM `SchillerNaumannDrag` and arXiv 2211.05458).
