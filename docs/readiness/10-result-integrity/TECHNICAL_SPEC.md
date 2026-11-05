# 10 INT — Result integrity — Technical specification

Companion of [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Every change goes through registered commands and `execute` (PRIME
DIRECTIVE, L1/L5); no new command is needed except where named. Lanes per `workflow.md` W5.

## 1. Command engine — parsed params reach `run` (FR-INT-01) · Lane 1

**TR-INT-01** `packages/core/src/commands/guard.ts` `checkedRun`: after a successful `safeParse`, call
`def.run(doc, checked.data, ctx)` instead of `safeParams`. Keep everything before it: the prototype-key check, the
unknown-key rejection (on the raw input), and `padPlanarPosition` (it runs before parsing, so the parsed output still carries
the padded position). Commands without `paramsValidator` keep `safeParams`.

**TR-INT-02** Parity sweep, in the same change:
- re-run the golden corpus (`tests/golden`) and the tool-schema snapshot. Any diff must be explained by a default or trim that
  now applies; snapshot changes need a note in the commit;
- grep `packages/**/commands/**` for hand-written trims and defaults that duplicate a schema (`?.trim()`, `?? <literal>` on a
  param the schema defaults) and remove them (C6 minimal diffs: only the duplicates);
- `looseObject` keeps undeclared metadata keys (`annotations.metadataKeys`) in the parsed output, so the metadata behaviour does not change.

**TR-INT-03** Contract test `tests/unit/contract/parsedParams.test.ts`:
- a test-only command with `z.object({ a: z.string().trim(), b: z.number().default(7) })` (registered in an isolated suite per
  `tests/isolatedSuites.ts`) receives `{ a: 'x', b: 7 }` for `{ a: '  x ' }`;
- for every registered command, a minimal valid input built from its JSON Schema (the existing schema-conformance generator)
  is parsed, and the test asserts that `run` sees exactly the parsed value (spy through a wrapping registry).

## 2. Engineering inputs never silently replaced (FR-INT-02..05, 14) · Lane 1

**TR-INT-04 Steel grade.** Replace `yieldStrength(grade)` in
`packages/domain-aec/src/industrial/steelDesign/steelDesign.ts` with
`steelStrength(grade: string, thicknessMm: number): { fy: number; fu: number; rule: string } | SteelRefusal`:
- grammar: `S` + 3 digits + optional quality suffix (`JR`, `J0`, `J2`, `K2`, `N`, `NL`, `M`, `ML`, `Q`, `QL`, `+AR` …), whitespace
  and case tolerated; known grades: S235, S275, S355, S420, S450, S460. Anything else → `STL_GRADE_UNKNOWN` (message lists the
  accepted grades);
- thickness bands from EN 1993-1-1 Table 3.1 (data in `steelDesign/steelGrades.ts`, each row with its clause and source grade):
  t ≤ 40 and 40 < t ≤ 80; t > 80 → `STL_THICKNESS_OUT_OF_RANGE`; rule string e.g. `"EN 1993-1-1 Tab. 3.1, t ≤ 40 mm"`;
- callers (`bracingAnalysis.ts:66,210`, `frameCheckFrames.ts:52`, `purlinAnalysis.ts:132`, `foundationPlateRows.ts:84` and any
  other grep hit) pass the governing thickness: max(tf, tw) for rolled I/H sections from the profile catalogue, plate
  thickness for plates; a refusal becomes a failed row with the code, never a pass.
- When pack 07 ships a design basis (FR-VNV-103), `steelStrength` reads fy from the basis; this TR only fixes the silent fallback.

**TR-INT-05 Bolts.** `boltResistance(diameterMm, propertyClass = '8.8')`:
- class table: 4.6 (fub 400, αv 0.6), 5.6 (500, 0.6), 6.8 (600, 0.5), 8.8 (800, 0.6), 10.9 (1000, 0.5); k2 = 0.9 (countersunk
  0.63 out of scope → refuse `STL_BOLT_COUNTERSUNK_UNSUPPORTED` if requested); unknown class → `STL_BOLT_CLASS_UNKNOWN`
  (code already reserved by pack 07);
- stress areas (ISO 898-1, coarse thread): M12 84.3, M14 115, M16 157, M18 192, M20 245, M22 303, M24 353, M27 459, M30 561,
  M36 817 mm²; an exact match is required (|d − size| < 1e-6), otherwise `STL_BOLT_SIZE_NONSTANDARD` naming the two
  neighbours; the nearest-size reduce goes;
- the class becomes a param of every command that sizes or checks bolts (`frameCheckSolve.ts:210` and the connection
  commands); omitted → 8.8 + `data.defaulted: [{ input: 'boltClass', value: '8.8' }]` + summary clause.

**TR-INT-06 Design tables.** A small helper in `packages/domain-aec/src/shared/designTable.ts`:
`lookupConservative(table, key, { direction, code })` → `{ row, exact: boolean } | { code, domain: [min, max] }`.
`direction: 'up' | 'down'` states which neighbour is conservative for that table. Apply to the road `SPEED_TABLE`
(`roadChecks.ts`: direction up, out of domain → `CIV_SPEED_OUT_OF_TABLE`); the summary names the row ("design speed 65 km/h
checked with the 70 km/h row"). Every table found by the inventory (TR-INT-14) migrates to the helper.

**TR-INT-14 Fallback inventory.** `validation/data/fallback_inventory.json`, one entry per fallback:
`{ id, file, symbol, kind: 'default'|'clamp'|'nearest'|'catch-all', input, policy: 'refuse'|'default-and-report'|'conservative-neighbour', code?, test }`.
- Seed it with the four of this audit (G2–G5) plus the pipe-span service regex (`pipeSpans.ts:16`, policy: refuse an
  unknown service class, enum) and the drainage hard-coded n / vmin / vmax (`drainageCriteria.ts:21`, policy:
  default-and-report).
- Contract test `tests/unit/contract/fallbackInventory.test.ts`: every entry's `test` path exists and names its id.
- Source scan: in `packages/domain-*/src/**/{check,design,analysis}*` and `**/*Check*.ts`, the patterns `?? <number>`,
  `|| <number>`, `: <number>; // default`, `.find(...) ?? TABLE[TABLE.length - 1]` and a `nearest` reduce over a table are
  reported. An unlisted hit fails, and an allowlist line needs a reason. The scan is a heuristic net, not a proof; review owns the rest.

## 3. FE mesh adequacy gates results (FR-INT-06) · Lane 1

**TR-INT-07 Measure.** Replace the bounding-box heuristic in `packages/domain-cae/src/results/adequacy.ts`:
- for each part, compute local thickness at sampled boundary faces (every face up to 2,000 boundary faces, else 3 faces per position x area-class bucket, deterministic by a hash of the face nodes): cast a ray along
  the inward face normal through the tet mesh and record the hit distance t and the tets crossed, and the local element size h = (6 x mean volume of the crossed tets)^(1/3) (a Kuhn cell of side s holds 6 tets of volume s^3 / 6, so h = s exactly and a structured hex-equivalent layer is 1; an unstructured mesh has about 6 to 6.5 tets per node, a bias of a few percent; the earlier mean-edge / 1.26 rule was calibrated on Kuhn meshes only and reads 12 % more layers than this rule on regular tets (edge a: 0.79 a against 0.89 a)); the element layers are n = t / h (not the count of tets crossed: one layer is about 3 tets);
- `elementsThrough = p5(n)` over the samples (area-weighted 5th percentile, so thin walls govern; the thinnest dimension of a slender section governs by design), separately per element order;
- thresholds: linear tets (C3D4) need ≥ 4 layers in bending regions, quadratic (C3D10) ≥ 2. These budgets come from the
  convergence studies of VC-INT-12 (target grade until VNV-M3 replaces them with measured convergence);
- verdict `adequate` | `marginal` | `inadequate`: `inadequate` when p5 is below the budget OR the thinnest sampled spot is below 0.5 x the budget (hard floor, so a thin rib on a fine mesh is not averaged away); `marginal` (a warning, `FEA_MESH_MARGINAL`, never gated) when the thinnest spot is between 0.5 x and 0.75 x the budget; stored on the FE result artefact (`results.adequacy`) as a display record only: every gate re-measures the mesh artifact (memoized by mesh object and verified mesh hash), a forged or stale record gates nothing, and results without a mesh artifact are `unmeasured`, which gates like `inadequate`.

**TR-INT-08 Gate.**
- `compute_margins`: rows sourced from an `inadequate` result get `state: 'not_assessed'`, code `FEA_MESH_INADEQUATE`, and the
  overall verdict is never `pass`;
- `check_analysis` raises it as an error (not a warning); `compute_fatigue` / `check_fatigue` (FE hot spots), `thermal_distortion_report` (flatness verdict), `dispose_margin` and `margin_disposition_payload` follow the same gate; `compute_margins` and `compute_fatigue` add `FEA_MESH_MARGINAL` to their warnings and summary for a marginal mesh;
- `fea_solve` reports the verdict in its summary;
- `acceptInadequateMesh: true` (boolean param on `compute_margins`, `compute_fatigue`, `check_fatigue`, `check_analysis` margin items, `thermal_distortion_report`) restores numeric states and records
  `data.overrides: ['acceptInadequateMesh']`.

## 4. Result provenance: which kernel answered (FR-INT-07) · Lanes 1 + 4 + 2

**TR-INT-09**
- `CommandResult` gains an optional `provenance?: { kernel: 'occt-native' | 'manifold' | 'none'; exactRequested: boolean; fallbackReason?: string }`,
  set by `execute` from `ctx.kernel` for commands with `requiresKernel` or tagged `kernel-optional` (the `@invariant` tag
  becomes the annotation `kernelOptional: true`, so `execute` can see it). It is not stored in the document;
- geometry the mesh kernel produced on a document that asked for the exact kernel carries `meta.approximate: true` on the
  entity, so a later save, measure or export can say so;
- server: `/health` and `kernel_info` return `{ active, requested, fallbackReason }`; `server/src/geometryKernel.ts` keeps the
  reason it already computes;
- CLI: for every result whose provenance is degraded, print one stderr line
  `warning: answered by the mesh kernel (<reason>); exact kernel unavailable` (also in `--json` as `provenance`);
  `planKernelWarning.ts` warns for every kernel-optional or kernel-required step of a plan;
- UI: the `StatusBar` kernel chip turns into "Mesh kernel (degraded)" with the reason in its tooltip while
  `requested ≠ active`; measure and mass panels show "approximate (mesh)" on degraded values;
- scope: every command that reads `ctx.kernel` (directly or through a kernel helper) is `requiresKernel` or `kernelOptional`, or allowlisted with a
  reason in `tests/unit/contract/kernelConsumers.test.ts` (a static scan of `packages/*/src`); a command that composes others through a nested `execute`
  carries the worst (degraded) provenance of its nested calls (`ExecutionContext.provenanceScope`, run state, not document state);
- **open item (known gap)**: the provenance is read from `GeometryKernel.info()` when `execute` runs. A native sidecar that dies permanently AFTER install
  keeps reporting `occt-native` (its `info()` is the install-time description) until the host reinstalls a kernel; no degraded result is stamped for it.
  A kernel without `info()` reads as the in-process Manifold, exact not requested (never degraded): a host that falls back must describe itself.

## 5. Locked layers enforced for every caller (FR-INT-08) · Lane 1

**TR-INT-10** A core guard in `execute` (next to `derivationViolation` in `guard.ts`):
- after `run`, compute the entity ids whose value differs between `doc.entities` and `result.document.entities` (added, removed,
  changed: reference-inequality first, then the ids in `affected`);
- for each id, read its layer from the input document (the output for new entities). If that layer is locked in the input
  document, return `rejection(doc, …, commandError('LAYER_LOCKED', 'Unlock layer <name> with update_layer first.'), ids)`;
- exempt: commands whose annotation is `layerManagement: true` (`update_layer`, `delete_layer`, `set_entity_layer` keeps its
  own rule), `ctx.replaying`, and plugin re-derivation (derived entity ids from `derivedEntityIds`);
- cost: O(changed entities) through reference inequality on the entity bag. Measure it on the 4,000-box save-loop document;
  budget ≤ 1 ms per command (VC-INT-15).
- The UI checks stay as early feedback; `importDxf`'s own lock handling stays.

## 6. Command channel and untrusted input (FR-INT-09, 10) · Lane 4 (+1 for `@lib`)

**TR-INT-11** `server/src/security.ts`:
- no token and no `--insecure-no-token` → mutating routes (`/command`, `/undo`, `/redo`, `/exchange`, `/import`, `/live`
  writes) answer 401 `SEC_TOKEN_REQUIRED`;
- `DEFAULT_ALLOWED_ORIGINS` becomes empty, and `LLULL_ALLOWED_ORIGINS` must be explicit; remove the `localhost:5173` default
  and its CSP `connect-src` entry (LC1: no browser host);
- move `/health` behind `hostAllowlist` (`server/src/index.ts:48-58`), and keep the HMAC challenge working;
- the CLI's own standalone host generates a token per launch the way the desktop does, so `llull --server` keeps working;
- tests go in `server/tests/security*.test.ts`.

**TR-INT-12** `packages/core/src/lib/zipRead.ts` / `inflate.ts`:
- defaults `maxBytes = 256 MiB`, `maxRatio = 200`;
- every call site names its budget (grep `readZip(` / `inflateRaw(`);
- a cap hit → `ZIP_LIMIT_EXCEEDED` / `INFLATE_LIMIT_EXCEEDED` with the limit and the declared size;
- `xmlRead` limits (built in PID-M1) get the hostile cases of VC-INT-17 if they are missing.

## 7. Required-tool test lanes (FR-INT-11) · Lane 5

**TR-INT-13**
- One helper `tests/requireTool.ts` (`requireTool('calculix' | 'python' | 'native:<binary>')`) replaces the ad-hoc
  `skipIf(!available)`. It returns the skip condition and records the reason in a per-worker file
  `.cache/test-skips/<worker>.json`;
- a vitest `globalTeardown` (root, server, desktop configs) prints `skipped by tool: calculix N, python N, native N`;
- when `LLULL_REQUIRE_TOOLS` lists a tool with N > 0 skips, it exits non-zero with `TST_REQUIRED_TOOL_SKIPPED`;
- the CI native job and the release gate set `LLULL_REQUIRE_TOOLS=calculix,python,native`;
- the chamfer-oracle CI pattern (`chamferCodegenOracle.test.ts:106`) is folded into the helper;
- migrate the ~45 files listed in the audit (TST-A1..A4).

## 8. Honest verification and swallowed failures (FR-INT-12, 13) · Lanes 1 + 4 + 2

**TR-INT-15**
- `verify_release` (`packages/plm/src/commands/verify.ts`) adds `geometryVerified: false`, `unchecked: [{ scope: 'geometry', reason: 'regeneration not implemented' }]`,
  and `state: 'partial'` when everything else verifies (`'fail'` when anything fails);
- the summary starts with `partial:` in that case;
- the same `unchecked[]` / `state` shape is adopted by `check_review`, `check_model` and `check_plant_data` where they already
  skip scopes (audit them in the change).

**TR-INT-16**
- `server/src/fea/feaSolve.ts:77`: replace `.catch(() => null)` with a catch that returns
  `native mapping failed (<message>); mapped in TypeScript` (a string, so the existing summary concatenation reports it);
- `src/ui/hooks/useLiveDocument.ts`: count consecutive failed resyncs and set `liveStatus: 'out_of_sync'` at 3; the `StatusBar`
  shows a banner with Reload;
- component test.

## 9. Codes

`STL_GRADE_UNKNOWN`, `STL_THICKNESS_OUT_OF_RANGE`, `STL_BOLT_CLASS_UNKNOWN` (pack 07), `STL_BOLT_SIZE_NONSTANDARD`,
`STL_BOLT_COUNTERSUNK_UNSUPPORTED`, `CIV_SPEED_OUT_OF_TABLE`, `FEA_MESH_INADEQUATE`, `LAYER_LOCKED`, `SEC_TOKEN_REQUIRED`,
`ZIP_LIMIT_EXCEEDED`, `INFLATE_LIMIT_EXCEEDED`, `TST_REQUIRED_TOOL_SKIPPED`. Each one is registered in the code tables of
its package and appears in `llull describe` output where a command can return it.

## 10. Milestones

| M | Content | Lane | Deps | Size |
| - | ------- | ---- | ---- | ---- |
| INT-M1 | TR-INT-01..03 (parsed params) | 1 | — | S |
| INT-M2 | TR-INT-04..06 + inventory seed (TR-INT-14 data + contract test) | 1 | — | M |
| INT-M3 | TR-INT-10 (locks in `execute`) | 1 | — | S |
| INT-M4 | TR-INT-09 (provenance: core + server + CLI + UI chip) | 1, 4, 2 | — | M |
| INT-M5 | TR-INT-11, 12 (channel + caps) | 4, 1 | — | S |
| INT-M6 | TR-INT-13 (required-tool lanes, migrate ~45 files) | 5 | — | M |
| INT-M7 | TR-INT-07, 08 (mesh adequacy) | 1 | VC-INT-12 study | M |
| INT-M8 | TR-INT-15, 16 + inventory source scan | 1, 4, 2 | INT-M2 | S |

Order: M1 → M3 → M2 → M5 → M4 → M6 → M8 → M7.
- M1, M3 and M5 are small, mechanical and close the S1 / S2 defects first;
- M7 needs a measured convergence study before it can set its thresholds.

## 11. Open questions

- **OQ-INT-1** EN 1993-1-1 Table 3.1 values must be read from the standard (pack 07 D7 purchase). Until then the
  thickness-band cases are grade B and non-gating; the refusal cases gate.
- **OQ-INT-2** Should `meta.approximate` survive a later exact re-evaluation? Proposed: it is cleared when the step is
  replayed with the exact kernel.
