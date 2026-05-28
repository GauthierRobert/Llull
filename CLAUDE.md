# llull — agent operating manual

llull is a modern, MCP-first **2D + 3D** CAD web app — AutoCAD-like: 2D drafting and
3D solid modeling in one shared document. This file is the entrypoint for any
agent working on the codebase. It is optimized for machine consumption: terse,
structured, link-dense. Follow it literally.

## PRIME DIRECTIVE

> **Never mutate the document outside a command.** Both the UI and MCP call
> `execute(doc, name, params)`. Editing entities directly in a component or the
> MCP server is a bug. Write a command instead.

One command added to the registry = one new capability for **both surfaces**
(UI button + MCP tool — the latter drivable by Claude or any MCP agent) at once.
This is the whole design. Protect it.

## STACK (fixed — do not introduce alternatives without explicit approval)

| Concern    | Choice                                  |
| ---------- | --------------------------------------- |
| UI         | React 18 + TypeScript (strict) + Vite   |
| 3D viewport| three.js + @react-three/fiber + drei (perspective) |
| 2D viewport| same three.js scene, orthographic top-down; Line/Shape geometry |
| State      | Zustand (single store, `dispatch`)      |
| Tests      | Vitest + Testing Library                |
| Lint/fmt   | ESLint + Prettier (`npm run check`)     |
| Backend    | Node + Express (optional: AI proxy + MCP host) |

## LAYER MAP & DEPENDENCY LAW

```
ui/    React. Imports core. Presentation + param-gathering ONLY. No business logic.
core/  Framework-agnostic brain. NO react / DOM / window / fetch. Pure TS.
  model/     domain types (2D shapes + 3D solids) + createEmptyDocument()
  commands/  THE command layer — types.ts, registry.ts, geometry.ts
  mcp/       MCP tool definitions, generated from registry
lib/   Tiny pure helpers (id, math).
server/  Express MCP host (optional)
```

**Dependency direction is one-way: `ui → core → lib`. `core` MUST NOT import `ui`.**
This is enforced by a PreToolUse hook — a react/DOM/fetch import in `core/` is blocked.

## RULES (authoritative — read before editing)

@.claude/rules/architecture.md
@.claude/rules/conventions.md
@.claude/rules/workflow.md
@.claude/rules/solid.md
@.claude/rules/ai-context.md

## DEEP REFERENCES (load on demand, do not inline unless needed)

- React + r3f + Zustand UI best practices (`ui/` work only): `.claude/rules/react.md`
- Command layer internals & exact signatures: `.claude/context/command-layer.md`
- Document/entity schema reference: `.claude/context/model.md`
- Human-prose architecture rationale: `docs/ARCHITECTURE.md`
- Add-a-tool recipe (prose): `docs/ADD_A_TOOL.md`
- Roadmap / current milestone: `docs/ROADMAP.md`

## AGENTS (delegate; do not do everything in the main thread)

| Agent              | Use for                                                    |
| ------------------ | ---------------------------------------------------------- |
| `command-author`   | Adding/editing commands in `core/commands` (+ their tests) |
| `viewport-engineer`| 2D + 3D viewport (r3f), gizmos, snapping, interaction       |
| `mcp-engineer`     | MCP host (`core/mcp`, `server`) — the registry exposed to MCP agents |
| `test-verifier`    | Writing tests, hitting the coverage gate, running checks   |
| `cad-reviewer`     | Reviewing a diff against the architecture laws             |

Multi-agent is the default workflow. Parallelize independent work; converge on review.

## SKILLS (invoke when the trigger matches)

- `design-model` — design a complete CAD model/assembly end-to-end by composing existing commands into a validated `build_project` plan, then measure/check/render/export
- `add-command` — add a CAD operation (the most common task; UI + MCP in one)
- `draw-2d` — add/extend 2D drafting (lines, arcs, polylines, dimensions, snapping, sketch→solid)
- `parametric` — parameters, constraints, feature history (edit-and-regenerate)
- `measure` — read-only measurement/inspection tools (distance, area, volume, mass)
- `mcp-server` — build/extend the MCP host over the registry
- `viewport-feature` — implement or change 2D/3D viewport behavior
- `verify-llull` — run the full verification loop and (optionally) drive the app

## COMMANDS

```bash
npm install
npm run dev          # app at http://localhost:5173
npm run check        # typecheck + lint + test — MUST pass before commit
npm run test:coverage
npm --prefix server install && npm --prefix server run dev   # optional backend
```

## NON-NEGOTIABLES (the coverage gate / CI will reject otherwise)

1. Commands are **pure**: return a new document, never mutate the argument. A test
   enforces this (`is pure`).
2. New command ⇒ registered in `registry.ts` ⇒ has a unit test (happy + failure path).
3. `core/commands/**` holds **90% statements / 85% branches / 90% functions / 90% lines**.
4. Tool/command `name` is `snake_case` (it is the MCP tool name that agents call).
5. TypeScript strict, no `any`. `npm run check` green.
