# Aerospace gap specs — authoring template

Every gap folder `docs/aerospace/NN-<gap>/` holds exactly:

```
FUNCTIONAL_SPEC.md     what / why / for whom — product view (no code)
TECHNICAL_SPEC.md      how it lands in llull — architecture, data model, commands, algorithms, tests
validation/README.md   validation plan: real use cases, test cases with expected values + tolerance + source
validation/<files>     reference data (CSV / JSON / build_project plans / expected results / sources.md)
```

Rules (all files):

- **Specs only, no implementation.** No source under `packages/`, `src/`, `server/`, `desktop/` changes.
- **Verified sources only.** Every standard, number or claim that is not llull's own code cites a source
  actually fetched (standard body page, NASA/NTRS, NIST, FAA/EASA, ISO/ASME/SAE catalogue page, peer-reviewed
  paper, official vendor/OSS docs). List them in a `References` section as `[Rn] Title — publisher — URL (accessed 2026-10)`.
  Paywalled standards: cite the catalogue page and state only what is public (scope, title, edition); never
  invent clause content.
- **No fabricated numbers.** Expected values in validation files are either (a) quoted from a cited source,
  (b) derived analytically from a cited formula (show the derivation), or (c) marked `TBD — measure with <tool>`.
- Requirement ids: `FR-<GAP>-nn` (functional), `TR-<GAP>-nn` (technical), `VC-<GAP>-nn` (validation case).
  Priority `MUST / SHOULD / COULD`. Each FR maps to ≥ 1 VC; each VC lists the FR/TR it proves.
- **Agent-first** ([`AGENT_FIRST.md`](AGENT_FIRST.md)): the primary operator is an AI agent using the
  `llull` CLI, the owner is not assumed to be an engineer, a qualified reviewer appears only where
  certification / release / safety is touched. CLI workflow first, UI = review surface, stable error
  codes, numeric equivalents of visual analyses, named safety defaults, `unverified` propagation,
  `reviewRequired` flags, human gates. Map FR/TR to `AF-nn`.
- Respect llull's laws (`.claude/rules/architecture.md`): every capability is a pure `defineCommand`
  (snake_case) in core or a plugin, reachable from UI + MCP + CLI; kernel only via `ctx.kernel`
  (`requiresKernel`); desktop/offline is the primary product direction, OCC is the target kernel on desktop.

## FUNCTIONAL_SPEC.md sections

1. Summary (gap in one paragraph, why it blocks aerospace use)
2. Aerospace context & value (real programmes / workflows, who does it today with which tools)
3. Personas & user stories (operator = CLI agent, owner = non-engineer, qualified reviewer where needed)
4. Scope / out of scope (phases: MVP, V1, V2)
5. Functional requirements (table: id, priority, requirement, rationale, source)
6. Workflows: CLI `llull` first and complete; MCP; UI as review / approval surface
7. Acceptance criteria (Given / When / Then, linked to VC ids)
8. Standards & regulatory alignment
9. KPIs / success metrics
10. Risks & assumptions
11. References

## TECHNICAL_SPEC.md sections

1. Current state in llull (files, commands, limits — with paths)
2. Target architecture (layer placement, plugin vs core, kernel needs, laws respected)
3. Data model (TypeScript type sketches, document version / migration)
4. Commands (name, params sketch, `@affects @invariant @failure`, query vs mutating, toolset)
5. Kernel / algorithms (formulas, OCC classes / external libs, numerical tolerances)
6. Interop & persistence (file formats, schemas)
7. CLI / MCP / UI surfaces + stable error-code table (AF-11)
8. Performance & robustness budgets
9. Test strategy (unit, golden, quality gate, production-gate scenario) mapped to VC ids
10. Delivery plan (milestones, dependencies on other gaps, effort estimate)
11. Open questions / decisions needed
12. References
