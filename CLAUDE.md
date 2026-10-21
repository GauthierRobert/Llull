# llull — agent operating manual

**Local-first 2D + 3D CAD** (AutoCAD-like): 2D drafting + 3D solids in one document, used through the **desktop app** (Electron)
and the **`llull` CLI** on the user's own machine.

## PRODUCT DIRECTIVE (owner, 2026-10-19 — binding)

- **CLI + local only.** No browser / web deployment, no PWA, no cloud host. The React UI runs only inside the Electron desktop app;
  agents drive llull through the `llull` CLI (`--app` for the open desktop app). There is no MCP server (removed, LC1 step 4).
- **Optimize for that.** Native code (Rust sidecars, native OCCT kernel, local GPU) is the target path; anything that exists only to
  make llull run in a browser (WASM kernels as the primary path, browser-only fallbacks, PWA, web hosting, browser e2e) is legacy:
  do not extend it, and remove it once its native replacement is the default (plan: `docs/decisions/LC1-local-only.md`).
- Still true: offline, no network needed (AF-41); every change goes through a registered command (PRIME DIRECTIVE).

## PRIME DIRECTIVE

**Never mutate the document outside a command.** UI and CLI both call `execute(doc, name, params)`.
One registered command = one UI action + one CLI tool. Editing entities in a component/server = bug.

## STACK (current; pick the best-suited stack per task — rule C7)

React 19 + TS strict + Vite · three.js + r3f + drei (3D perspective; 2D = same scene, ortho top-down) ·
Zustand (one store, `dispatch`) · zod v4 (one schema per command → TS type + tool JSON Schema + validation) ·
kernels behind `GeometryKernel`: native OCCT sidecar `llull-kernel` (the exact kernel) and Manifold WASM (in-process mesh kernel: renderer, tests, fallback) ·
Rust workspace `solver/` (`llull-compute`, `llull-kernel`) · Vitest + Testing Library · ESLint flat + Prettier + knip ·
Express local backend (live doc, CLI host) · Electron `desktop/` + bundled CPython/CadQuery + native binaries ·
agents: `llull` CLI only (`--app` drives the desktop app); no MCP server.
Not fixed: use the best-suited language / library for each task (e.g. Rust + wgpu for GPU solvers) — `conventions.md` C7.

## LAYER MAP (npm workspaces `packages/*`; web app + `server/` at root)

```
packages/core/src/        @core  framework-agnostic: NO react/DOM/window/fetch
  lib/                    @lib   pure leaf helpers (id, hash, polygon, triangulate, lruCache)
  model/                         types.ts (CadDocument, Entity, MeshData, ShapeRecipe) · documentExtensions.ts (plugin slice extension point) · vectors · units
  geometry/                      kernel.ts (GeometryKernel) · shapeRecipe · shapeKernel · tessellation, bounds, instanceExpansion, massProperties
  dynamics/                      physicsEngine.ts (PhysicsEngine port only; the rigid-body domain is packages/domain-dynamics)
  commands/                      engine: types · schema (defineCommand, commandCatalog) · context · commandTable · execute · guard · registry
    <feature>/catalog.ts         solids draw2d modify2d edit brep surface features inspect render exchange persistence history parametric
                                 project assembly motion document entity drawings pmi materials materiallab review
  plugins/                       plugin.ts (CadPlugin) · host.ts (installPlugin, derivedEntityIds)
  codegen/                       CadQuery / build123d / OpenSCAD / FreeCAD emitters
packages/protocol/src/    @protocol  host protocol over the registry: liveSync · restProtocol · CLI tools (exchange/fea/library) · toolsets · search
packages/domain-aec/src/  @aec   plugins `<domain>/{catalog,plugin}.ts`: building, industrial (toolset building), civil, piping (plant/piping/),
                                 scan; plus steel/ shared/
packages/domain-cae/src/  @cae   plugins `cae` (05 FEA set-up, decks, results, thermal (+ analytic check, view factors), thermomech (+ fit at temperature), vnv (convergence, benchmark judge), nonlinear, dynamics, margins…), `topology`,
                                 `explicit` — all toolset analysis
packages/domain-aero/src/ @aero  plugins aerodynamics + surfacing (toolset aerodynamics) · sheetmetal + composites (toolset manufacturing) ·
                                 fasteners · fluids · cfd (toolset flow)
packages/domain-dynamics/src/ @dynamics  plugin `dynamics` (toolset assembly): bodies, joints, gears, motors, propellers, cylinders, engine laws, simulate_motion, loads, mechanism checks (sim/ logic, commands/); docs/DYNAMICS.md
packages/design-lang/src/ @design  plugin `design`: `.lld` text designs (one recipe step, re-run on regeneration); removable — docs/DESIGN_LANGUAGE.md
packages/plm/src/         @plm   plugin `plm` (09 PLM): managed item, revisions + release lock (guard), change control (ECR/ECO), effectivity,
                                 EBOM/MBOM + baselines, signatures, characteristics/FAI, QIF import, AP242 PDM export, LOTAR, local vault
packages/kernel-manifold/src/          GeometryKernel impl (mesh); the exact B-rep kernel is the native sidecar in solver/ (no TS package)
packages/physics-mujoco/src/           PhysicsEngine impl (MuJoCo WASM) — rigid-body dynamics, docs/DYNAMICS.md
src/app/                  @app   composition root: installDefaultPlugins()
src/ui/                   @ui    React: presentation + param-gathering ONLY
src/main.tsx                     renderer entry: installs Manifold + plugins, mounts <App> (Electron only)
server/                          Express local backend (live doc, exchange, exports) + `llull` CLI (src/cli/); own package.json
desktop/                         Electron: starts server/, File menu, CLI hand-off; own package.json
```

Dependency law: `.claude/rules/architecture.md` L2, enforced by `npm run arch` + edit-time hook.

## RULES (authoritative)

@.claude/rules/architecture.md
@.claude/rules/conventions.md
@.claude/rules/workflow.md

Path-scoped (auto-load): `rules/commands.md` (packages/**, tests/**), `rules/sync.md` (protocol/server/store), `rules/react.md` (src/ui/**).
On demand: `.claude/context/command-layer.md` (signatures) · `.claude/context/model.md` (entity schema) ·
`docs/ARCHITECTURE.md` · `docs/ADD_A_TOOL.md` · `docs/ROADMAP.md` · `.claude/work/BOARD.md` (task board).

## SKILLS (descriptions + agents come from the harness; delegation: workflow W5; names kept in sync by `claude:lint`)

`add-command` `add-entity-kind` `continue-working` `design-model` `draw-2d` `drawing-to-model` `fix-bug` `llull-cli` `measure`
`parametric` `verify-llull` `viewport-feature`

## COMMANDS

```bash
npm install          # root + workspaces (server/, desktop/ separately: npm --prefix <dir> install)
npm --prefix desktop run build && npm --prefix desktop start   # run the desktop app (desktop/README.md)
npm run dev          # Vite renderer dev server (HMR) for UI iteration only; verify in the desktop app
npm run check        # typecheck + arch + deadcode + lint + format:check + native:check (solver/; skipped without cargo) + test — MUST pass before commit
npm run test:coverage  # gate 90/85/90/90 on core/{commands,geometry,dynamics} + domain-{aec,cae,aero,dynamics} + design-lang + plm
npm run claude:lint  # after editing .claude/
npm run quality | production   # real-file gates (docs/QUALITY_GATES.md, docs/PRODUCTION_GATE.md)
node server/bin/llull.cjs help # CLI (llull-cli skill)
npm --prefix server test ; npm --prefix desktop test
```

## NON-NEGOTIABLES

1. Commands are pure (new doc, never mutate input; `is pure` test).
2. New command = `defineCommand({ name, description, params: z.object(…), run })` + registration (core: feature
   `catalog.ts`; domain: plugin `commands`) + unit test (happy + failure).
3. Coverage 90/85/90/90 on `packages/core/src/{commands,geometry,dynamics}/**` + `packages/{domain-aec,domain-cae,domain-aero,domain-dynamics,design-lang,plm}/src/**`.
4. Command/tool `name` is `snake_case`.
5. TS strict, no `any`, ≤500 code lines/file, `npm run check` green.
