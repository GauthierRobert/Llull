---
name: continue-working
description: Drive the llull build forward autonomously from the task board. Use whenever the user says "continue working", "continue", "keep going", "what's next", "resume", "next task", or otherwise asks to make progress without naming a specific task. Reads .claude/work/BOARD.md, reconciles it against the real repo, then launches parallel agents (default 4 lanes) on the next eligible tasks and writes the board back. This is the project's stateful, self-pacing workflow.
---

# Skill: continue-working

The board (`.claude/work/BOARD.md`) is the memory between turns. The user says
**"continue working"**; you figure out what's next and run it in parallel. Never ask the
user which task — the board decides. Only ask when a `[BLOCKED]` task is the only thing left,
or a decision in the Decision log is required.

## Procedure (run every time)

### 1. Read the board
Open `.claude/work/BOARD.md`. Note each task's status, deps, and lane.

### 2. Reconcile against reality (ground truth = the repo, not the board)
The board can be stale (a prior agent finished, a session ended mid-task). Verify:
- For each `[WIP]`/`[REVIEW]` task, check whether its deliverable exists (the files/exports it
  promised) and `npm run check` is green. If so → flip to `[DONE]` (after `cad-reviewer` for
  `[REVIEW]`). If a `[WIP]` task has no progress in the repo, treat it as `[TODO]` again.
- Use `Glob`/`Grep`/`Read` to confirm; don't trust the token blindly.

### 3. Select the next batch
- A task is **eligible** if status is `[TODO]` and every dep is `[DONE]`.
- Pick **one eligible task per free lane**, up to **4 lanes in parallel** (Lane 5 review is
  separate and runs after, not as one of the 4). Prefer the lowest-ID eligible task per lane.
- Lanes own disjoint files (see board table) so parallel writes never collide. Never run two
  tasks that both edit `src/core/commands/registry.ts` — only Lane 1 touches it.
- Skip `[BLOCKED]` tasks. If the *only* remaining work is blocked, surface the Decision-log
  item to the user and stop.

### 4. Mark WIP + launch
- Edit the board: flip the chosen tasks to `[WIP]`, update the **NOW** block (timestamp, WIP
  list, next-up), and write it.
- Launch the lane agents **in one message, in parallel** (multiple `Agent` calls in a single
  turn). Map lane → `subagent_type` via the board's Lane table. Each spawn prompt MUST carry:
  - the task ID + acceptance criteria;
  - its **writable file scope** (the lane's owned paths) and an explicit **off-limits** note:
    "write ONLY within your scope; do not edit other lanes' files or `registry.ts` unless you
    are Lane 1";
  - the **already-DONE dependency outputs** it may read (resolved deps live in committed files —
    that is how you receive sibling work; there is no live channel between agents);
  - "you do NOT edit `.claude/work/BOARD.md` — the orchestrator owns it";
  - "follow `.claude/rules/*`; finish with `npm run check` green; happy + failure tests for any
    new command."
- For long lanes, run agents with `run_in_background: true` so several proceed at once; you'll
  be notified on completion. If the repo is git-initialized, prefer `isolation: "worktree"`
  per agent for hard conflict isolation.

### 5. Converge
- When an agent returns, flip its task to `[REVIEW]`, then run `cad-reviewer` on the diff.
- On a clean review + green `npm run check`, flip to `[DONE]`. On findings, keep `[WIP]` and
  hand the findings back to the same lane agent (via `SendMessage` to reuse its context).
- Always re-run step 3 to top up any lane that just went free, keeping ~4 in flight.

### 6. Write the board back + report
- Persist every status change and refresh the **NOW** block before yielding.
- Tell the user, in 3–5 lines: what just completed, what is `[WIP]` now, and what unblocked.

## First-run behavior (nothing started yet)
Fan out immediately on the dep-free work — typically in one parallel batch:
`W0-1` (store, Lane 2) + `A1`/`A5` (Lane 1) + `G1` (Lane 4) + `B1` (Lane 1 second pass or
queue). Lanes 2-bis (C*) and Lane 3 (D*) start the moment `W0-1` is `[DONE]`.

## Coordination model (how parallel agents stay out of each other's way)
Agents are isolated — they cannot see each other's in-progress work, and they never need to.
Coordination is structural, enforced by you (the orchestrator), not by agent-to-agent messaging:
1. **Single writer of state** — only you read/write the board. Flip a task to `[WIP]` BEFORE
   launching it; the board is the live "who's on what" ledger. Agents never write it.
2. **Disjoint file ownership** — lanes own non-overlapping paths, so two agents physically
   cannot write the same file. The lone shared file `registry.ts` is Lane-1-only, and a lane
   runs ≤1 task at a time → never double-written.
3. **A `[WIP]` lane is NOT free** — selection (step 3) skips it, so re-invoking the skill mid-run
   never double-assigns or collides with in-flight work.
4. **Deps resolve by ordering, not chat** — a task waits until its deps are `[DONE]` and merged,
   then reads their output from committed files. The repo is the only channel between lanes.
5. **Convergence is the backstop** — `[REVIEW]` → `cad-reviewer` + `npm run check` (+ merge, if
   worktrees) catches anything that strayed across a boundary.

## Guardrails
- Obey the PRIME DIRECTIVE and dependency law — agents must too. A `cad-reviewer` pass gates
  every `[DONE]`.
- Don't invent tasks not on the board; if the user asks for something new, add it to the
  correct lane in the board first, then schedule it.
- Keep parallelism at the file-conflict-safe maximum (lanes), not per-subtask.
