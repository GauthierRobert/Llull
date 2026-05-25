# RULE: ai-context (keep the codebase clean for AI agents)

llull is built by AI agents working in parallel. Source is optimized for **machine parsing and
local reasoning**, so an agent loads little context, reasons correctly, and edits safely.
These are obligations, not suggestions.

## AC1 — Discovery over documentation
An agent should *find* a thing by name and path, not by reading prose. Clear names, one concern
per file, re-export through `registry.ts`. If you reach for a paragraph to explain where
something is, fix the structure instead.

## AC2 — Types and tags, not narration
Encode facts in the type system (conventions C1) and the structured doc-comment tags
(`@command @pure @layer @affects @invariant @failure`, C2). Delete any comment that restates the
code. No paragraph explanations in source — prose lives in `docs/`.

## AC3 — Small files, small functions
Keep files focused and short so an agent loads only what the task needs; large files burn the
context window and invite merge conflicts. Split by domain (`transform.ts`, `boolean.ts`).

## AC4 — Local reasoning = purity + single store
Commands are pure (architecture L3); a command can be understood without the rest of the app.
No hidden global state — the `CadDocument` store is the only state (L4). This is what lets an
agent (or undo, or replay) reason about one change in isolation.

## AC5 — Summaries and schemas are the AI's eyes
A command's `summary` is the feedback signal fed back to the AI — make it factual and specific
(ids, sizes, counts). `paramsSchema` `description`s are written for an agent that cannot see the
code. Vague summaries/descriptions blind the next agent.

## AC6 — No noise
No dead code, no unused exports, no `console.log` in committed code (conventions C7). Noise
pollutes search results and wastes the context of every agent that reads after you.

## AC7 — Literal, full-word names
`selectedEntityIds`, not `sel` (conventions C3). Ambiguous names cost tokens and cause wrong
edits. Snake_case for tool/command `name`; that string is the AI/MCP tool id.

## AC8 — Co-locate tests with the change
The test is executable documentation of intent for the next agent. New `core/` logic ⇒ test in
the same change (workflow W1). Assert observed behavior, not internals (W3).

## AC9 — One source of truth; link, don't duplicate
Reference `.claude/rules/*` and `.claude/context/*` rather than restating them. Keep `CLAUDE.md`
and rules lean and load heavy detail on demand. Duplicated guidance drifts and contradicts.

## AC10 — Minimal, uniform diffs
Make the smallest change that does the job and match the surrounding style, so the codebase
reads as if written by one author. A consistent code surface is faster and safer for a model to
edit than a clever, idiosyncratic one.
