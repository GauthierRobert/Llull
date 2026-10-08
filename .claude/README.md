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
  rules/             AUTHORITATIVE ruleset (auto-loaded by Claude Code)
    architecture.md    always — the laws L1–L10
    conventions.md     always — machine-first code style
    workflow.md        always — loop, commit, testing, done, delegation threshold
    commands.md        paths: packages/**, tests/** — command skeleton, parametric/kernel/plugin as-built
    sync.md            paths: packages/mcp, server, src/ui/store, src/app — live sync + MCP host
    react.md           paths: src/ui/** — React + r3f + Zustand
  agents/            focused subagents (delegate when it pays — workflow W5)
    command-author.md    add/modify commands in packages/core or a plugin (+ tests)
    viewport-engineer.md 2D + 3D viewport (r3f), snapping & interaction
    mcp-engineer.md      MCP host over the registry
    test-verifier.md     tests + coverage gate + the check loop
    cad-reviewer.md      reviews a diff against the architecture laws (fixed terse output)
  skills/            invokable procedures (only the description loads until triggered)
    add-command/         the highest-leverage change: UI + MCP in one
    add-entity-kind/     new 2D/3D kind — checklist of every (mostly silent) dispatch site
    fix-bug/             reproduce first (failing test / golden plan), root cause, minimal fix
    draw-2d/             2D drafting: entities, snapping, dimensions, sketch→solid
    parametric/          parameters, constraints, feature history (edit-and-regenerate)
    measure/             read-only measurement/inspection query tools
    design-model/        use llull AS a CAD tool: build_project plans end-to-end
    mcp-server/          build/extend the MCP host
    viewport-feature/    implement/change 2D/3D viewport behavior
    verify-llull/        full verification loop (+ Playwright for UI)
    continue-working/    resume the build from work/BOARD.md
  context/           deep references, loaded on demand (not auto-injected)
    command-layer.md     exact signatures of the command system
    model.md             document/entity schema (2D shapes + 3D solids) + invariants
  hooks/             guardrails (Node, cross-platform, fail open, one process per event)
    session-start.mjs        SessionStart: per-session state only (branch, dirty files, deps, board NOW)
    enforce-architecture.mjs PreToolUse: blocks L2 violations; newly introduced `any`, max-lines
                             disables, `.only`/`.skip` in tests
    post-edit.mjs            PostToolUse: Prettier on the edited file + console.log/command reminders
    stop-gate.mjs            Stop: blocks once if package src changed w/o tests, a snapshot changed,
                             or claude-lint fails (LLULL_STOP_VERIFY=1 also runs `vitest related`)
    claude-lint.mjs          `npm run claude:lint`: every skill/agent/path reference resolves
```

## How it fits together

- **Context budget.** Always loaded: CLAUDE.md + 3 rules (~4.5k tokens). Path-scoped rules load
  only when a matching file is touched; `context/` and skills load only on demand. Keep it so:
  new guidance goes in a path-scoped rule or a skill, not in an always-on file.
- **Hooks** enforce what is cheap to check mechanically (layering, `any`, skipped tests,
  formatting, tests-with-changes) — each one regex/`git status` only, no test runs by default.
- **Agents** are used when they pay (≥ 2 independent lanes or > ~4 files); otherwise work in the
  main thread. **Skills** are the recipes both follow.
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
> `packages/mcp`), which exposes CAD commands to external agents. That is built by
> `mcp-engineer`, not configured here.

## Tuning

- Too many permission prompts? Run `/fewer-permission-prompts` or extend
  `settings.json` `permissions.allow`.
- A hook misfiring? Edit the matching script in `hooks/`; they fail open (never wedge
  a session). Set `"command"` to a no-op or remove the entry to disable.
