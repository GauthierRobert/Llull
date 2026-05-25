# Architecture

## The core idea: one command layer, two callers

The hardest requirement of this project is "everything controllable by AI."
The naive approach — building UI features, then separately building AI
integrations for each — leads to duplicated logic and drift. We avoid that with
a single **command layer**. AI control is delivered through MCP, not a bespoke
in-app integration.

A *command* is a pure function:

```ts
(document, params) => { document, summary, affected }
```

It takes the current document and parameters, and returns a *new* document plus
metadata. It never mutates its input and never touches React, the DOM, or the
network.

Two callers invoke the same commands:

1. **React UI** — a button or gizmo gathers params and calls `execute(...)`.
2. **MCP Server** — tool schemas auto-generated from the command registry are
   served over MCP, so any external agent (Claude or any MCP client) can call the
   same `execute(...)`.

Because both converge on the registry, **any operation a human can do, an agent
can do, for free.** Add a command once; both surfaces gain it.

## Layers and their rules

```
┌────────────────────────────────────────────┐
│ ui/        React. May import core. Holds NO  │
│            business logic — only presentation │
│            and param-gathering.               │
├────────────────────────────────────────────┤
│ core/      Framework-agnostic. NO React, NO   │
│   model/   DOM, NO fetch. Pure TypeScript.    │
│   commands/                                   │
│   ai/      (fetch lives behind an interface)  │
│   mcp/                                         │
├────────────────────────────────────────────┤
│ lib/       Tiny pure helpers (ids, math).     │
└────────────────────────────────────────────┘
```

**Dependency direction is one-way:** `ui → core → lib`. `core` must never
import from `ui`. This is what keeps the brain testable in isolation and
reusable by the headless MCP server.

## State management

The document lives in a single Zustand store (`ui/store`). The store exposes a
`dispatch(commandName, params)` method that:

1. calls `execute(currentDoc, name, params)` from the registry,
2. swaps in the returned document,
3. pushes the previous document onto an undo stack.

Undo/redo is therefore trivial: commands are pure, so we just keep snapshots.

## Why no backend in v1

Everything — model, commands, rendering — runs in the browser. A backend is
only required for:

- **MCP host:** MCP is a running process exposing tools over a transport, so it
  cannot live inside a static site. The Express server serves `/mcp`, forwarding
  every tool call to the same command registry the UI uses.

It is an optional add-on; llull is fully usable offline without it.

## Data flow of an AI edit (via MCP)

```
Agent (Claude or any MCP client) is told to "make a 3-story tower"
        │
        ▼
Agent discovers tools from the MCP host (schemas == toToolSchemas())
        │
        ▼
Agent calls tools over MCP: add_box {...} ×3
        │
        ▼
For each tool call: execute("add_box", params) on the shared document
        │
        ▼
execute() runs the pure command → new document
        │
        ▼
Zustand updates → React-Three-Fiber re-renders the live viewport
```

The agent edits the same document the UI does because it is calling the same
`execute` the buttons call — there is no separate "AI mode."

## Testing strategy

- **Unit tests** target `core/commands` heavily (90% coverage threshold). These
  are pure functions, so they're fast and exhaustive.
- **Integration tests** exercise `store.dispatch` end-to-end (command → store →
  undo).
- **Component tests** (Testing Library) cover panels and param-gathering, not
  geometry math.

The coverage gate is intentionally concentrated on the command layer because
that is the code both humans and the AI depend on for correctness.
