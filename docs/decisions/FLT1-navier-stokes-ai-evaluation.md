# FLT1 — Can the "Navier–Stokes OpenAI solution" help llull? (evaluation, 2026-11-02)

Owner question during the 13 FLT / 14 FLL specification. Research by agent, sources fetched unless marked.

## What it most plausibly refers to

OpenAI's announcement "On the Navier-Stokes Millennium Prize Problem" (8 Sep 2026): an internal model produced a claimed
proof of finite-time blow-up for 3D Navier–Stokes, reportedly checked in Lean. The OpenAI page returned HTTP 403 to the
research agent; the facts come from press coverage (Engadget, Forklog, The Next Web). No independent verification was
found; the Clay Institute still lists the problem as open (press); the scope (forced vs unforced equations) and credit
are disputed. Related but different: Google DeepMind (Sep 2025) found unstable singularities for IPM, Boussinesq and
3D Euler with PINNs — not Navier–Stokes.

## Verdict per candidate

| Candidate                                                   | Verdict                                   | Why                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Navier–Stokes blow-up proof                          | **Does not help**                         | A regularity / blow-up theorem gives no discretisation, solver or model for engineering flows (which are smooth at these Reynolds numbers); no code                                                                                                                                         |
| OpenFOAM (if "OpenAI" meant OpenFOAM)                       | **Helps, as an optional external solver** | GPLv3 (openfoam.org licence page): never bundle; detect a user install and export a case (snappyHexMesh + STL), import forces / surface pressure — already planned as 10 AER V2 `cfd_import_external` (spec, not built). Rotating-mesh / MRF cases cover what llull's LBM does not (rotors) |
| ML surrogates (PhysicsNeMo Apache-2.0, FNO, graph networks) | **Helps only as a gated preview**         | Must be trained on real-solver data for a product family; out-of-distribution accuracy is not guaranteed (NeurIPS 2024 ML4CFD made OOD a separate criterion); every surrogate result `unverified` with a validity envelope and a real-solver check                                          |
| LLM in the loop (cloud API)                                 | **Not at runtime**                        | Offline rule (AF-41, LC1). A local open-weights model could advise on case set-up only, through registered commands and deterministic checks (OpenFOAMGPT-style agents need human oversight, arXiv 2501.06327)                                                                              |

## Decision

No dependency on the OpenAI result. CFD stays: native LBM (12 CFD) + optional external OpenFOAM / SU2 export-import
(10 AER V2) + V2 actuator disks for rotors. Surrogates are a possible later "preview" mode, never a validated result.

## References

- OpenAI, On the Navier-Stokes Millennium Prize Problem — https://openai.com/index/navier-stokes-solution/ (HTTP 403, not read)
- Engadget — https://engadget.com/2253393/whats-going-on-with-openai-and-the-navier-stokes-controversy/ (search result)
- The Next Web — https://thenextweb.com/news/openai-navier-stokes-claim-verification-credit (search result)
- Google DeepMind, Discovering new solutions to century-old problems in fluid dynamics — https://deepmind.google/blog/discovering-new-solutions-to-century-old-problems-in-fluid-dynamics/
- OpenFOAM Foundation licence — https://openfoam.org/licence/
- NVIDIA PhysicsNeMo open source — https://developer.nvidia.com/blog/physics-ml-platform-physicsnemo-is-now-open-source
- NeurIPS 2024 ML4CFD competition — https://arxiv.org/abs/2506.08516
- OpenFOAMGPT — https://arxiv.org/abs/2501.06327
