# Architecture review — 2026-10-17

Whole-repository review against the laws in `.claude/rules/architecture.md` and the conventions in
`.claude/rules/conventions.md`, plus a duplication sweep. Branch `ccr-f1514e3a-op3w9j`.

## Shape of the code

| Layer | Files | Lines |
| ----- | ----: | ----: |
| `packages/core/src` | 502 | 59.8k |
| `packages/domain-aec/src` | 238 | 30.3k |
| `packages/domain-cae/src` | 95 | 9.6k |
| `packages/domain-aero/src` | 70 | 7.8k |
| `packages/mcp/src` | 18 | 2.5k |
| `packages/kernel-{manifold,occt}/src`, `physics-mujoco/src` | 27 | 3.8k |
| `src/ui` + `src/app` | 345 | 27.9k |
| `server/src`, `desktop/src` | 74 | 6.6k |

Duplication (jscpd, ≥ 6 lines / 50 tokens, tests and JSON excluded): **35 clones / 320 lines before, 11 clones /
79 lines after**. Most of the remaining 11 are matching import lists, not shared logic.

## Laws

| Law | Verdict | Evidence |
| --- | ------- | -------- |
| L1 one command layer | Holds, one gap closed | UI mutations all go through `dispatch`. `runQuery` (`src/ui/services/localQuery.ts`) ran any command and dropped the result, so a mutating command would have bypassed dispatch, undo and live sync; it now refuses non-`readOnly` commands. The other direct `execute` calls in `src/ui` are read-only queries (`measure_bounding_box`, `inspect_dynamics`). |
| L2 dependency direction | Holds | `npm run arch`: no violations (1407 modules). Shared code was moved *down* (into `@lib`, `@core/geometry`, `@core/commands/noop`), never by loosening a rule. |
| L3 purity / L4 single source of truth | Holds | No component builds an `Entity`; `is pure` tests green. |
| L5 registry is the contract | Holds | Tool-schema snapshot unchanged by every refactor, including the shared provenance schema. |
| L6 thin backend | Holds | `server/` imports persistence, library-format and V&V helpers from core and forwards commands; no business logic found. |
| L7 one 2D/3D model | Holds | — |
| L8 parametric ids | Holds | The one `uniqueId` in a command path (`domain-aec/building/model.ts`, building `uid`) is deliberate and replay-safe: `history/replay.ts` carries the uid over so IFC GUIDs stay stable. |
| L9 injected kernel | Holds | Only `kernel-occt/occtTypes.ts` holds an `any` (the WASM binding), with a lint-disable explaining it. |
| L10 domains are plugins | Holds, improved | Plugins previously re-implemented core helpers they could not import. The drawing painter now lives in `@core/geometry/drawingSvg` and the coded rejection in `@core/commands/noop` (both public API), so the AEC/CAE copies are gone. |

## What changed

| Area | Change |
| ---- | ------ |
| Drawing sheets | One SVG painter, `@core/geometry/drawingSvg` (AEC `shared/drawingSvg` removed; `sheetFrame` keeps only the AEC envelope; paper sizes from `@core/model/sheet`). Output byte-identical. |
| Refusals | `codedRejection` + `tableRejection` in `@core/commands/noop` replace 15 hand-built `"<command>: <code> — <message>; no-op."` results; CAE `shared/refuse` removed. |
| DXF | `assembleDxf` in `@lib/dxfWriter` shared by AEC, civil and flat-pattern exports. The header extents now include TEXT boxes (fix: `$EXTMIN/$EXTMAX` used to miss the notes). |
| Sheet metal | `partLookup.ts` (`partContext`, `flatNear`, `insideRadiusOf`) + `result.refuser` + `graph.legFlat` replace per-command preambles in ten commands. Codes, paths and validation order unchanged; remediation wording unified. |
| Materials | `editableMaterial`, `queriedMaterial`, `resolveOrthotropicConstants`, `endpointsAt` (CTE), `provenanceSchema`. |
| Features | `solidRecognition` (recognize_features / holes_from_recognition), `countersinkOver` (hole spec). |
| CAE | `caseTables` / `casePropertyTable` (thermal), `allBcLines` (both decks), mapping uses core `closestPointOnTriangle`. |
| Vectors | `@lib/vec3` replaces local `sub/dot/cross/scale` copies in ten modules, and `scale3` replaces ten `map(...) as unknown as Vec3` casts. |
| UI | `PaperFields` shared by the two sheet forms. |

## Open items

- **Locked layers are UI-only.** Core edit commands ignore `layer.locked`, so MCP/CLI agents can edit locked
  geometry. Enforcing it in `execute` is a policy decision (it changes the agent contract) — not done here.
- **`unit()` normalize variants** in `dynamics/forceLaws`, `engineGeometry`, `geometry/viewDirections`,
  `motion/jointsKinematics`, `dynamics/mobility` differ in their zero-vector fallback (`[0,0,0]`, `[0,0,1]`, the input,
  or none). Unifying them changes results for degenerate input, so it needs a decision per call site.
- **`as unknown as`** remains in ~45 places, mostly around zod-parsed or stored data (`materialModelStored`,
  `commands/schema`). Each is a narrowing a type guard could replace; low risk, low priority.
- **`check_prototype`** is referenced by the Review tab but not registered yet (board task FPR-D); the tab stays
  hidden until it is.
