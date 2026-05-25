# llull

> Named after Ramon Llull, whose *Ars Magna* mechanized reasoning by combining
> primitives — exactly what this app does with CAD operations.

A modern, web-based **2D + 3D** CAD application — an AutoCAD reimagined to be
beautiful and easy to use: 2D drafting and 3D solid modeling in one shared document,
with **MCP usability as its defining feature**. The core bet:
**every operation is a command**, and every command is drivable by a human (UI)
or by any external agent — Claude or any MCP client — over MCP, through the exact
same code path.

llull is developed **AI-first**: the [`CLAUDE.md`](CLAUDE.md) entrypoint and the
[`.claude/`](.claude) directory (rules, agents, skills, hooks) are first-class
project artifacts. Read [`CLAUDE.md`](CLAUDE.md) before contributing with an agent.

## Stack

| Concern        | Choice                                   | Why |
| -------------- | ---------------------------------------- | --- |
| UI             | React 18 + TypeScript + Vite             | Lightweight, best-in-class 3D ecosystem |
| 3D viewport    | three.js + @react-three/fiber + drei     | Mature, declarative Three.js |
| State          | Zustand                                  | One store, no boilerplate, easy to drive externally |
| Tests          | Vitest + Testing Library                 | Fast, Vite-native |
| Lint / format  | ESLint + Prettier                        | Consistent, enforced in CI |
| Backend (opt.) | Node + Express                           | Only for hosting the MCP endpoint |

## Architecture in one picture

```
Document Model (Zustand store)  ← entities, layers, selection, camera
        ▲
Command Layer (pure functions)  ← add_box, extrude_profile, move_entity, ...
        ▲                  ▲
   React UI           MCP Server (Claude / any MCP agent)
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before writing code. It
explains the command-layer pattern that the entire project depends on.

## Getting started

```bash
npm install
npm run dev          # start the app at http://localhost:5173
npm run check        # typecheck + lint + test (run before every commit)
```

Optional backend (the MCP host):

```bash
cp .env.example .env # set MCP_AUTH_TOKEN (and PORT) for the MCP endpoint
npm --prefix server install
npm --prefix server run dev
```

## Project layout

```
src/
  core/         # framework-agnostic brain — no React imports allowed here
    model/      # document types + factory
    commands/   # the command layer (the heart of the app)
    mcp/        # MCP tool definitions (generated from the registry)
  ui/           # React: viewport, panels, store binding
  lib/          # tiny shared utilities
server/         # Express MCP host (optional)
tests/          # unit + integration
docs/           # architecture, conventions, contributing, roadmap
```

## The golden rule

> **Never mutate the document outside a command.** Both the UI and MCP call
> `execute(doc, name, params)`. If you find yourself editing entities directly
> in a component, stop and write a command instead.

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the full workflow and
[`docs/ADD_A_TOOL.md`](docs/ADD_A_TOOL.md) for the 3-step recipe to add a new tool.
