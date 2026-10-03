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

## For construction companies

llull includes a building (AEC / BIM) workspace: levels, structural grids, parametric walls with
hosted doors and windows, slabs, columns, beams, stairs and rooms; quantity takeoff, schedules and
cost estimates; and deliverables the industry opens — scaled plan sheets with title block, DXF for
AutoCAD users and IFC4 for BIM coordination. See [`docs/CONSTRUCTION.md`](docs/CONSTRUCTION.md).

For factory builders: a steel profile catalogue, steel members, a one-step portal-frame hall
generator (frames, purlins, rails, bracing, footings, cladding, crane runway), process equipment
and pipe runs, clash detection, steel tonnage / cut lists, and elevation / section sheets. See
[`docs/INDUSTRIAL.md`](docs/INDUSTRIAL.md).

## Stack

| Concern        | Choice                                   | Why |
| -------------- | ---------------------------------------- | --- |
| UI             | React 18 + TypeScript + Vite             | Lightweight, best-in-class 3D ecosystem |
| 3D viewport    | three.js + @react-three/fiber + drei     | Mature, declarative Three.js |
| State          | Zustand                                  | One store, no boilerplate, easy to drive externally |
| Schemas        | zod                                      | One schema per command: TS type, MCP JSON Schema and runtime validation |
| Geometry kernel| Manifold (default) / OpenCascade.js      | Booleans and fillets behind one interface |
| Tests          | Vitest + Testing Library + Playwright    | Fast, Vite-native |
| Lint / format  | ESLint + Prettier                        | Consistent, enforced by `npm run check` |
| Backend (opt.) | Node + Express                           | Only for hosting the MCP endpoint |

## Architecture in one picture

```
Document (recipe + evaluated)   ← feature history, parameters, entities, layers, ...
        ▲
Command Layer (pure functions)  ← add_box, extrude_sketch, move_entity, ... + plugins
        ▲                  ▲
   React UI  ◄── /live ──  MCP Server (Claude / any MCP agent)
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before writing code. It
explains the command-layer pattern that the entire project depends on.

## Getting started

```bash
npm install          # installs the root app and every packages/* workspace
npm run dev          # start the app at http://localhost:5173
npm run check        # typecheck + lint + format check + test (run before every commit)
npm run test:e2e     # Playwright end-to-end tests in Chromium (starts the dev server)
```

Optional backend (the MCP host):

```bash
cp .env.example .env # set MCP_AUTH_TOKEN (and PORT) for the MCP endpoint
npm --prefix server install
npm --prefix server run dev
```

## Production

```bash
npm ci && npm run build            # static web app in dist/ — serve with any static host
npm ci --prefix server
npm --prefix server run build      # bundles the MCP host to server/dist/index.js
MCP_AUTH_TOKEN=<secret> npm --prefix server start
```

- Requires Node >= 20.12. Variables are read from the environment, `.env`, or `server/.env`.
- The server binds `127.0.0.1:3001` by default. Binding a non-loopback `HOST` requires
  `MCP_AUTH_TOKEN`; remote REST mutations then need the bearer token too.
- Serve the web app from an origin listed in `LLULL_ALLOWED_ORIGINS`, and list public
  hostnames in `LLULL_ALLOWED_HOSTS` (DNS-rebinding guard).
- The OpenCascade kernel (~65 MB wasm) loads only with `?kernel=occt`; the default is Manifold.
- Web app build vars: `VITE_LLULL_SERVER_URL` (server base URL), `VITE_LLULL_API_TOKEN` (bearer for REST when the server requires it).
- Full env reference: [`server/README.md`](server/README.md).

## STEP and parametric code

`export_code` writes the model as **CadQuery, build123d, OpenSCAD or a FreeCAD macro**.
Parameters become variables, parameter-driven dimensions stay expressions, and features keep
their history order. Edited CadQuery/build123d code comes back through the MCP tool
`import_code` as an editable feature history. With the optional Python bridge
(`pip install -r server/python/requirements.txt`), the MCP server also offers
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
  ui/                    # React: viewport, panels, store
server/                  # Express MCP host (optional)
tests/                   # unit, contract, golden corpus, integration, component, e2e
docs/                    # architecture, contributing, roadmap, domain guides
```

## The golden rule

> **Never mutate the document outside a command.** Both the UI and MCP call
> `execute(doc, name, params)`. If you find yourself editing entities directly
> in a component, stop and write a command instead.

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) for the full workflow and
[`docs/ADD_A_TOOL.md`](docs/ADD_A_TOOL.md) for the 3-step recipe to add a new tool.
