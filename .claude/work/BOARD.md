# llull build board — single source of truth for "continue working"

This file is **state**. The `continue-working` skill reads it, reconciles it against the
actual repo, launches parallel agents for the next eligible tasks, and writes it back.
The user only ever has to say **"continue working"**. Humans may edit this file directly.

## Status tokens (line-start, machine-parsed)
- `[TODO]` not started · `[WIP]` an agent is on it now · `[REVIEW]` code done, awaiting `cad-reviewer` + `npm run check`
- `[DONE]` merged & green · `[BLOCKED]` needs a decision/dependency (see note) · `[REMOVED]` deliverable deleted by a later decision (see note)

## Conventions
- **Deps** reference other task IDs. A task is *eligible* only when every dep is `[DONE]`.
- **Lanes** own disjoint file sets (below) so parallel agents don't collide. One task per
  lane runs at a time. Default parallelism = **4 lanes** (+ Lane 5 review runs after each).
- The only shared file is `packages/core/src/commands/registry.ts` — **Lane 1 owns it**; no other
  lane edits it. Domain commands register through plugins (`src/app/plugins.ts`), not registry.ts.

## How parallel agents coordinate (they don't talk — they don't need to)
Agents are isolated; coordination is structural, run by the orchestrator:
1. Only the orchestrator writes this board; a task is flipped to `[WIP]` **before** its agent
   launches → the board is the live "who's on what" ledger. Agents never edit it.
2. Disjoint lane file-ownership means two agents **cannot** write the same file.
3. A `[WIP]` lane is busy → never re-assigned while in flight.
4. Cross-lane needs wait on `[DONE]` deps and read the result from **committed files** — the
   repo is the only channel between lanes.
5. `[REVIEW]` (cad-reviewer + `npm run check`, + merge if worktrees) is the backstop.

## Lane → agent → file ownership
| Lane | Agent | Owns (write scope) |
| ---- | ----- | ------------------ |
| 1 Core | `command-author` | `packages/core/src/**` (incl. `commands/registry.ts`, `model/types.ts`), `packages/domain-aec/src/**` |
| 2 3D+Shell | `viewport-engineer` | `src/ui/viewport/3d/**`, `src/ui/components/**`, `src/ui/panels/**`, `src/ui/store/**` |
| 3 2D | `viewport-engineer` | `src/ui/viewport/2d/**`, snapping/tracking helpers |
| 4 MCP | `mcp-engineer` | `packages/mcp/src/**`, `server/**`, kernels `packages/kernel-*/src/**` |
| 5 Review | `test-verifier` + `cad-reviewer` | `tests/**`; reviews every diff (not a blocking lane) |

---

## NOW (auto-updated by the skill; older entries: `git log -p .claude/work/BOARD.md`)
- **MODERNIZATION PASS DONE:** 2026-10-12 (branch `ccr-caf8ee33-mu01za`) — toolchain: ESLint 10 flat `eslint.config.js`, TypeScript 6 (tests type-check via `tests/tsconfig.json`), Vite 8 (Rolldown `codeSplitting`), Vitest 5, Express 5, React 19 + r3f 9 + drei 10, three r186, Node >= 22.12, Prettier pinned exactly; `npm run deadcode` (knip) joins `check` + CI. Code: one `<domain>/{catalog,plugin}.ts` per AEC domain; typed `mapSegment`/`map3`/`vec3At` instead of double casts; one box/wedge face source (fixes `render_view` inward winding: lit back faces, dark tops); units consolidated in `@core/model/units`; exhaustive kind switches; `@lib/*` alias lint-enforced. Verified: check green (5639 tests), coverage gate, server/desktop suites, all Playwright e2e. Deliberately not done: `TOOLSETS` stays an `@mcp` view (test-guarded); exchange-result regex unshaping in `server/src/exchangeResult.ts`; `fileSlug` vs `safeFileName` (different filenames). TypeScript 7 waits on typescript-eslint support (<6.1).
- **QUALITY LOOPS DONE:** 2026-10-08 — 5 parallel worktree loops (Q-CORE 45, Q-AEC 42, Q-3D 40, Q-2D 43, Q-MCP 40 iterations; 10-min cron) merged on `feat/quality-loops`, then cleanups A/B/C (cross-lane dedup: FOV const, text bounds, escapeXml, NumberField, duplicate_entities UI, stepEditGuard removed from UI) and 4 cad-reviewer fix rounds (D/E/F + outbox poisoning B1 `8fc3080`) -> merged to `main`. Verified: typecheck + lint clean; 290 files / 4758 tests; coverage 97.59/92.66/98.27/97.59; server tests green except 2 known env failures (python, symlink). NOT run (env): `npm run quality` / `test:e2e` / `production` — Python+CadQuery missing and Playwright chromium_headless_shell-1194 not installed (stale install lock). Open user decisions: 2D rotation semantics (a821d75), locked-layer behaviour, document-storage redesign (defer), AutoCAD mouse mapping.

## Open tasks (DONE/REMOVED pruned 2026-10-13; full history in git)

## Lane 2 — 3D viewport + UI shell (`viewport-engineer`)
- `[TODO]` **E3** Layers panel (visibility/lock) + undo/redo buttons + shortcuts. _deps: W0-2_

## Lane 5 — Tests & review (`test-verifier`, `cad-reviewer`) — continuous, non-blocking
- `[TODO]` **I1** Hold the `core/commands/**` 90/85/90/90 gate; happy + failure test per new command. _runs with every Lane-1 task_
- `[TODO]` **I4** `cad-reviewer` pass on every `[REVIEW]` diff before flipping to `[DONE]`.

## S — 2D sketch tools (Lane 1 cmd + Lane 3 render/interaction)
- `[TODO]` **S3** `hatch_region` (fill a closed loop with a pattern) + `region` entity. _Lane 1+3. deps: B1._

## X — Export / Import (Lane 1 serialization + optional Lane 4 endpoints)
- `[TODO]` **X3** 2D export DXF + SVG from 2D entities. _Lane 1/3. deps: B1._
- `[TODO]` **X4** Import: SVG path → 2D profile, STL → `mesh` entity. _Lane 1. deps: X1/X3._

## P — Performance (Lane 2/3, `viewport-engineer`)
- `[TODO]` **P5** (Stretch) WebGPU renderer opt-in behind a flag with WebGL fallback; verify drei helpers (Grid/Gizmo) degrade gracefully. _Lane 2. deps: P1. Re-evaluate only if P1–P4 leave a measured GPU bottleneck._

## Group 1 — KEY IMPROVEMENTS (foundation & robustness; front-load)
- `[TODO]` **KI7** Typed command/tool client bindings (DX): generate typed params/return bindings from the registry so callers (UI param forms, the example agent, tests) get compile-time safety instead of `unknown`. _Lane 1/4. deps: —. Acceptance: a generated typed surface used by ≥1 caller; no `any`; gate held. (Lower priority.)_

## Group 2 — NEW WANTED FEATURES (net-new product capability)
- `[TODO]` **NF3** Drawings & sheets (2D documentation from 3D): `create_drawing_view` (orthographic projection of a solid onto a sheet), `add_section_view`, `add_detail_view`; a `sheet`/paper-space concept with title block. _Lane 1 cmd + Lane 3 render. deps: M1; hidden-line ideally KI4 (mesh silhouette acceptable v1). PAIR(NF3↔VNF3). Acceptance: a box yields front/top/right views on a sheet; views update when the model changes._
- `[TODO]` **VNF3** Sheet/paper-space mode: render projected views + title block + sheet-placed dimensions. _Lane 3. deps: NF3._
- `[TODO]` **NF7** Direct face editing / push-pull: select a planar face → push/pull to add/remove material. _Lane 1 cmd + Lane 2 interaction. deps: KI4 (face topology). **STRETCH** — needs B-rep faces; defer if OCC deferred._

## Group 3 — ENRICHMENT OF EXISTING FEATURES (deepen Wave 1/2 surfaces)
- `[TODO]` **EN5** Associative dimensions + dimension styles: T2 dimensions reference live geometry so they update on edit; a dimension style (arrows, text height, precision from U1). _Lane 1 cmd + Lane 3 render. deps: T2. Acceptance: moving a referenced endpoint updates the dimension value._
- `[TODO]` **EN6** 2D polyline/spline editing & richer modify: add/remove/move vertex, convert line↔arc segment, join/close, multi-pick `offset`/`trim`/`extend` (extends S2). _Lane 1 cmd + Lane 3. deps: B1, S2. Acceptance: vertex edits dispatch through commands; gate held._
- `[TODO]` **EN7** Continuous measure mode + measurement report: snap-aware chained measuring with running totals; export a structured measurement report in `data`. _Lane 1 cmd + Lane 2/3 HUD. deps: M1, M2. Acceptance: chained picks accumulate distance; report returns structured `data`._
- `[TODO]` **EN11** Layer enrichment: layer color/linetype/lineweight, layer filters/groups, per-drawing-view layer overrides (ties to NF3). _Lane 1 cmd + Lane 2 panel. deps: L1, L2. Acceptance: entity inherits layer color unless overridden; gate held._
- `[TODO]` **EN12** Export fidelity & scope: export-selection-only, batch export, glTF/OBJ with materials (NF4), DXF layer mapping. _Lane 1/2. deps: X1–X3, NF4. Acceptance: exporting a selection with materials produces a valid file carrying material/layer data._

## Pillar 2 — Camera control (Lane 1 command + Lane 2 viewport, PAIR)
- `[TODO]` **W5B** Camera-control command(s): `set_camera` / `look_at` / `fit_view(direction, padding)` writing `document.camera`, and make the viewport **react to `document.camera` changes** (today `ViewPresetsInner` reads `cam` only at initial mount, so an MCP camera change is ignored live). _Lane 1 cmd + Lane 2 viewport (PAIR). deps: —. Acceptance: an MCP agent frames the model deterministically (front/iso/top + fit-all with padding) with no UI click or wheel hack; camera changes broadcast over SSE move the live camera; flagged `readOnly`/meta as appropriate so it doesn't pollute feature history._

## Pillar 5 — Performance (the live-sync + idle-loop costs P1–P4 never covered)
- `[TODO]` **W5G** **Restore true idle (P1 is defeated when anything is selected).** With one entity selected and zero interaction the render loop runs **~60 frames/sec** (proven: `TransformControls: attached object must be part of the scene graph` logs every ~16 ms). The gizmo re-attaches+throws each frame and keeps calling `invalidate()`, so `frameloop="demand"` never quiesces → sustained CPU/GPU on a static scene. Fix is the same root cause as **W5C** (gizmo target under the floating-origin group / instanced batch); also audit residual `invalidate()` sources (OrbitControls damping persistence). _Lane 2. deps: shares W5C. Acceptance: one entity selected, no input → render loop quiesces (≈0 frames/sec, 0 console errors) within ~1 s; orbit/zoom still smooth._

## Pillar A — Procedural / computed geometry (Lane 1 cmd + Lane 2 render) — HIGHEST LEVERAGE
- `[TODO]` **VPG2/VPG3** Render branches / draw affordances for involute + chain-path entities. _Lane 2/3. deps: PG2 (involute renders today as a `polyline` — VPG2 = tangent/normal overlay polish) / PG3._

## Done / removed task ids
W0-1 · W0-2 · A1 · A2 · A3 · A6 · A4-core · A4-ui · R1 · A5 · B1 · B2 · B3 · H1 · H2 · C1 · C2 · C3 · E1 · E2 · D1 · D2 · D3 · F1 · F2 · F3 · G1 · G2 · G3 · I2 · I3 · W1 · N0 · N1 · VN1 · N2 · VN2 · K1 · K2 · K3 · U1 · U2 · U3 · U4 · S1 · VS1 · S2 · VS2 · S4 · T1 · VT1 · T2 · VT2-nits · VT2 · M1 · M2 · L1 · L2 · Q1 · Q2 · Q4 · Q3 · VQ · X1 · X2 · JX · P1 · P2 · P3 · P4 · V1 · V2 · V3 · V4 · J1 · J2 · J3 · AI1 · AI2 · AI3 · AI4 · AI5 · AI6 · KI1-followup · KI1 · KI2 · KI3 · KI4 · KI5 · KI6 · NF1 · VNF1 · NF2 · NF4 · VNF4 · NF5 · NF6 · VNF6 · EN1 · EN2 · EN3 · EN4 · EN8 · EN9 · EN10 · W4A · W4B · W4C · W4D · W4E · W4H · W4F · W4G · W5A · W5B-cmd · W5B-viewport + VN2 · W5C+W5G · W5D · W5E · W5F · W5H · PG1 · PG2 · PG3 · VPG1 · KN1 · KN2 · MG0.1 · MG0.2 · MG0.3 · MG0.4 · MG1.1 · MG1.2 · MG1.3 · MG1.4 · MG1.5 · MG2.1 · MG2.2 · MG2.3 · MG2.4 · MG3.1 · MG3.2 · MG3.3 · MG4.1 · MG4.2 · MG4.3 · MG4.4 · MG4.5 · MG5.1 · MG5.2 · MG5.3 · MG5.4 · MG6.1 · MG6.2 · MG6.3 · MG6.4 · MG6.5

## Decision log (resolve `[BLOCKED]` items here)
- **RESOLVED 2026-10-02 (user approved all recommendations) — D1 schema library (MG2):** zod v4 (built-in `toJSONSchema`, already a transitive dep via `@modelcontextprotocol/sdk`) vs TypeBox. Recommendation zod. New dependency ⇒ needs explicit user approval (CLAUDE.md STACK).
- **RESOLVED 2026-10-02 (user approved all recommendations) — D2 npm workspaces monorepo (MG6.1):** recommendation yes.
- **RESOLVED 2026-10-02 (user approved all recommendations) — D3 OCC WASM on the server (MG1.4):** ~63 MB, slow cold start; needed for kernel parity between UI and MCP. Recommendation yes, behind `LLULL_KERNEL`.
- **RESOLVED 2026-10-02 (user approved all recommendations) — D4 document format v1 → v2/v3 with auto-migration on load, no v1 writer (MG3.2, MG4.2):** recommendation yes.
- **RESOLVED 2026-10-02 (user approved all recommendations) — D5 feature freeze on new domain commands during MG1–MG4:** recommendation yes.
- **A4 boolean CSG library:** RESOLVED 2026-05-25 → **manifold-3d (Manifold)**. Robust watertight mesh booleans (WASM). Behind a `GeometryKernel` interface (L9) so OpenCascade.js can replace it later for exact B-rep/STEP. Mesh-based results stored as a new `mesh` solid kind.
- **In-app AI bridge:** REMOVED 2026-05-25 (user decision: "only MCP will be used"). Deleted `src/core/ai/**`, the Express `/api/ai` proxy + `anthropicClient.ts`, the chat panel (`ChatPanel`/`useAiChat`/`chat.css`), and the `@anthropic-ai/sdk` dependency. AI control is now delivered solely through the MCP host (`/mcp`). Architecture rules updated: L1 is now "two callers" (UI + MCP). Tasks F1/F2/F3 → `[REMOVED]`.
- **OPEN — kernel capability for K1/K2/K3 (fillet/chamfer/shell):** Manifold (current kernel) does mesh booleans well but has **no robust edge fillet/chamfer or shell**. These need either (a) an OpenCascade.js B-rep kernel swapped in behind the existing `GeometryKernel` interface (L9) — large WASM, slow init, but the "real CAD" path that also unlocks STEP export, or (b) mesh-approximation fillets (lower quality). Decide before scheduling K1/K2. Sweep/loft (K3) are achievable mesh-side. **Default recommendation: defer K1/K2 until an OCC kernel is justified; build N0–N3, sweep/loft, and the rest of Wave 2 first.**
- **OPEN — WebGPU (P5):** stay on WebGL until P1–P4 leave a *measured* GPU bottleneck; the renderer is an isolated `ui/` swap (two `<Canvas>` call sites), so deferring costs nothing.
- **OPEN — OCC kernel adoption (Wave 3 KI4, supersedes the K1/K2/K3 caveat):** the Wave 3 `KI4` spike decides adopt-vs-defer for OpenCascade.js behind the `GeometryKernel` interface (L9). Adopting unlocks fillet/chamfer/shell (K1/K2), STEP/IGES (NF5), and face topology for push-pull (NF7); cost is large WASM + slow init. Decide from the spike before scheduling NF5/NF7/K1/K2.
- **INFO — Wave 3 scope boundary:** real-time collaboration, simulation/CAE, and CAM/fabrication remain "Later" (see `docs/ROADMAP.md`) and are intentionally **out of Wave 3** to keep the wave shippable. Revisit after assemblies + drawings land.
