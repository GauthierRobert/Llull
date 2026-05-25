# `.claude/` — llull's AI-first development layer

This directory is a first-class project artifact. It makes agentic development on
llull systematic and consistent. Inspired by the ECC "harness-native operator system"
pattern, scoped tightly to this app (no context bloat).

## Map

```
CLAUDE.md            (repo root) entrypoint; imports the rules; read this first
.mcp.json            (repo root) optional dev MCP server(s) — see "MCP" below
.claude/
  settings.json      permissions (fewer prompts) + hook wiring
  rules/             AUTHORITATIVE ruleset, imported by CLAUDE.md
    architecture.md    the laws L1–L9 (command-layer, deps, purity, 2D/3D, parametric, kernel)
    conventions.md     machine-first code style + structured doc-comment tags
    workflow.md        loop, branch/commit, testing, definition of done
    solid.md           SOLID principles mapped onto the command layer
    ai-context.md      keep the codebase clean & legible for AI agents
    react.md           React + r3f + Zustand best practices (on-demand; ui/ work only)
  agents/            focused subagents (delegate to these)
    command-author.md    add/modify commands in core/commands (+ tests)
    viewport-engineer.md 2D + 3D viewport (r3f), snapping & interaction
    mcp-engineer.md      MCP host over the registry
    test-verifier.md     tests + coverage gate + the check loop
    cad-reviewer.md      reviews a diff against the architecture laws
  skills/            invokable procedures (trigger on matching tasks)
    add-command/         the highest-leverage change: UI + MCP in one
    draw-2d/             2D drafting: entities, snapping, dimensions, sketch→solid
    parametric/          parameters, constraints, feature history (edit-and-regenerate)
    measure/             read-only measurement/inspection query tools
    mcp-server/          build/extend the MCP host
    viewport-feature/    implement/change 2D/3D viewport behavior
    verify-llull/        full verification loop (+ Playwright for UI)
  context/           deep references, loaded on demand (not auto-injected)
    command-layer.md     exact signatures of the command system
    model.md             document/entity schema (2D shapes + 3D solids) + invariants
  hooks/             guardrails + reminders (Node, cross-platform)
    session-start.mjs       injects invariants at session start
    enforce-architecture.mjs PreToolUse: blocks react/DOM/fetch in core/
    remind.mjs              PostToolUse: console.log + command-layer reminders
```

## How it fits together

- **CLAUDE.md** is always in context and imports the three `rules/` files. They are
  the law. `context/` files are pulled in only when an agent/skill needs the detail.
- **Hooks** enforce the one rule that's easy to violate silently (core/ purity of
  layering) and nudge on the rest — without slowing iteration.
- **Agents** are the default unit of work: delegate, parallelize, converge on
  `cad-reviewer`. **Skills** are the recipes those agents (and the main thread) follow.
- The design philosophy is **machine-first**: source optimizes for unambiguous AI
  parsing (explicit types, structured doc-comment tags, registry-driven discovery).
  Human-prose rationale lives in `docs/`.

## MCP (dev-time, optional)

`.mcp.json` enables **context7** for up-to-date three.js / react-three-fiber / drei
API docs while building the viewport. It runs via `npx` (you'll be prompted to approve
the server on first use). Remove the entry if you don't want it — it is a convenience,
not a requirement. The **Playwright** MCP server (browser automation for `verify-llull`)
is provided by the harness plugin and needs no config here.

> Not to be confused with llull's OWN MCP server (the product feature in `server/` +
> `core/mcp`), which exposes CAD commands to external agents. That is built by
> `mcp-engineer`, not configured here.

## Tuning

- Too many permission prompts? Run `/fewer-permission-prompts` or extend
  `settings.json` `permissions.allow`.
- A hook misfiring? Edit the matching script in `hooks/`; they fail open (never wedge
  a session). Set `"command"` to a no-op or remove the entry to disable.
