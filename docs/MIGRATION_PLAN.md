# Migration plan — from "accreted" llull to the target architecture

Status: **done** (2026-10-02; D1–D5 approved). See **As built** at the end for deviations. Board tasks: `.claude/work/BOARD.md` → **WAVE 7 (MG\*)**.
Each phase leaves `main` green and shippable. No big-bang rewrite.

## What stays (non-negotiable)

- One registry, two callers (UI + MCP) through `execute()` — architecture L1/L5.
- Pure commands; `summary` / `data` / annotations as the agent feedback channel.
- `ui → core → lib`, hook-enforced. Coverage gate on the command layer.
- 2D + 3D in one document (L7).

## What changes (the five target properties)

| # | Target | Today (evidence) |
|---|--------|------------------|
| T1 | **Explicit execution context** — kernel, id source, registry are injected per call | Module singletons: `setGeometryKernel` (`core/geometry/kernel.ts:108`), global `nextId()` (59 call sites in `core/`), three late-bound registry refs (`registry.ts:353-355`). Server runs Manifold only, browser may run OCC (`main.tsx`, `?kernel=occt`) → `fillet_edge` result depends on which surface called it. OCC kernel lives in `ui/geometry/`. |
| T2 | **One schema per command** → TS type + MCP JSON Schema + runtime validation | Hand-written `paramsSchema` and a separate `<X>Params` interface, unchecked against each other; `guardCommand` compensates with ad-hoc checks (prototype keys, NaN, planar padding). |
| T3 | **Recipe-first document** — definition is stored; entities are a derived cache | `entities` is primary; `execute()` appends a `FeatureStep` after the fact; replay remaps ids by positionally zipping `affected` (`commands/types.ts` invariant); boolean/fillet results stored as world-space `mesh` entities; building module has its own definition/evaluated split enforced inside `guardCommand`. |
| T4 | **One sync path** — command log, not document diffs | Server-authoritative SSE doc patches **plus** `uiBridge` push/pull staging (`snapshot_in_from_ui` / `snapshot_out_to_ui`) **plus** offline "client wins" `load_document` push that collapses all offline edits into one undo step and overwrites concurrent server edits (`ui/store/store.ts` header). |
| T5 | **Small core, domains as plugins** | ~230 commands in one flat registry; `core/commands/building/industrial/**` (steel/footing/purlin checks, NC export, wind) inside the CAD core; toolsets hand-listed in `core/mcp/toolsets.ts`; 49 source files > 500 lines. |

## Phase order and why

```
MG0 guardrails ──► MG1 context (T1) ──► MG3 stable ids ──► MG4 recipe-first (T3) ──► MG5 sync (T4)
        └────────► MG2 schemas (T2) ─────────┘                                 
        └────────► MG6 packages/plugins (T5, can start after MG1; finishes last)
```

MG1 before MG3/MG4: stable ids and incremental regeneration need an injected id source and
kernel. MG2 runs in parallel (pure per-file mechanical work). MG5 needs MG3 (a command log is
only replayable to identical state if ids are deterministic) and MG1 (kernel parity across
surfaces). MG6 is mostly file moves; do it once the contracts above have stopped moving.

**Feature freeze recommendation:** no new domain commands (building/industrial/mechanisms)
during MG1–MG4. Bug fixes allowed. Otherwise every phase chases a moving target.

---

## MG0 — Guardrails (no behavior change) · ~1 batch

Goal: make every later phase provably behavior-preserving.

- **MG0.1 Golden replay corpus.** `tests/golden/`: ~30 representative `build_project` plans
  (2D drafting, booleans, fillet, parametric/configurations, assembly + joints, a building, an
  industrial portal). Store the serialized resulting document per plan. Test: run plan from
  empty doc → `serializeDocument` equals snapshot (ids normalized). Also: `replay_history`
  on the result reproduces it.
- **MG0.2 Schema conformance test.** For every command: generate a minimal valid params object
  from `paramsSchema` (required props, first enum value, sample numbers) → `execute` must not
  hit the `guardCommand` catch path (`failed:` summary). Catches schema/interface drift today.
- **MG0.3 File-size ratchet.** ESLint `max-lines: 500` as `error`, with the current 49
  offenders in an explicit allowlist file. List may only shrink.
- **MG0.4 Perf baseline.** Bench: replay time for the 3 largest golden plans; doc JSON size.

Done when: corpus + conformance test green on `main`; baseline numbers recorded below.

## MG1 — Execution context (T1) · ~2 batches

- **MG1.1 `ExecutionContext`.** `core/commands/context.ts`:
  `interface ExecutionContext { kernel: GeometryKernel | null; ids: IdSource; registry: CommandLookup }`.
  `execute(doc, name, params, ctx = defaultContext())` — the default wraps today's globals, so
  no caller changes. `CommandDefinition.run(doc, params, ctx)`: third arg optional, so the 230
  existing commands compile untouched.
- **MG1.2 Delete the late-bound refs.** `history.ts`, `configurations.ts`, `recipes.ts` read
  `ctx.registry` instead of `setRegistryRef` & co.
- **MG1.3 Kernel via ctx.** `boolean.ts`, `modify3d.ts`, tessellation users call `ctx.kernel`.
  `getGeometryKernel()` survives only inside `defaultContext()`.
- **MG1.4 Kernel parity.** Move `ui/geometry/occtKernel.ts` → `core/geometry/occtKernel.ts`
  (it is pure WASM, no DOM). Server installs the same kernel choice as the browser (config
  `LLULL_KERNEL=manifold|occt`). Test: `fillet_edge` via MCP and via store produce the same
  entity. **Decision D3** (63 MB OCC WASM on the server).
- **MG1.5 Async kernel readiness.** `execute` refuses kernel-dependent commands with an
  explicit "kernel loading" summary instead of a silent no-op; new annotation
  `requiresKernel: true`. Replay waits for readiness instead of producing a different doc.

Done when: no module-level mutable state in `core/` except `defaultContext()`; golden corpus green.

## MG2 — One schema per command (T2) · ~3–4 batches, parallel to MG1

- **MG2.1 `defineCommand`.** `defineCommand({ name, description, params: <schema>, annotations, run })`
  derives `paramsSchema` (JSON Schema for MCP) and the params TS type from one schema value.
  Output is today's `CommandDefinition` — registry, MCP and UI are unchanged.
  **Decision D1:** zod v4 (built-in `toJSONSchema`; `@modelcontextprotocol/sdk` already ships
  zod in `server/`) vs TypeBox (emits JSON Schema natively, smaller). Recommendation: **zod**.
- **MG2.2 Validate in `execute`.** Invalid params → graceful no-op with a summary naming the
  offending path (`size[2]: expected number > 0`). Move the generic checks from `guardCommand`
  (non-object params, prototype-key ids, planar `position` padding) into shared schema helpers
  (`vec3()`, `entityId()`, `position()`).
- **MG2.3 Migrate per domain file**, one PR each, smallest first: `units`, `layers`,
  `parameters`, `transform`, `geometry`, `draw2d`, `modify2d`, `measure`, … `building/**` last.
  Each PR deletes the hand-written `<X>Params` interface + `paramsSchema` literal.
- **MG2.4 Schema snapshot test.** `toToolSchemas()` output snapshotted; diff reviewed on every
  change (agents see these descriptions — accidental loss is a regression).

Done when: zero hand-written `paramsSchema` literals; MG0.2 conformance test removed as redundant.

## MG3 — Deterministic, stable ids · ~2 batches (needs MG1)

- **MG3.1 Step-scoped ids.** `ctx.ids` for a mutating `execute` mints `<stepId>.<n>`
  (n = creation order within the step). Replay reuses the recorded `stepId` → identical ids,
  so `remapIds` + the positional `affected` zip become dead code.
- **MG3.2 Load-time upgrade.** `migrate()` in `persistence.ts`: v1 docs are replayed once
  with the legacy remap, then ids rewritten to step-scoped form. Schema version → **2**.
- **MG3.3 Remove `__resetIdCounter`** from tests; determinism comes from the step id.

Done when: `replay(history)` is byte-identical to the stored document for the golden corpus,
without any id remapping.

## MG4 — Recipe-first document (T3) · ~4 batches (needs MG3)

- **MG4.1 Split the type.** `CadDocument = { definition: DocumentDefinition; evaluated: EvaluatedModel }`
  behind accessor helpers (`entitiesOf(doc)`, `definitionOf(doc)`) introduced **first** in a
  mechanical PR so the split itself is a small diff. `definition` = parameters, featureHistory,
  layers, materials, configurations, recipes, constraints, building, assemblies, camera/units.
  `evaluated` = entities, order, meshes.
- **MG4.2 Mesh results become cache.** `mesh` entities produced by boolean/fillet hold a
  `source: { stepId }` and their `MeshData` lives in `evaluated` only; persistence (v3) writes
  `definition` (+ optional cache blob). Expect large file-size drop on boolean-heavy docs.
- **MG4.3 Step dependency graph.** Each `FeatureStep` records `reads: EntityId[]` (ids found
  in its params) — producer lookup via MG3 ids gives a DAG. `update_step_params` /
  `set_parameter` / suppress re-evaluate only the downstream closure.
- **MG4.4 Kernel memoization.** `ctx.kernel` wrapped in a cache keyed by hash of operand
  definitions → regenerating an unchanged boolean is free.
- **MG4.5 Generalize the building guard.** "Entity generated by a definition element is
  read-only" becomes a generic rule (`entity.source` set ⇒ edit the source) instead of
  building-specific code in `guardCommand`.

Done when: saved files contain no `MeshData`; editing a parameter on the largest golden plan
re-evaluates only dependent steps (measured vs MG0.4 baseline).

## MG5 — One sync path (T4) · ~2 batches (needs MG1.4 + MG3)

- **MG5.1 Command-log broadcast.** Server broadcasts `{ seq, stepId, name, params }` over
  `/live`; clients apply via the same `execute` (deterministic ids + kernel parity ⇒ same
  state). Full snapshot only on connect / seq gap. `docPatch.ts` retired.
- **MG5.2 Offline = queued commands.** Local mode appends to an outbox; on reconnect the
  outbox is sent as commands (server rebases them after its log) — replaces the "client wins"
  `load_document` push. Undo granularity survives the round-trip.
- **MG5.3 Retire `uiBridge`.** `snapshot_in_from_ui` / `snapshot_out_to_ui`, `server/src/uiBridge*.ts`,
  `core/mcp/uiBridge.ts` deleted — every MCP session already operates on the live document.
  Announce in MCP tool descriptions one release before removal.
- **MG5.4 History-based undo.** Undo = suppress/remove last step + re-evaluate (MG4.3),
  replacing the parallel snapshot stacks on server and client.

## MG6 — Packages & plugins (T5) · ~3 batches (start after MG1, finish last)

- **MG6.1 npm workspaces** (**Decision D2**):
  `packages/core` (model, commands, context, persistence) · `packages/kernel-manifold` ·
  `packages/kernel-occt` · `packages/mcp` · `packages/render` (SVG `render_view` +
  tessellation, shared with export) · `packages/domain-building` ·
  `packages/domain-industrial` · `apps/web` · `apps/server`. Path aliases kept as re-exports
  during the move.
- **MG6.2 Plugin contract.** `definePlugin({ name, toolset, commands, entityKinds?, guards? })`.
  Registry = core + enabled plugins. `TOOLSETS` derived from plugin metadata (delete the
  hand-maintained lists in `toolsets.ts`).
- **MG6.3 Tool discovery for agents.** Default MCP exposure = `core` toolset + `search_tools`
  / `enable_toolset` meta-tools, so clients stop loading 230 schemas.
- **MG6.4 Burn down the MG0.3 allowlist** — split every > 500-line file by concern
  (`draw2d.ts` → one file per entity kind, `render.ts` → projection / tessellation / svg, …).
- **MG6.5 Rules/docs refresh.** Update `CLAUDE.md` layer map, `.claude/rules/architecture.md`
  (L8/L9 become "as built"), agent lane ownership on the board, `docs/ARCHITECTURE.md`.
  Strip batch/process notes ("Batch 14 / KI4-…") from source comments.

## After the migration — product order

1. Sketch entity with internal constrained geometry (points/curves solved inside a sketch,
   not entity positions as `solve_constraints` does today) → the real 2D→3D bridge.
2. B-rep features on OCC: shell (K2), sweep/loft (K3), STEP export (NF5).
3. Drawings from 3D (sections, dimensions, sheets).
4. Unfreeze domain plugins (building, industrial, mechanisms) on the new contracts.

## Decisions needed (block the marked tasks)

| Id | Question | Recommendation | Blocks |
|----|----------|----------------|--------|
| D1 | Schema library | zod v4 | MG2 |
| D2 | npm workspaces monorepo | yes | MG6.1 |
| D3 | OCC WASM on the server (size, cold start) | yes, behind `LLULL_KERNEL` | MG1.4 |
| D4 | Document format v1 → v2/v3 with auto-migration on load (no v1 writer) | yes | MG3.2, MG4.2 |
| D5 | Feature freeze on domain commands during MG1–MG4 | yes | — |

## Risks

- **Golden corpus too thin** → regressions slip through MG3/MG4. Mitigation: add a corpus
  plan for every bug found during migration.
- **Kernel nondeterminism** (float output differs across WASM builds) breaks command-log
  sync. Mitigation: MG5.1 falls back to snapshot on a state-hash mismatch; hash sent with each
  broadcast.
- **MG4.1 type split touches everything.** Mitigation: accessors first, split second; both
  mechanical, reviewed by `cad-reviewer`.
- **Agent-facing schema text regresses during MG2.** Mitigation: MG2.4 snapshot test.

## Baseline vs result

| Metric | Baseline (MG0.4) | Result |
|--------|------------------|--------|
| Files > 500 code lines | 30 | 0 (`max-lines` enforced everywhere, no allowlist) |
| Module-level mutable state in `core` | kernel, id counter, 3 registry refs, 2 nesting counters | installed default kernel, id counter + scoped source, active context (all read through `ExecutionContext`) |
| Hand-written `paramsSchema` | 176 | 0 (every command uses `defineCommand` + zod) |
| `industrial_portal_crane` saved file | 600 808 B | 82 004 B (−86 %; building geometry re-derived on load) |
| `replay_history`, portal plan | 15.1 ms | 7.2 ms (warm replay cache) |
| `replay_history`, house template (1 step) | 6.6 ms | 8.4 ms (cache hashing overhead on a 1-step history) |
| Sync mechanisms | 3 (SSE patches, uiBridge, client-wins push) | 1 (command log + snapshot resync; offline outbox replays commands) |
| Test suite | 3 429 app / 251 server | 3 702 app / 259 server, golden corpus 35 plans × 2 |

## As built (deviations from the plan, with reasons)

- **MG1 (context).** Implemented as an explicit `ctx` third `run` argument **plus** a scoped active
  context (`runInContext`), so deep helpers (`nextId`) and nested `execute` calls inherit it without
  threading `ctx` through ~60 call sites. The kernel is memoized per installed kernel (MG4.4).
- **MG1.4.** OCC moved to `packages/kernel-occt` and loads in Node (`LLULL_KERNEL=occt`); three OCC
  bindings behind `fillet_edge` were broken and fixed. Browser `?kernel=occt` not re-verified live.
- **MG2.** zod v4 (D1). Some commands keep runtime leniency via `tolerant()` / `looseVec*` /
  `untypedArray()` where tests and agents relied on it; the agent-facing schema is byte-identical
  to before (snapshot-guarded). `guardCommand`'s generic checks (prototype-key ids, planar padding,
  NaN) stay as a registry-wide safety net. The MG0.2 conformance test is kept (cheap, still useful).
- **MG3.2 (v1 → v2).** v1 files are read unchanged instead of having their ids rewritten: a rewrite
  cannot be made exact without re-running kernel operations. Legacy ids stay valid, the positional
  id remap remains only for pre-v2 steps, and `nextStepNumber` is derived safely on load.
- **MG4.1.** The definition/evaluated split is a typed partition of the flat document
  (`definitionOf` / `evaluatedOf`), not a nested structure — same guarantees, no churn across
  ~1 000 `doc.entities` call sites.
- **MG4.2.** Files omit the geometry that is large and purely derivable (building-generated
  entities, the 600 KB case). Boolean/fillet meshes stay in files (≈2 KB in the corpus) because
  re-deriving them at load needs the kernel; they are memoized instead (MG4.4).
- **MG4.3.** Incremental regeneration is a replay **prefix cache** keyed by every input of each step,
  plus `set_parameter` regenerating when a live step reads a changed parameter. No explicit
  `reads` DAG is stored: the cache gives the same "re-run from the first affected step" effect
  without a second dependency model to keep consistent.
- **MG5.4 (history-based undo) — not adopted.** Undo stays snapshot-based on the server (the single
  owner); the client keeps snapshots only while offline, aligned with its command outbox. Replaying
  history cannot undo the non-step changes (`set_parameter`, `load_document`, `apply_code_trace`),
  and with structural sharing plus the replay cache, snapshots are already cheap.
- **MG6.1.** One `packages/domain-aec` instead of separate building/industrial packages: the two
  import each other (building evaluation generates industrial members). It still installs two
  plugins. `render` stays in `packages/core` because the export commands depend on it. The web app
  stays at the repo root (it is the workspace root); `server/` is not a workspace member.
- **Found and fixed along the way:** `build_project` + `insert_step` stored the wrong params for the
  inserted step (configurations replayed to an empty model); the building uid became deterministic
  with step ids and now uses `uniqueId()`; `list_steel_profiles` lower-case family names kept working
  via `tolerant()`; server typecheck (CI) was red on the base and is green now.
