# Agent-first operation — cross-cutting requirements for every aerospace gap

Status: authoritative for all `docs/aerospace/NN-*/` packs (2026-10-15). Where a pack's own text assumes
an engineer clicking in the UI, this document wins.

## 1. Who operates llull

| Role | Who | Uses | Responsibility |
| ---- | --- | ---- | -------------- |
| **Operator (primary)** | An AI agent (Claude Code or similar) | The `llull` CLI: `--doc FILE` headless, or `--app` on the open desktop window. MCP `/mcp` for cloud agents. | Turns an intent into plans, runs them, checks its own work, reports. |
| **Owner** | The person who asks the agent for a result | Natural language to the agent; may watch the desktop app | States the goal and accepts the result. **Is not assumed to be an engineer.** |
| **Qualified reviewer** (only where the work feeds certification, release or safety decisions) | A qualified engineer / design organisation signatory (Part 21 DOA, DER/CVE, company authority) | Desktop app review surfaces, release packages, reports | Approves, signs, owns the engineering judgement. |

Consequences:

- **Nobody in the loop is guaranteed to have engineering judgement until a qualified reviewer is involved.**
  llull must therefore carry the engineering knowledge itself (rules, checks, limits, provenance) and must
  make the boundary between "computed by llull" and "approved by a qualified person" impossible to miss.
- **The CLI is the product surface.** The UI is a viewing and approval surface. A capability that exists
  only in the UI does not exist.

## 2. Requirements (apply to every gap)

Ids `AF-nn`. Each pack maps its own FR/TR to these where relevant and adds a VC proving them.

### 2.1 Discover and call

| Id | Pri | Requirement |
| -- | --- | ----------- |
| AF-01 | MUST | Every capability is a registry command (L1/L5), so `llull search`, `llull describe`, `llull list <toolset>` find it and MCP exposes it with no extra work. No CLI special cases. |
| AF-02 | MUST | Command descriptions are written for an agent: what it does, when to use it, units of every numeric param, what it refuses and why, which command to call next. One paragraph, no marketing. |
| AF-03 | MUST | `llull guide` (and the MCP prompt for the toolset) gains an aerospace section per gap: units and axes (FS/BL/WL where relevant), id and alias conventions, the minimal correct plan for the gap's main job. |
| AF-04 | MUST | Every param that carries a physical quantity states its unit in the schema description, or takes `{ value, unit }`. No unit is ever inferred silently from context the agent cannot see. |
| AF-05 | MUST | Everything a gap does can be expressed in one `build_project` plan file (aliases `$name`, `=expr`, loops) and checked with `llull run plan.json --validate` before any kernel work. Validation errors name the step path and the param. |

### 2.2 Results an agent can use

| Id | Pri | Requirement |
| -- | --- | ----------- |
| AF-10 | MUST | Every query returns its result in `data` (`llull … --json`) with a stable, documented shape. Every number carries its unit (field name suffix such as `massKg`, or an explicit `unit` field). No result exists only as prose in `summary`. |
| AF-11 | MUST | Every refusal and every check failure has a **stable machine code** (e.g. `GDT_DATUM_UNDEFINED`, `FEA_MESH_INVERTED`, `MAT_ALLOWABLE_UNVERIFIED`), the offending ids or paths, and a one-line remediation ("call `set_datum` on a planar face first"). Exit code 1 as today. |
| AF-12 | MUST | Output is compact by default and bounded (the existing CLI/MCP cap). Large results are paged or narrowed by ids; heavy artefacts (meshes, decks, sheets, STEP) are written with `--save`, never dumped to stdout. |
| AF-13 | MUST | Results are deterministic: the same plan on the same kernel gives the same ids, values and order, so an agent can diff runs and a golden test can pin them. |

### 2.3 Self-verification (the agent must be able to prove its own work)

| Id | Pri | Requirement |
| -- | --- | ----------- |
| AF-20 | MUST | Each gap ships at least one **read-only check command** that returns a pass / warn / fail list with codes (examples: `check_model`, `check_pmi`, `check_layup`, mesh quality report, `check_machining`, `verify_release`). An agent ends every job by running it. |
| AF-21 | MUST | Every analysis that engineers do visually has a **numeric equivalent** returned in `data`: continuity G0–G3 values instead of zebra stripes, curvature samples instead of combs, shear angles instead of a drape colour map, margins instead of a stress plot. Overlays in the UI are optional extras built on the same data. |
| AF-22 | SHOULD | Visual confirmation for multimodal agents: `render_view … --save view.png` (and sheet SVG → PNG) shows the gap's objects (PMI, plies, mesh, results) so the agent can look at what it built. |
| AF-23 | MUST | A gap's validation cases run as CLI scripts: a plan, a `--json` call, and a comparison with the pack's `expected_results.json` (value, tolerance, unit). The production gate's **agent driver** runs them (`docs/PRODUCTION_GATE.md`). |

### 2.4 Guardrails because the operator is not an engineer

| Id | Pri | Requirement |
| -- | --- | ----------- |
| AF-30 | MUST | Engineering rules live in llull as data tables with their source (standard, handbook, company rule) and are applied automatically by the check commands. The agent never has to "know" a rule to have it enforced. |
| AF-31 | MUST | No safety-relevant value is defaulted silently. Factors of safety, allowables, design-rule thresholds, material properties: either given explicitly, or taken from a sourced default **that the result names** (`"factorOfSafety": {"value": 1.5, "source": "14 CFR 25.303", "defaulted": true}`). |
| AF-32 | MUST | Unverified or typical data (anything not traceable to a cited, verified source with a statistical basis where one applies) is flagged `unverified` and the flag **propagates** into every result computed from it. Check commands report it as a warning that cannot be hidden. |
| AF-33 | MUST | Any result that could support a certification, release, airworthiness or safety decision carries `reviewRequired: true` with the reason, and the summary says so in plain words ("computed by llull, not approved — needs a qualified engineer"). |
| AF-34 | MUST | Approval acts (release, signature, disposition of a non-conformance, acceptance of a negative or marginal result) are **human gates**: an agent can prepare everything but cannot complete the act (09 PLM `humanSignatureRequired`, signatures with a human-held key). |
| AF-34a | MUST | **How the gate is enforced.** A caller kind (`ctx.caller`, 09 TR-PLM-16) is self-declared in a local CLI run, so on its own it is advisory: an agent with a shell could claim to be human. The binding enforcement is a signature made with a key held only by the human (09 `record_signature`, Ed25519, key outside the agent's reach — OS keychain / hardware token on the desktop), or an authenticated server session for a named human. Every gated act therefore requires either that signature or that session; the caller kind only selects the error message (`*_HUMAN_GATE`). |
| AF-35 | MUST | Every computed engineering value can be explained: `data` includes the method, formula or standard id and the inputs used (`provenance`), so the agent can explain the result to a non-engineer owner and a reviewer can audit it. |
| AF-36 | SHOULD | Plain-language result summaries for the owner: one sentence on what was done, what passed, what needs a human, in that order. |

### 2.5 Running in an agent loop

| Id | Pri | Requirement |
| -- | --- | ----------- |
| AF-40 | MUST | Long operations (meshing, solving, drape, large STEP import) report progress (`--progress`), respect `--timeout`, and are resumable or cheap to re-run (cache by content hash). |
| AF-41 | MUST | Offline first: nothing in a gap needs network access on the desktop (L6, KI6). External tools (CalculiX, Gmsh, CadQuery) are bundled or reported as missing with an install hint and a stable code. |
| AF-42 | SHOULD | `--dry-run` works for every mutating command of the gap, so an agent can try a change and read the result without writing the document. |

## 3. How the packs apply this

Each pack's FUNCTIONAL_SPEC and TECHNICAL_SPEC is revised so that:

1. **Personas**: the operator is the CLI agent (primary), the owner is a non-engineer, and the qualified
   reviewer appears only where certification/release/safety is touched.
2. **Workflows**: the CLI workflow comes first and is complete (plan file, `--validate`, run, check,
   render, export). The UI workflow is described as review/approval only.
3. **Requirements**: UI-only requirements are re-prioritised (MUST → SHOULD/COULD) unless a qualified
   reviewer needs them; each has a CLI/numeric equivalent (AF-21). Every check has stable codes (AF-11);
   every safety-relevant default is named (AF-31); unverified data propagates (AF-32); review flags
   (AF-33) and human gates (AF-34) are explicit.
4. **Acceptance criteria and VCs** are phrased as CLI invocations with JSON assertions (AF-23).
5. **Error-code table**: each TECHNICAL_SPEC lists its stable codes with meaning and remediation.

## 4. Validation of this document

- VC-AF-01: for each gap, `llull search <gap keyword>` returns the gap's main commands and
  `llull describe <command>` shows units for every numeric param (AF-01..04).
- VC-AF-02: each gap's validation cases run unattended from a script with `--json` and exit codes only,
  no UI (AF-10, AF-13, AF-23).
- VC-AF-03: for each gap, a deliberately wrong plan returns the documented stable codes and remediation
  (AF-11).
- VC-AF-04: a result built from an `unverified` input shows the flag in `data` and in `check_*` output
  (AF-32); a certification-relevant result shows `reviewRequired` (AF-33); an agent caller cannot
  complete a human-gated act (AF-34).
- VC-AF-05: the production-gate agent driver completes each gap's scenario with no human input except
  the human gates (AF-23, AF-34).
