# AERO3 — Aerospace package layout (cross-gap decision 1)

Status: decided 2026-10-17 (owner directive: "execute AERO-3"), applying the recommendation of
[`../aerospace/README.md`](../aerospace/README.md) § Cross-gap decisions, item 1.

## Decision

- One workspace **`packages/domain-aero`** (alias `@aero/*`) holds the aerospace domain plugins, one `CadPlugin` per discipline:
  - `sheetmetal` (toolset `manufacturing`): 07 FTR §4.2 sheet-metal commands. The 07 spec proposed a separate `packages/domain-mfg`;
    it is folded into `domain-aero` so there is one aerospace package to wire (alias, dep-cruiser, coverage, chunk).
  - `fasteners` (toolset `fasteners`): 08 MAT §4.2 catalogue, selection and stack insertion.
  - Later (AERO-5): `surfacing` (02 SRF) and `composites` (06 CMP) join as further plugins of the same package.
- Analysis stays in `packages/domain-cae` (decided earlier, `docs/physics/FE_PIPELINE_DESIGN.md`). PLM (09) gets its own `packages/plm`
  in AERO-4.
- Generic part features stay in **core** (07 §2.1): `add_hole`, `add_pocket`, `set_thread`, `recognize_features`, `check_machining`,
  `hole_table`, the `feature` recipe node, `lib/holeMath.ts`, `lib/sheetMath.ts`. Generic materials stay in core (08 §2.1): records,
  libraries, allowables, `check_materials`, `ctx.libraries`.
- Plugin data types live in the plugin package and extend `CadDocument` by module augmentation of `DocumentExtensions` (`building`, `civil`,
  `fasteners`, `aero`, ... ); `sheetMetal`, `composites` (shared with cae) and `analysis` stay in core `model/`, as does `model/materialLibrary.ts`;
  the plugins validate their slice through `DocumentExtension`.
- Toolset `manufacturing` mixes core and plugin commands (getter in `packages/mcp/src/toolsets.ts`, like `analysis`).

## Wiring

`tsconfig.base.json` (`@aero/*`), `server/tsconfig.json`, `vite.config.ts` (chunk `llull-aero`, coverage gate 90/85/90/90),
`.dependency-cruiser.cjs` (the generic `domain-[^/]+` rules already apply), `.claude/hooks/enforce-architecture.mjs`,
`src/app/plugins.ts` (`installDefaultPlugins`), CLAUDE.md layer map, `architecture.md` L2, `workflow.md` lane 1.
