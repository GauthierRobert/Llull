# 10 INT — Result integrity: no silent wrong answer — Functional specification

Status: specified 2026-11-05 from the code audit [`../AUDIT-2026-11-05.md`](../AUDIT-2026-11-05.md). Nothing in this pack is
built. Pack readiness level: **PRL 2 trustworthy** (a few cases are PRL 1 prerequisites, marked in the validation plan).

## 1. Why this pack exists

Packs 01–09 cover the product around the commands: install, data safety, speed, exchange, V&V records, support. None of them
covers the worst failure an engineering tool can have: **a command that returns a plausible, confident, wrong answer and
says nothing.** The 2026-11-05 audit found that class of defect in the command engine, the steel and civil checks, the FEA
result chain, the kernel choice, the layer model, the verification commands and the test gate itself. Each one is small to
fix; together they decide whether an engineer can trust any number llull prints.

Principle (binding for every FR below): **a result is either right within its stated assumptions, or it says, in `data` and
in the `summary`, exactly what it assumed, defaulted, skipped or degraded. Never neither.**

## 2. Current state (code read 2026-11-05, main 00d5326f5)

| # | Defect | Evidence | Effect |
| - | ------ | -------- | ------ |
| G1 | `execute` validates params with zod, then calls `run` with the **raw** params | `packages/core/src/commands/guard.ts:130` parses, `:148` runs `def.run(doc, safeParams, ctx)` | `.default()`, `.trim()`, transforms never reach a command; ~22 `.trim()` schemas run on untrimmed strings; TS types claim `z.output` but `run` gets the input |
| G2 | An unparseable steel grade is checked as S355 | `packages/domain-aec/src/industrial/steelDesign/steelDesign.ts:15-18` ("355 when unknown"); callers in bracing, frames, purlins, foundation plates | "A36", "1.0570", "S235" typed as "235" → checked as S355: non-conservative pass |
| G3 | Yield strength ignores thickness | same function takes only the grade | base plates and thick flanges (> 40 mm) checked at the t ≤ 40 mm value: non-conservative |
| G4 | Every bolt is grade 8.8; the diameter snaps silently to the nearest table size | `steelDesign.ts:11-33` (`BOLT_FUB = 800`, `stressArea` nearest of 12..36) | a 10.9 or 6.8 bolt gets the wrong αv / fub; M18 is checked as M16 or M20 |
| G5 | Road design speeds above 120 km/h use the 120 km/h row | `packages/domain-aec/src/civil/road/roadChecks.ts:26-27` | minimum radius / K for 130 km/h reported from the 120 row, no warning |
| G6 | FE mesh adequacy is a warning of `check_analysis` only; margins and solve do not gate on it; the measure is a bounding-box heuristic | `packages/domain-cae/src/results/adequacy.ts:17` (`MIN_ELEMENTS_ACROSS = 2`), `commands/checkStructure.ts:139-150` | a 1-element-thick linear-tet beam is far too stiff; margins look healthy |
| G7 | A missing or broken exact kernel falls back to Manifold with one `console.warn` | `server/src/geometryKernel.ts:80-96`; `/health` returns only the name (`server/src/index.ts:60`); plan warnings only for the fillet family (`server/src/cli/planKernelWarning.ts:13,23`) | booleans, volumes, mass properties silently become mesh approximations |
| G8 | Locked layers bind the UI only; every core edit command ignores them | `packages/core/src/commands/document/layers.ts:1-4` | the CLI / an agent moves, deletes, re-parameterises locked geometry; UI and CLI disagree (breaks L1 "one command layer, two callers") |
| G9 | The standalone backend (no `LLULL_AUTH_TOKEN`) accepts mutations from any local process; default allowed origin is the legacy Vite origin | `server/src/security.ts:131-159` (case "no token → allow"), `:13` (`http://localhost:5173`) | any local process or a page on :5173 can change the live document |
| G10 | Zip and inflate default budgets are 1 GiB with no ratio cap | `packages/core/src/lib/zipRead.ts:13-26`, `inflate.ts:143` | a 10 kB hostile archive can allocate ~1 GiB in an importer |
| G11 | ~45 test files skip themselves when CalculiX, Python or a native binary is absent, and the run is still green | e.g. `server/tests/feaPipeline.test.ts:108`, `cadExchange.integration.test.ts:165`, `tests/oracle/oracle.test.ts:33` | the FEA, exchange and oracle layers can be "green" without having run |
| G12 | `verify_release` does not regenerate geometry; it says so only in the description | `packages/plm/src/commands/verify.ts:93` | a released item whose geometry changed through a kernel / replay difference still "verifies" |
| G13 | Swallowed failures in result paths: FEA native mapping step `.catch(() => null)`; renderer snapshot resync `.catch(() => undefined)` | `server/src/fea/feaSolve.ts:77`; `src/ui/hooks/useLiveDocument.ts:63,113,144` | diagnosis lost (FEA falls back to the TS mapper, result stays right); a permanently desynced viewer shows no banner |

Already good (kept, not re-specified): pipe-stress and margin results name every defaulted input (`PST_*_DEFAULTED`,
`marginMath.ts:35-43`); `steelMembersCheck` lists its assumptions; FEA non-convergence is reported (`NLS_*`); the desktop
backend always runs with a token, a Host allowlist and single-use `/live` tickets; Electron is sandboxed.

## 3. Personas and use cases

- **UC-1 Check a structure** (steel, civil): every input the check could not read is refused or reported, never replaced.
- **UC-2 Trust an FE margin**: a margin computed on an inadequate mesh is never shown as a pass.
- **UC-3 Know what kernel answered**: an engineer and an agent can see, per result, whether it is exact or a mesh estimate.
- **UC-4 Respect a lock**: a locked layer is locked for every caller.
- **UC-5 Trust the gate**: "tests green" means the FEA, exchange and native suites ran.
- **UC-6 Trust a verification**: a verification command never reports a pass over a part it did not check.

## 4. Functional requirements

| Id | Pri | Requirement | Closes |
| -- | --- | ----------- | ------ |
| FR-INT-01 | MUST | A command's `run` receives the **parsed output** of its zod schema (defaults applied, transforms and trims done). The type of `run`'s params is `z.output` and that is what arrives at runtime | G1 |
| FR-INT-02 | MUST | No engineering input is silently replaced. An unknown or unparseable material grade, bolt class, bolt size, design speed, load class, or any key of a lookup table is either **refused** with a stable code naming the input and the accepted values, or used with an explicit default that appears in `data.defaulted[]` and in the summary. Which of the two is decided per input in the fallback inventory (FR-INT-14); out-of-range values of a sourced table are always refused | G2, G4, G5 |
| FR-INT-03 | MUST | Structural steel yield strength depends on grade **and** governing thickness, per the design basis in force (EN 1993-1-1 Table 3.1 simplification by default: t ≤ 40 mm and 40 < t ≤ 80 mm); thicker material is refused. The governing thickness (flange for rolled sections, plate thickness for plates) is shown per result row | G3 |
| FR-INT-04 | MUST | Bolt checks take the property class (4.6, 5.6, 6.8, 8.8, 10.9) as an input with αv, fub and k2 per EN 1993-1-8 Table 3.4 / 3.1, and an ISO metric coarse size present in the stress-area table; any other size is refused. Default class, when the caller omits it, is reported as defaulted (FR-INT-02) | G4 |
| FR-INT-05 | MUST | Every design table used by a check declares its domain. A value inside the domain that falls between rows uses the conservative neighbour, and the summary names the row used; a value outside the domain is refused | G5 |
| FR-INT-06 | MUST | FE results carry a mesh-adequacy verdict computed on the actual mesh (element layers through each thin region, element order), not on the bounding box. `compute_margins`, `check_analysis` and any pass/fail derived from FE stresses or deflections report **not assessed** (never pass) when the verdict is `inadequate`, unless the caller sets `acceptInadequateMesh: true`, which is recorded in the result | G6 |
| FR-INT-07 | MUST | Every geometry result records its **provenance**: kernel that produced it (`occt-native`, `manifold`), whether the exact path was requested, and the fallback reason if it was not taken. The UI status bar shows a persistent "mesh kernel (degraded)" state while the exact kernel is unavailable; `llull` prints a one-line warning on every command whose result was degraded; `run --validate` warns for every kernel-optional and kernel-required command in the plan, not only the fillet family. Complements FR-INS-06 (install-time) with result-time provenance | G7 |
| FR-INT-08 | MUST | A mutating command that would create, change or delete an entity on a locked layer is refused through `execute`, for every caller, with `LAYER_LOCKED` naming the layer and entity ids. Exempt: layer-management commands themselves (`update_layer`, `delete_layer` semantics unchanged), replay of an existing history (`ctx.replaying`), and plugin re-derivation | G8 |
| FR-INT-09 | MUST | The command channel is authenticated in every mode. The backend refuses to serve mutating routes without a token unless started with an explicit `--insecure-no-token` flag that it logs and reports in `/health`; there is no default allowed origin; `/health` answers only through the Host allowlist (the HMAC challenge probe excepted) | G9 |
| FR-INT-10 | MUST | Every reader of untrusted archives or XML runs under explicit caps: archive total ≤ 256 MiB and expansion ratio ≤ 200 by default (per-importer overrides named and tested), XML depth ≤ 256, attribute ≤ 1 MiB; a cap hit is a stable code, never a crash or hang | G10 |
| FR-INT-11 | MUST | A test run that declares a tool required (CI native job, release gate: `LLULL_REQUIRE_TOOLS=calculix,python,native`) fails if any suite skipped because that tool was absent; every run prints the skipped-by-reason counts | G11 |
| FR-INT-12 | MUST | A verification or check command never reports an overall pass over a scope it did not check. Each such command returns `data.unchecked[]` (what it skipped and why) and an overall state of `pass`, `fail` or `partial`; `verify_release` returns `geometryVerified: false` and `partial` until geometry regeneration is built | G12 |
| FR-INT-13 | SHOULD | A failure swallowed on a result path leaves a trace in the result: the FEA mapping step adds `native mapping failed (<reason>); mapped in TypeScript` to the summary; the renderer shows an "out of sync" banner after 3 failed resyncs and offers a reload | G13 |
| FR-INT-14 | MUST | A **fallback inventory** (`validation/data/fallback_inventory.json`) lists every default, clamp, nearest-row lookup and catch-all branch in the engineering check code of `packages/domain-*` and `packages/plm`, with its policy (refuse / default-and-report / conservative neighbour) and the test that proves it. A contract test fails when an inventory entry has no test, and a source scan (TR-INT-14) fails when a new unlisted pattern appears | G2–G5 regrowth |

## 5. Out of scope

Sourcing the tables themselves (national annexes, AASHTO, MSS SP-69, FHWA): pack 07 VNV (FR-VNV-103/104, D7). Install-time
kernel status and `llull doctor`: pack 05 INS (FR-INS-06/08). File locks and recovery: pack 04 DSF. This pack only
guarantees that whatever the tables say, the answer is honest about what it used.

## 6. Decisions taken (owner delegated quality-first decisions, memory `owner-delegates-quality-first`)

- **D-INT-1 Lock policy** (open on the board since 2026-10): enforce in `execute` for every caller (FR-INT-08), no `force`
  parameter. Reason: a per-command bypass recreates the UI/CLI split; unlocking is one explicit, undoable command.
- **D-INT-2 Default bolt class**: 8.8 stays the default (most common in EU steelwork) but is reported as defaulted.
- **D-INT-3 Thickness rule**: EN 1993-1-1 Table 3.1 simplification is the default fy source until pack 07 ships a design
  basis with product-standard values; the result row names the rule.
- **D-INT-4 Token-less mode** exists only behind a flag, for headless scripting on a single-user machine.
