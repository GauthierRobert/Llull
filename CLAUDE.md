# llull — agent operating manual

MCP-first **2D + 3D** CAD web app (AutoCAD-like): 2D drafting + 3D solids in one document.

## PRIME DIRECTIVE

**Never mutate the document outside a command.** UI and MCP both call `execute(doc, name, params)`.
One registered command = one UI action + one MCP tool. Editing entities in a component/server = bug.

## STACK (current; pick the best-suited stack per task — rule C7)

React 19 + TS strict + Vite · three.js + r3f + drei (3D perspective; 2D = same scene, ortho top-down) ·
Zustand (one store, `dispatch`) · zod v4 (one schema per command → TS type + MCP JSON Schema + validation) ·
kernels Manifold (default) / OpenCascade.js behind `GeometryKernel` · Vitest + Testing Library ·
ESLint flat + Prettier + knip · Express (optional MCP host + live doc) · Electron `desktop/` + bundled CPython/CadQuery ·
agents: local = `llull` CLI (`--app` drives desktop), cloud = MCP `/mcp`.
Not fixed: use the best-suited language / library for each task (e.g. Rust + wgpu for GPU solvers) — `conventions.md` C7.

## LAYER MAP (npm workspaces `packages/*`; web app + `server/` at root)

```
packages/core/src/        @core  framework-agnostic: NO react/DOM/window/fetch
  lib/                    @lib   pure leaf helpers (id, hash, polygon, triangulate, lruCache)
  model/                         types.ts (CadDocument, Entity, MeshData, ShapeRecipe) · vectors · units · building · civil
  geometry/                      kernel.ts (GeometryKernel) · shapeRecipe · shapeKernel · tessellation, bounds, instanceExpansion, massProperties
  dynamics/                      physicsEngine.ts (PhysicsEngine) · simulationModel · forceLaws · simulationReport
  commands/                      engine: types · schema (defineCommand, commandCatalog) · context · commandTable · execute · guard · registry
    <feature>/catalog.ts         solids draw2d modify2d edit brep inspect render exchange persistence history parametric project assembly motion dynamics document entity
  plugins/                       plugin.ts (CadPlugin) · host.ts (installPlugin, derivedEntityIds)
  codegen/                       CadQuery / build123d / OpenSCAD / FreeCAD emitters
packages/mcp/src/         @mcp   tools/resources/prompts/toolsets/discovery/liveSync over the registry
packages/domain-aec/src/  @aec   plugins `<domain>/{catalog,plugin}.ts`: building/ industrial/<discipline>/ civil/<topic>/ steel/ shared/
packages/domain-cae/src/  @cae   plugin `cae` (toolset analysis): 05 FEA set-up, decks, results, thermal/ thermomech/ margins/
packages/domain-aero/src/ @aero  plugins `sheetmetal` (toolset manufacturing, 07 FTR) and `fasteners` (toolset fasteners, 08 MAT)
packages/kernel-{manifold,occt}/src/   GeometryKernel impls
packages/physics-mujoco/src/           PhysicsEngine impl (MuJoCo WASM) — rigid-body dynamics, docs/DYNAMICS.md
src/app/                  @app   composition root: installDefaultPlugins()
src/ui/                   @ui    React: presentation + param-gathering ONLY
src/main.tsx                     installs kernel (`?kernel=occt`) + plugins, mounts <App>
server/                          Express MCP host + `llull` CLI (src/cli/); own package.json
desktop/                         Electron: starts server/, File menu, CLI hand-off; own package.json
```

Dependency law: `.claude/rules/architecture.md` L2, enforced by `npm run arch` + edit-time hook.

## RULES (authoritative)

@.claude/rules/architecture.md
@.claude/rules/conventions.md
@.claude/rules/workflow.md

Path-scoped (auto-load): `rules/commands.md` (packages/**, tests/**), `rules/sync.md` (MCP/server/store), `rules/react.md` (src/ui/**).
On demand: `.claude/context/command-layer.md` (signatures) · `.claude/context/model.md` (entity schema) ·
`docs/ARCHITECTURE.md` · `docs/ADD_A_TOOL.md` · `docs/ROADMAP.md` · `.claude/work/BOARD.md` (task board).

## AGENTS / SKILLS (descriptions come from the harness; delegation rules: workflow W5)

Agents: `command-author` · `viewport-engineer` · `mcp-engineer` · `test-verifier` · `cad-reviewer` (diffs touching core/registry/plugins/MCP).

## SKILLS

`design-model` `llull-cli` `add-command` `add-entity-kind` `fix-bug` `draw-2d` `parametric` `drawing-to-model` `measure`
`mcp-server` `viewport-feature` `verify-llull` `continue-working`

## COMMANDS

```bash
npm install          # root + workspaces (server/, desktop/ separately: npm --prefix <dir> install)
npm run dev          # http://localhost:5173
npm run check        # typecheck + arch + deadcode + lint + format:check + test — MUST pass before commit
npm run test:coverage  # gate 90/85/90/90 on core/{commands,geometry,dynamics} + domain-{aec,cae,aero}
npm run claude:lint  # after editing .claude/
npm run quality | production   # real-file gates (docs/QUALITY_GATES.md, docs/PRODUCTION_GATE.md)
node server/bin/llull.cjs help # CLI (llull-cli skill)
npm --prefix server test ; npm --prefix desktop test
```

## NON-NEGOTIABLES

1. Commands are pure (new doc, never mutate input; `is pure` test).
2. New command = `defineCommand({ name, description, params: z.object(…), run })` + registration (core: feature
   `catalog.ts`; domain: plugin `commands`) + unit test (happy + failure).
3. Coverage 90/85/90/90 on `packages/core/src/{commands,geometry,dynamics}/**` + `packages/domain-{aec,cae,aero}/src/**`.
4. Command/tool `name` is `snake_case`.
5. TS strict, no `any`, ≤500 code lines/file, `npm run check` green.
