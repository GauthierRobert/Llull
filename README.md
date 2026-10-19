# llull

> Named after Ramon Llull, whose *Ars Magna* mechanized reasoning by combining
> primitives — exactly what this app does with CAD operations.

A modern **2D + 3D** CAD application for the desktop and the command line — an AutoCAD
reimagined to be beautiful and easy to use: 2D drafting and 3D solid modeling in one shared
document, driven equally well by a person and by an agent. The core bet:
**every operation is a command**, and every command is drivable by a human (the desktop app)
or by an agent (the `llull` CLI, e.g. from Claude Code), through the exact same code path.
llull is local only: the React UI runs inside the Electron desktop app, nothing needs the
network, and there is no browser or cloud deployment ([`docs/decisions/LC1-local-only.md`](docs/decisions/LC1-local-only.md)).

llull is developed **AI-first**: the [`CLAUDE.md`](CLAUDE.md) entrypoint and the
[`.claude/`](.claude) directory (rules, agents, skills, hooks) are first-class
project artifacts. Read [`CLAUDE.md`](CLAUDE.md) before contributing with an agent.

## For construction companies

llull includes a building (AEC / BIM) workspace: levels, structural grids, parametric walls with
hosted doors and windows, slabs, columns, beams, stairs and rooms; quantity takeoff, schedules and
cost estimates; and deliverables the industry opens — scaled plan sheets with title block, DXF for
AutoCAD users and IFC4 for BIM coordination. See [`docs/CONSTRUCTION.md`](docs/CONSTRUCTION.md).

For factory builders: a steel profile catalogue, steel members, a one-step portal-frame hall
generator (frames, purlins, rails, bracing, footings, cladding, crane runway), process equipment
and pipe runs, clash detection, steel tonnage / cut lists, and elevation / section sheets. See
[`docs/INDUSTRIAL.md`](docs/INDUSTRIAL.md).

For civil / site engineers: survey import (CSV / TXT / DXF), existing-ground TIN surfaces with
contours, building pads with cut / fill volumes and cut-fill balancing, road alignments (curves,
vertical profile, road template, corridor, long and cross sections, earthwork volumes and mass
haul, design-speed checks), gravity storm networks (Manning, rational method, automatic pipe
sizing), and LandXML 1.2 / DXF exchange with Civil 3D, 12d and BricsCAD. Any ASCII DXF drawing
imports as editable entities. See [`docs/CIVIL.md`](docs/CIVIL.md). Evaluating llull for a civil
office? Click **Civil site starter** on the empty app for a complete sample site, then follow the
45-minute pilot guide with your own survey: [`docs/PILOT.md`](docs/PILOT.md).

## Stack

| Concern        | Choice                                   | Why |
| -------------- | ---------------------------------------- | --- |
| UI             | React 19 + TypeScript, in Electron       | Best-in-class 3D ecosystem; Vite bundles the renderer |
| 3D viewport    | three.js + @react-three/fiber + drei     | Mature, declarative Three.js |
| State          | Zustand                                  | One store, no boilerplate, easy to drive externally |
| Schemas        | zod                                      | One schema per command: TS type, tool JSON Schema and runtime validation |
| Geometry kernel| Manifold (default) / OpenCascade.js      | Booleans and fillets behind one interface |
| Tests          | Vitest + Testing Library + Playwright    | Fast, Vite-native |
| Lint / format  | ESLint + Prettier                        | Consistent, enforced by `npm run check` |
| Local backend  | Node + Express                           | Started by the desktop app or the CLI; same registry |

## Architecture in one picture

```
Document (recipe + evaluated)   ← feature history, parameters, entities, layers, ...
        ▲
Command Layer (pure functions)  ← add_box, extrude_profile, move_entities, ... + plugins
        ▲                  ▲
   Desktop UI ◄── /live ── local backend ◄── `llull` CLI (you / Claude Code)
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before writing code. It
explains the command-layer pattern that the entire project depends on.

## Getting started

```bash
npm install                                   # root app + every packages/* workspace
npm --prefix server install                   # local backend + `llull` CLI
npm --prefix desktop install                  # Electron shell
npm --prefix desktop run build && npm --prefix desktop start   # the desktop app
node server/bin/llull.cjs help                # the CLI (agents: `llull ... --app` drives the open app)
npm run check        # typecheck + arch + deadcode + lint + format check + test (run before every commit)
npm run dev          # renderer dev server (http://localhost:5173) for UI work
npm run test:e2e     # Playwright tests of the UI renderer (starts the dev server)
```

## Desktop app

```bash
npm --prefix desktop run dist      # installable app: renderer + local backend + CLI + Python/CadQuery
```

- Requires Node >= 22.12. The desktop app starts its own backend on `127.0.0.1` with a per-launch
  token and serves the renderer from it; nothing listens on another interface.
- Kernel: the backend and the CLI pick it with `LLULL_KERNEL` (`manifold`, `occt`, `occt-native`);
  the renderer runs Manifold in-process for the commands it executes itself.
- Packaging, signing and the CLI hand-off: [`desktop/README.md`](desktop/README.md). Backend env
  reference: [`server/README.md`](server/README.md).

## STEP and parametric code

`export_code` writes the model as **CadQuery, build123d, OpenSCAD or a FreeCAD macro**.
Parameters become variables, parameter-driven dimensions stay expressions, and features keep
their history order. Edited CadQuery/build123d code comes back through the command
`import_code` as an editable feature history. With the Python bridge (bundled in the desktop
app, or `pip install -r server/python/requirements.txt`), the backend also offers
`export_step` (exact B-rep through OpenCascade) and `import_step`. See
[docs/CAD_EXCHANGE.md](docs/CAD_EXCHANGE.md).

## Project layout

```
packages/                # npm workspaces — framework-agnostic, no React / DOM / fetch
  core/src/              # model, command layer (the heart of the app), execution context,
                         #   persistence, geometry kernel interface, plugin host, lib helpers
  mcp/src/               # MCP tools, toolsets, discovery, live-sync protocol
  domain-aec/src/        # building (BIM) and industrial plugins
  kernel-manifold/src/   # Manifold geometry kernel (default)
  kernel-occt/src/       # OpenCascade geometry kernel
src/
  app/                   # composition root: installs the default plugins
  ui/                    # React: viewport, panels, store (rendered by the desktop app)
server/                  # local backend + `llull` CLI
desktop/                 # Electron app: starts the backend, File menu, CLI hand-off
tests/                   # unit, contract, golden corpus, integration, component, e2e
docs/                    # architecture, contributing, roadmap, domain guides
```

## The golden rule

> **Never mutate the document outside a command.** The UI, the CLI and MCP all call
> `execute(doc, name, params)`. If you find yourself editing entities directly
> in a component, stop and write a command instead.

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the full workflow and
[`docs/ADD_A_TOOL.md`](docs/ADD_A_TOOL.md) for the 3-step recipe to add a new tool.
