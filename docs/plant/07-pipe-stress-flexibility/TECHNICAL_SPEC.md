# Gap 07 PST — Pipe stress and flexibility analysis: technical specification

Status: written 2026-10-18, specification only. Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (before this gap)

| Area | What exists | Path | Limit for stress analysis |
| ---- | ----------- | ---- | ------------------------- |
| Pipe element | `PipeElement { points: Vec3[], diameter, service, material: string, line?, dn?, from?, to? }` in the building model; `add_pipe_run` routes a 3D polyline, bends implied at every interior point | `packages/core/src/model/building.ts` (l. 251), `packages/domain-aec/src/industrial/equipment/equipment.ts` (l. 97) | no wall thickness, schedule, bend radius, temperature, pressure, insulation; material is free text; no connectivity graph between runs (02 RTE) |
| Pipe sizes | `PIPE_SIZES` [DN, OD, standard wall, MSS SP-69 water span] DN15–DN600 | `industrial/piping/pipeSizes.ts` | STD wall only (DN300 9.53 mm, not Sch 40 10.31 mm); sizing belongs to 01 PSC |
| Supports | `PipeSupportElement` shoe / guide / anchor / hanger, attached to steel, riser clamps | `industrial/piping/pipeSupports.ts`, `pipeSupportAttach.ts`, `pipeSupportRiser.ts` | geometric only: no restraint directions, gaps, friction, springs |
| Span check | `check_pipe_supports` (spacing vs MSS SP-69 / B31.1 Table 121.5, riser guides) | `industrial/piping/pipeSupportCheck.ts`, `pipeSpans.ts` | a rule of thumb for weight only; no thermal, no stress |
| Weight | `pipeWeightPerMetre(OD, contentDensity)` kN/m (steel 7850 kg/m³ + contents) | `industrial/piping/pipeWeight.ts` | no insulation, no components |
| Hydraulics | `pipe_hydraulics` Darcy–Weisbach / Colebrook | `industrial/piping/pipeHydraulics.ts` | unrelated, but shows the read-only query pattern to follow |
| Pipe loads on steel | `check_steel_members` loads beams with water-filled pipe weight per tributary length or per attached support | `industrial/steelDesign/steelSupportLoads.ts`, `docs/INDUSTRIAL.md` §"Pipes and trays" | vertical tributary weight only; no thermal friction, anchor or guide loads |
| Frame solver | linear 2D frame, 3 DOF/node, direct stiffness, hinges | `packages/core/src/lib/frame2d.ts` | 2D only; no 3D, no torsion, no curved elements, no non-linear supports |
| CAE plugin | CalculiX decks with C3D4 / C3D10 solids only; `set_part_idealization` refuses shells and plane stress; thermo-mechanical CTE handling (secant / instantaneous conversion) | `packages/domain-cae/src/decks/deckBuilder.ts` (l. 81), `commands/parts.ts`, `thermomech/` | no beam / pipe elements (B31, PIPE31, ELBOW31); continuum FEA of a fitting only |
| Fatigue | rainflow counting, S-N curves, Miner damage | `packages/domain-cae/src/fatigue/` | could count thermal cycles for N (V1 reuse) |
| Materials | `doc.materials` with PHY-01 property models (E, cte, thermalStrain, Ftu, Fty …), licence flag `licensed-no-redistribution`, CTE conversions | `packages/core/src/model/propertyCatalog.ts`, `materialCte.ts`, `cteConversion.ts`, `materialLibrary.ts` | no piping allowable (S_h), no code-edition qualifier |
| Human gate | `humanGate(port, act, ids, confirmation)` signature check | `packages/core/src/model/humanGate.ts` | reused for `approve_pipe_stress` |
| Error codes | `CommandResult.error { code, ids, paths, remediation }`; plan `data.aliases` | `packages/core/src/commands/types.ts`, AGENT_FIRST §2.6 | PST adds its codes |
| Exchange | IFC4 `IfcPipeSegment`, DXF, sheets | `docs/INDUSTRIAL.md` §Exports | no PCF (05 ISO), no CAESAR II `.cii` |

Nothing in the repository mentions B31.3, SIFs, PCF or CAESAR II (grep of `packages/`, `src/`, `server/`, `docs/`
on 2026-10-18). The gap is therefore the whole stress layer: model, solver, code rules, nozzle and spring checks,
interop and review.

## 2. Target architecture

```
packages/core/src/lib/frame3d/                     pure 3D frame/pipe-beam numerics (stiffness, assembly, banded Cholesky, RCM)   [new, core lib]
packages/core/src/model/propertyCatalog.ts  + rows 'pipingAllowableStress' (Pa, strength, owner 07 PST) and 'meanCteFromInstall' (1/K)
packages/domain-aec/src/plant/stress/       plugin `pipeStress` (toolset `pipestress`; built name, M1) — the PST commands
  model/        stressModel.ts (types), buildModel.ts (pipes+supports → nodes/elements/restraints), components.ts
  solve/        loads.ts, nonlinear.ts (supports active set + friction), cases.ts (OPE/SUS/EXP/OCC combinations)
  code/         ruleSets.ts (B31.3-2018/2020/2022, B31.1 as data), sif.ts, allowables.ts, codeStress.ts
  nozzles/      api610.ts, nemaSm23.ts, userTable.ts
  springs/      hangerDesign.ts, springTable.ts
  interop/      caesarNeutral.ts (writer), pcfStressAttributes.ts (hook for 05 ISO)
  commands/     one file per command (≤ 500 lines each), catalog.ts
  report/       stressReport.ts (sheet / CSV / HTML via existing sheet writers)
src/ui/viewport/3d/pipeStressOverlay.tsx    deformed shape + ratio colours (presentation only)
```

Laws respected:

- **L1 / L5**: every capability is a `defineCommand` in the `plant` plugin; UI, MCP and CLI call the same registry.
  Query commands (`analyze_pipe_stress`, `check_pipe_stress`, quick checks) are read-only and idempotent.
- **L2**: `frame3d.ts` is a pure numeric helper in `@lib` (sibling of `frame2d.ts`, reusable by 06 STA steel
  frames); the plugin imports core only through the public API (`model`, `lib`, `commands/{schema,types,noop,registry}`).
  No DOM, no `fetch`; files are written by the CLI `--save` path, as for sheets.
- **L3 / L4**: model, conditions, restraints and recorded results are document data, created only by commands that
  return a new document.
- **L8**: every mutating PST command is a feature step; ids step-scoped (`stress-<step>.<k>`). Analysis results are
  **not** stored by `analyze_pipe_stress` (a query); `record_pipe_stress_results` stores a compact summary with the
  input hash so a reviewer can approve a fixed revision.
- **L9**: no kernel needed (`requiresKernel` false) — the model is a 1D beam idealization of pipe centrelines. A
  continuum check of one fitting goes to the CAE plugin (CalculiX solid) as today.
- **L10**: domain capability ⇒ plugin. The `plant` plugin is shared with 01 PSC / 02 RTE / 03 EQP; if those land
  first under another name, PST lives in the same plugin as 02 RTE (it consumes its connectivity graph).

Data flow:

```
add_pipe_run / 02 RTE network ──┐
add_pipe_support ───────────────┼─► create_stress_model (snapshot of ids + mapping rules)
01 PSC spec (wall, rating) ─────┤         │
03 EQP nozzles (growth) ────────┘         ▼
set_pipe_operating_conditions, set_stress_load_cases, add_stress_restraint, import_pipe_material_data
                                          │
                     analyze_pipe_stress (query: build FE model from the CURRENT document, solve, code check)
                                          │
        check_pipe_stress ◄───────────────┼──────► check_nozzle_loads, select_spring_hangers (mutating, V1)
                                          │
              record_pipe_stress_results ─► pipe_stress_report, export_caesar_neutral ─► approve_pipe_stress (human)
```

Technical requirements (each maps to FRs and AF ids; VCs in `validation/README.md`):

| Id | Pri | Requirement | FR | AF | VC |
| -- | --- | ----------- | -- | -- | -- |
| TR-PST-01 | MUST | Model build from pipes + supports with named mapping rules (§5.1) | 01, 02 | AF-05, AF-31 | 07, 12 |
| TR-PST-02 | MUST | `@lib/frame3d`: 3D Timoshenko pipe beam, banded Cholesky, RCM, residual check (§5.2, §5.5) | 04 | AF-13 | 06, 07, 08, 10, 12 |
| TR-PST-03 | MUST | Bends as k-scaled curved elements with near / mid / far nodes (§5.3) | 04, 08 | AF-35 | 01, 12 |
| TR-PST-04 | MUST | Primitive loads W, WW, T, P, D, F, U (V1 WIN, seismic) (§5.4) | 04, 15 | AF-04 | 07, 08, 09, 10 |
| TR-PST-05 | MUST | Non-linear supports: one-way, gap, friction, iteration cap and status (§5.5) | 05 | AF-11 | 11 |
| TR-PST-06 | MUST | Rule sets as data (B31.3 by edition, B31.1) with source and grade per row; code stresses and ratios (§5.6) | 06, 07, 22 | AF-30, AF-35 | 03, 05, 09, 13 |
| TR-PST-07 | MUST | SIF / k table, B31J override, `PST_SIF_EDITION` (§5.7) | 08 | AF-32 | 01, 02, 19 |
| TR-PST-08 | SHOULD | Spring hanger design from a vendor table (§5.8) | 13 | AF-31 | 14 |
| TR-PST-09 | SHOULD | Nozzle checks API 610 / NEMA SM 23 / API 617 / user (§5.9) | 14 | AF-30, AF-32 | 15 |
| TR-PST-10 | MUST | Quick-check queries (§5.10) | 12 | AF-10 | 01, 03, 04, 05, 06 |
| TR-PST-11 | MUST | `check_pipe_stress` with the codes of §7; `reviewRequired`; `approve_pipe_stress` via `humanGate` | 10, 11 | AF-11, AF-20, AF-33, AF-34 | 18 |
| TR-PST-12 | MUST | Input hash, staleness, determinism (stable RCM tie-break) | 20 | AF-13, AF-40 | 07, 18 |
| TR-PST-13 | SHOULD | `.cii` writer, PCF stress attributes via 05 ISO, report writer, overlay | 16, 17, 18 | AF-12, AF-22 | 16, 18 |
| TR-PST-14 | SHOULD | Coupling: equipment growth in (03 EQP), support loads out (06 STA / `check_steel_members`) | 19 | AF-35 | 12 |
| TR-PST-15 | COULD | Modal + response spectrum (Lanczos on the same K, lumped mass) | 21 | AF-40 | 17 |

`create_stress_model` stores **references and rules**, not a geometry copy: the FE model is rebuilt from the current
pipes on every analysis, so routing edits are never out of sync (FR-PST-20). The input hash covers the referenced
pipes, supports, conditions, materials and rule set.

## 3. Data model

New optional document slice `doc.pipeStress` (plugin `document` hook, version 1; absent ⇒ empty; no migration of
existing documents). Sketch:

```ts
type PipingCode = 'B31.3' | 'B31.1';
type CodeEdition = '2016' | '2018' | '2020' | '2022' | '2024';       // rule-set key = `${code}-${edition}`

interface Sourced<T> { readonly value: T; readonly source: string; readonly defaulted: boolean; readonly unverified: boolean }

interface StressModel {
  readonly id: string;                         // stress-<step>.<k>
  readonly name: string;
  readonly scope: { readonly pipeIds: readonly string[] } | { readonly line: string } | { readonly networkFrom: string };
  readonly code: PipingCode;
  readonly edition: Sourced<CodeEdition>;      // defaulted ⇒ PST_EDITION_DEFAULTED warning
  readonly maxElementLengthMm: number;         // default 3000 (named)
  readonly elbowRadiusFactor: Sourced<number>; // R1 / nominal size when the route has sharp corners; default 1.5 (long radius)
  readonly supportMapping: SupportMappingRules; // shoe → rest(+V) with friction, guide → rest + lateral gap, ...
  readonly friction: Sourced<number>;          // μ, default 0.3 (steel on steel, named)
  readonly verticalAxis: 'z';                  // llull is Z-up
  readonly conditions: readonly OperatingConditions[];
  readonly loadCases: readonly LoadCaseDef[];  // generated default set unless edited
  readonly restraints: readonly ExtraRestraint[];   // additions / overrides on top of mapped supports
  readonly sifOverrides: readonly SifOverride[];    // B31J values typed in by a licensed user
  readonly nozzleChecks: readonly NozzleCheckDef[]; // V1
  readonly springs: readonly SpringSelection[];     // V1, written by select_spring_hangers
  readonly recorded?: RecordedResults;
  readonly approval?: { readonly signer: string; readonly inputHash: string; readonly at: string };
}

interface OperatingConditions {
  readonly target: { readonly pipeIds?: readonly string[]; readonly line?: string };  // empty ⇒ whole model
  readonly installTempC: Sourced<number>;                                           // default 21.1 °C (70 °F), named
  readonly temperatures: readonly { readonly name: `T${1|2|3|4|5|6|7|8|9}`; readonly tempC: number }[];
  readonly pressures: readonly { readonly name: `P${1|2|3|4|5|6|7|8|9}`; readonly gaugeBar: number }[];
  readonly hydroTestBar?: number;
  readonly fluidDensityKgM3: number;
  readonly insulation?: { readonly thicknessMm: number; readonly densityKgM3: number; readonly claddingKgM2?: number };
  readonly corrosionAllowanceMm: Sourced<number>;   // from 01 PSC spec when present
  readonly millTolerancePct: Sourced<number>;       // default 12.5 % (B36.10M seamless, named)
  readonly cycles: Sourced<number>;                 // default 7000 (named) ⇒ PST_CYCLES_DEFAULTED
  readonly materialId: string;                      // doc.materials id; PipeElement.material text mapped by import
  readonly wallMm?: number;                         // else from 01 PSC spec, else STD wall table (flagged)
}

type LoadCaseType = 'OPE' | 'SUS' | 'EXP' | 'OCC' | 'HYD';
interface LoadCaseDef {
  readonly name: string;                            // 'L1'
  readonly type: LoadCaseType;
  readonly basic?: readonly ('W' | 'WW' | `T${number}` | `P${number}` | `D${number}` | `F${number}` | 'WIN1' | 'U1')[]; // primitive loads
  readonly combine?: { readonly method: 'algebraic' | 'scalar' | 'srss' | 'abs'; readonly terms: readonly { readonly case: string; readonly factor: number }[] };
}

type RestraintKind = 'anchor' | 'rest' | 'guide' | 'line_stop' | 'limit_stop' | 'rod_hanger' | 'spring' | 'constant' | 'translational' | 'rotational';
interface ExtraRestraint {
  readonly id: string;
  readonly at: { readonly pipeId: string; readonly atMm: number } | { readonly supportId: string };
  readonly kind: RestraintKind;
  readonly direction?: readonly [number, number, number];   // unit vector (global), for translational / one-way
  readonly oneWay?: '+' | '-';
  readonly gapMm?: number;
  readonly stiffnessNPerMm?: number;                        // default rigid = 1e12 N/m (named)
  readonly friction?: number;
  readonly springRateNPerMm?: number; readonly presetLoadN?: number;
}

interface RecordedResults {
  readonly inputHash: string;                // sha256 of canonical inputs
  readonly solverVersion: string;
  readonly governing: readonly { readonly case: string; readonly nodeId: string; readonly ratio: number; readonly rule: string }[];
  readonly supportLoads: readonly { readonly supportId: string; readonly case: string; readonly forceN: Vec3; readonly momentNm: Vec3 }[];
  readonly status: 'pass' | 'fail' | 'incomplete';
  readonly reviewRequired: true;
}
```

Material data reuses `doc.materials` (PHY-01 property models). New catalogue rows (open / closed, no `switch`):
`pipingAllowableStress` (Pa, strength, owner `07 PST`, qualified by `{ code, edition }` in the model's basis) and
the existing `E`, `cte` / `thermalStrain`, `Fty` (SMYS), `Ftu` (SMTS), `density`. A material whose
`pipingAllowableStress` came from an unsigned import carries `unverified` (AF-32); a licensed table keeps
`licensed-no-redistribution` so MCP redaction (`packages/mcp/src/licensedReferences.ts`) applies unchanged.

Analysis-only types (never stored; returned in `data`):

```ts
interface FeNode { readonly id: string; readonly xyzMm: Vec3; readonly pipeId: string; readonly atMm: number; readonly tag?: 'bend-near' | 'bend-far' | 'bend-mid' | 'support' | 'branch' | 'end' }
interface FeElement { readonly id: string; readonly a: number; readonly b: number; readonly kind: 'straight' | 'bend' | 'rigid';
  readonly section: { readonly odMm: number; readonly wallMm: number; readonly corrodedWallMm: number };
  readonly bend?: { readonly radiusMm: number; readonly angleRad: number; readonly k: number; readonly ii: number; readonly io: number };
  readonly materialId: string }
interface CaseResult {
  readonly case: string;
  readonly displacements: readonly { readonly node: string; readonly uMm: Vec3; readonly rotDeg: Vec3 }[];
  readonly reactions: readonly { readonly restraintId: string; readonly forceN: Vec3; readonly momentNm: Vec3; readonly status: 'active' | 'lifted' | 'gap-open' | 'sliding' }[];
  readonly stresses?: readonly { readonly node: string; readonly element: string; readonly codeStressMPa: number; readonly allowableMPa: number; readonly ratio: number; readonly rule: string; readonly sif: { readonly ii: number; readonly io: number } }[];
}
```

## 4. Commands (toolset `pipestress`)

All numeric params state their unit in the zod `describe` (AF-04). Every query returns `data.provenance`
(method, rule ids, edition, inputs, `defaulted` list) and `data.reviewRequired` where a result could support a
release (AF-33, AF-35).

| Name | Kind | Params (sketch) | data / effect | Failure codes |
| ---- | ---- | --------------- | ------------- | ------------- |
| `create_stress_model` | mutating | `name`, `pipeIds[]` \| `line` \| `networkFrom` (02 RTE), `code`, `edition`, `maxElementLengthMm`, `elbowRadiusFactor`, `friction` | adds `StressModel`; affected [modelId] | `PST_NO_PIPES`, `PST_PIPE_NOT_FOUND`, `PST_PARAM_INVALID` |
| `update_stress_model` / `delete_stress_model` | mutating | `modelId`, partial fields | edits / removes; clears approval | `PST_MODEL_NOT_FOUND` |
| `set_pipe_operating_conditions` | mutating | `modelId`, `target`, `installTempC`, `temperatures[]` (°C), `pressures[]` (bar g), `fluidDensityKgM3`, `insulation`, `cycles`, `materialId`, `wallMm`, `corrosionAllowanceMm`, `millTolerancePct` | replaces the conditions of the target | `PST_MODEL_NOT_FOUND`, `PST_MATERIAL_NOT_FOUND`, `PST_PARAM_INVALID` |
| `import_pipe_material_data` | mutating | `materialId`, `designation`, `rows: [{ tempC, ShMPa, EGPa, meanCtePerK \| growthMmPerM }]`, `SMYSMPa`, `SMTSMPa`, `source`, `licence`, `confirmation?` | writes PHY-01 table models on `doc.materials[materialId]`; `unverified` unless a human signature clears it | `PST_TABLE_INVALID` (non-monotonic T, gaps), `PST_HUMAN_GATE` (only for the `verified` flag) |
| `set_stress_load_cases` | mutating | `modelId`, `cases[]` \| `preset: "b31.3-default"`, `forces?[{ name: "F1", at: { pipeId, atMm }, forceN: [x,y,z], momentNm?: [x,y,z] }]`, `displacements?[{ name: "D1", restraintId, uMm, rotDeg? }]`, `wind?`, `seismic?` (V1) | replaces load cases | `PST_LOADCASE_INVALID` (unknown primitive, cycle in combinations) |
| `add_stress_restraint` / `delete_stress_restraint` | mutating | `modelId`, `at`, `kind`, `direction`, `oneWay`, `gapMm`, `stiffnessNPerMm`, `friction` | adds / removes an extra restraint | `PST_POINT_OFF_PIPE`, `PST_PARAM_INVALID` |
| `set_sif_override` | mutating | `modelId`, `component` (pipe + atMm), `ii`, `io`, `it`, `ia`, `k`, `source` | B31J or test values, `unverified` until signed | `PST_PARAM_INVALID` |
| `analyze_pipe_stress` | query | `modelId`, `cases?[]`, `nodes?[]`, `include?: ('displacements'\|'reactions'\|'forces'\|'stresses')[]`, `cursor?` | `CaseResult[]`, governing summary, model stats (nodes, elements, DOF), iterations per case, `inputHash`, `provenance` | `PST_MODEL_NOT_FOUND`, `PST_UNSTABLE`, `PST_DISCONNECTED`, `PST_MATERIAL_NO_DATA`, `PST_TEMPERATURE_OUT_OF_TABLE`, `PST_NONLINEAR_NOT_CONVERGED`, `PST_WALL_UNKNOWN` |
| `check_pipe_stress` | query | `modelId`, `displacementLimitMm?` | `items[{ code, severity, ids, paths, message, remediation }]`, `ok`, `reviewRequired` | as above plus overstress codes (§7) |
| `record_pipe_stress_results` | mutating | `modelId` | writes `RecordedResults` (summary + support loads + hash) | `PST_ANALYSIS_FAILED` (the run's own code) |
| `approve_pipe_stress` | mutating, human gate | `modelId`, `confirmation` (signature) | writes `approval`; refused for agents | `PST_HUMAN_GATE`, `PST_RESULTS_STALE`, `PST_RESULTS_FAILING` (a failing model cannot be approved without a disposition, 09 PLM) |
| `thermal_growth` | query | exactly one of `table: "carbon-steel-c1"`, or `materialId` (+ `cteReferenceC` for a secant cte model), or `meanCtePerK`; `fromC`, `toC`, `lengthM` | `growthMm`, `mmPerM`, `meanCtePerK`, `strain`, `source`, `grade`, `warnings` (`PST_TABLE_EDGE_SNAPPED`, `PST_MATERIAL_UNVERIFIED`, `PST_CTE_IMPLAUSIBLE`) | `PST_TEMPERATURE_OUT_OF_TABLE`, `PST_MATERIAL_NOT_FOUND`, `PST_MATERIAL_NO_DATA`, `PST_PARAM_INVALID` |
| `pipe_sif` | query | `component`, `odMm`, `wallMm` (matching run pipe), `bendRadiusMm?` (>= mean radius), `padMm?`, `rule` (`B31.3-<2016..2024>`, `B31.1-<2016..2022>`, `user`; required), `userSif?` | `h`, `k`, `ii`, `io`, `formula`, `grade`, `ruleRows`, `warnings` (`PST_SIF_EDITION` for B31J editions, `PST_SIF_CLAMPED`), `reviewRequired` | `PST_PARAM_INVALID` (sweepolet / reducer without `user`) |
| `pipe_stress_allowables` | query | `rule` (edition required), `ScMPa`, `ShMPa` (both inputs, never defaulted), `cycles`, `SLMPa?`, `ferrousLowStrength?`, `occasionalEvents?` (B31.1), `sustainedMPa?` + `occasionalLoadMPa?` | `f`, `fRaw`, `fCap`, `SA1aMPa`, `SA1bMPa` (null when SL > Sh), `SAMPa`, `equation`, `occasionalMPa`, `occasionalRatio?`, `defaulted`, `warnings` (`PST_SUSTAINED_EXCEEDS_SH`) | `PST_PARAM_INVALID` (materialId + tempC input arrives with M3) |
| `guided_cantilever` | query | `legMm`, `displacementMm`, `odMm`, `wallMm`, `EMPa`, `sif?` (>= 1, default 1 listed in `defaulted`), `SAMPa?` | `forceN`, `momentNmm`, `stressMPa` (= sif x raw), `rawStressMPa`, `minLegMm?`, `ratio?`, `warnings` (`PST_BEAM_SLENDERNESS` when leg / OD < 10) | `PST_PARAM_INVALID` |
| `spring_variability` | query | `hotLoadN`, `rateNPerMm`, `travelUpMm` (signed), `maxVariability?` (default 0.25, named) | `coldLoadN`, `variability`, `ok`, rule + grade | `PST_PARAM_INVALID` |
| `nozzle_load_check` | query | `standard: nema_sm23\|api610\|api617\|user`, `nominalIn`, `forceN`/`forceLbf` [x,y,z], `momentNm`/`momentFtLbf` [x,y,z], `table?` (api610 / user values), `orientation?: top\|side\|end` | per-component and resultant ratios, `De`, governing ratio, rule + grade | `PST_NOZZLE_LIMIT_MISSING`, `PST_PARAM_INVALID` |
| `select_spring_hangers` (V1) | mutating | `modelId`, `restraintIds[]`, `springTableId`, `maxVariability` (default 0.25, 0.15 near rotating equipment) | writes `SpringSelection` (size, rate, hot / cold load, travel, variability) | `PST_SPRING_NO_SIZE`, `PST_SPRING_VARIABILITY`, `PST_SPRING_TABLE_MISSING` |
| `import_spring_table` (V1) | mutating | vendor sizes `[{ size, minN, maxN, rateNPerMm, travelMm, series }]`, `source` | document data | `PST_TABLE_INVALID` |
| `set_nozzle_load_limit` (V1) | mutating | `modelId`, `nozzle` (03 EQP id) \| `restraintId`, `standard: api610\|nema_sm23\|api617\|api661\|user`, `table?`, `nominalIn` | stores check definition | `PST_NOZZLE_NOT_FOUND`, `PST_PARAM_INVALID` |
| `check_nozzle_loads` (V1) | query | `modelId`, `cases?` | per nozzle, per case: local forces / moments, limits, ratios, rule, grade | `PST_NOZZLE_OVERLOAD`, `PST_NOZZLE_LIMIT_MISSING`, `PST_NOZZLE_LIMIT_UNVERIFIED` |
| `pipe_stress_report` (V1) | query, file | `modelId`, `format: html\|csv\|sheet` | written with `--save`; data = summary | `PST_RESULTS_STALE` (warning in the report) |
| `export_caesar_neutral` (V1) | query, file | `modelId`, `units: si\|english` | `.cii` text with `--save`; data = counts, skipped items | `PST_EXPORT_UNSUPPORTED` |
| `import_caesar_displacements` (V2) | mutating | `modelId`, `file` (CAESAR II `.OUT` displacement table / CSV) | stores comparison set | `PST_IMPORT_UNMATCHED_NODES` |
| `modal_pipe_analysis` (V2) | query | `modelId`, `modes`, `lumpedMass` | frequencies, mode shapes, participation | `PST_UNSTABLE` |

Tags on every command source (C2), for example:

```ts
/**
 * @affects none; data = { cases: CaseResult[], governing, model: { nodes, elements, dof }, inputHash, provenance, reviewRequired }
 * @invariant the FE model is rebuilt from the current pipes / supports on every call; the same document gives the same data (AF-13)
 * @failure unknown model -> PST_MODEL_NOT_FOUND; singular stiffness -> PST_UNSTABLE (ids = unrestrained nodes, paths = DOF names);
 *          non-linear supports not converged in maxIterations -> PST_NONLINEAR_NOT_CONVERGED (ids = toggling restraints)
 */
export const analyzePipeStress = defineCommand({ name: 'analyze_pipe_stress', annotations: { readOnly: true, idempotent: true }, ... });
```

## 5. Algorithms

### 5.1 Model build (TR-PST-01)

1. Resolve scope to `PipeElement`s (by ids, line, or 02 RTE network walk). Connected runs share a node when an end
   lies within 1 mm of another run's end or centreline (tee). Disconnected components are separate sub-models;
   one with no restraint ⇒ `PST_UNSTABLE`.
2. Each interior polyline vertex is a bend: deflection θ = acos(d1·d2); radius R1 = `elbowRadiusFactor` × nominal
   size (DN in mm × 1.5 for long radius) unless 02 RTE / 01 PSC gives the fitting. The bend replaces the corner by an
   arc tangent to both legs; near, mid and far nodes are created (CAESAR II convention), legs shortened by
   R1 tan(θ/2). A corner whose legs are shorter than R1 tan(θ/2) ⇒ `PST_BEND_TOO_TIGHT`. `elbowRadiusFactor: 0` keeps a
   sharp corner (k = 1, i = 1, a mitre-free idealisation used by the closed-form validation cases; flagged in provenance).
3. Straight legs are split at supports, branches, and so no element exceeds `maxElementLengthMm`.
4. Supports map by `supportMapping` (defaults below, each named in `provenance`): anchor → all 6 DOF; shoe → one-way
   +Z (rest) with friction μ in the plane; guide → rest + lateral restraint (gap `gapMm`, default 0) perpendicular to
   the pipe axis in the horizontal plane; hanger rod → one-way −Z in tension (rod cannot push); riser clamp
   (shoe / anchor on a riser) → +Z rest at the clamp; riser guide → two lateral directions. Extra restraints from
   `add_stress_restraint` are added; same node + same direction ⇒ the extra one wins (warning).
5. Section: OD from the pipe, wall from conditions / 01 PSC spec / STD table (flag `PST_WALL_DEFAULTED`). Stress
   section uses the nominal wall for SE (B31.3) and the corroded wall (wall − c, mill tolerance not deducted unless
   chosen) for sustained / occasional — both named in provenance.

### 5.2 Element stiffness (TR-PST-02)

12 × 12 local stiffness of a straight 3D Timoshenko beam (axial EA/L, torsion GJ/L, two bending planes with
φ = 12EI/(G A_s L²), shear area A_s = A/2 for a thin pipe), exactly as `validation/data/scripts/frame3d.py`
(which reproduced PSI to 4 digits, VC-PST-07). Section: A = π/4 (Do² − Di²), I = π/64 (Do⁴ − Di⁴), J = 2I,
Z = I/(Do/2). E at the installation temperature for thermal loads (B31.3 E_a practice, PSI uses E at T_ref),
E(T) optional for OPE displacements (named setting).

### 5.3 Bends (TR-PST-03)

Curved beam element of radius R1 and angle θ, in-plane and out-of-plane bending flexibility multiplied by k
(k = 1.65/h ≥ 1, h = T R1 / r2²). Implementation: discretise the arc into `nSub` = max(2, ceil(θ / 15°)) straight
Timoshenko sub-elements on the arc chord with EI divided by k (pressure stiffening of k per B31.3 App. D note
optional, V1). VC: the flexibility of a 90° bend from this element vs the closed-form curved-beam flexibility
(Castigliano, k-scaled), 1e-3 rel at nSub = 6 (unit test, derived in the test).

### 5.4 Loads (TR-PST-04)

- Weight W: q = g (ρ_steel A + ρ_fluid A_i + ρ_ins A_ins + cladding) per length, consistent nodal loads (fixed-end
  forces / moments); component weights (valves, flanges) as point loads (V1). `WW` = water-filled (hydrotest).
- Thermal T_n: free strain ε = ᾱ(T_n; T_install) (T_n − T_install) from the material table (mean coefficient
  from the install temperature: if the table is referenced to 21.1 °C (70 °F) and the install temperature differs,
  convert with `cteConversion.ts` secant rule). Equivalent nodal loads ± E A ε along each element axis; on a bend
  sub-element along the chord.
- Pressure P_n: hoop S_h = P Do / (2 t) (PSI convention; Barlow, conservative), longitudinal
  S_lp = P Di² / (Do² − Di²) (exact) or P Do / (4 t) (simplified, named option); optional pressure thrust
  (P A_i at closed ends / expansion joints) and Bourdon (V2).
- Imposed displacement D_n: prescribed DOF values at restraints (equipment nozzle growth from 03 EQP:
  ΔL = ᾱ ΔT × distance from the equipment's fixed point, computed by 03 and passed as D_n).
- Forces F_n, uniform U, wind WIN (V1: q_z × C_f × (Do + 2 t_ins) per element, projected normal to the wind),
  seismic static (V1: g fractions × weight).

### 5.5 Solve and non-linear supports (TR-PST-05)

Global assembly; node renumbering by reverse Cuthill–McKee; banded (skyline) Cholesky; rigid restraints by
large stiffness (1e12 N/m, 1e12 N·m/rad — named) so lift-off can switch them; prescribed displacements by
penalty. Singular pivot (≤ 1e-12 × max diagonal) ⇒ `PST_UNSTABLE` with the node and DOF.

Non-linear supports (per OPE / SUS / OCC primitive set, never superposed):

1. Start with every one-way support active, gaps closed if their initial gap is 0, friction stuck.
2. Solve. For each one-way support: reaction pulls the pipe (sign opposite to its allowed direction) ⇒ release
   (lifted). Released support whose displacement crosses its face ⇒ reactivate. Gap: active only when
   |u_lateral| ≥ gap; then the restraint acts at the gap face (prescribed offset).
3. Friction: at each active rest, tangential force F_t limited to μ N. Stick: lateral stiffness k_f (default
   1e9 N/m, named); slip when F_t > μ N: replace by a force μ N opposing the tangential displacement direction from
   the previous iteration (secant update, damping 0.5).
4. Repeat until no status change and |ΔF_friction| ≤ 1e-3 μN for two iterations; max 50 iterations
   (`PST_NONLINEAR_NOT_CONVERGED`, ids = restraints that toggled in the last 5 iterations).
5. EXP range = OPE − SUS (algebraic difference of displacements and element forces of the two converged states),
   B31.3 practice; supports status reported for OPE and SUS separately.

### 5.6 Code stresses (TR-PST-06)

Element end forces in the local frame give Mi (in-plane), Mo (out-of-plane) at bends / tees (planes defined by the
bend / branch geometry), Mt (torsion), Fa (axial). Rule sets are data (`code/ruleSets.ts`), each row with the source
and grade of `validation/data/code_rules_b313.json`:

- B31.3 sustained (2016+ form): S_L = √((|S_a| + S_b)² + (2 S_t)²), S_a = I_a F_a / A_p (+ longitudinal pressure),
  S_b = √((I_i M_i)² + (I_o M_o)²) / Z, S_t = I_t M_t / (2 Z); sustained indices I = max(1, 0.75 i) when no better
  data (grade B, named). Limit S_h. Earlier forms selectable by edition.
- B31.3 displacement stress range: S_E = √(S_b² + 4 S_t²) with i_i, i_o (eq. 17); limit S_A by eq. 1a
  f (1.25 S_c + 0.25 S_h), or eq. 1b f [1.25 (S_c + S_h) − S_L] per node when S_h > S_L ("liberal", option,
  default on — named).
- f: editions ≤ 2020: f = 6.0 N^-0.2; 2022+: f = 20 N^-0.333 (both grade A); cap fm = 1.2 when ferrous, SMTS ≤
  517 MPa and T ≤ 371 °C, else 1.0 (cap grade A, temperature condition grade B ⇒ when unknown use 1.0 and flag);
  floor 0.15 (grade A for ≥ 2004 editions per two sources, year B).
- Occasional: S_L(SUS) + S_L(OCC) ≤ 1.33 S_h (B31.3, grade B, named), B31.1 k S_h (k 1.15 / 1.2).
- B31.1: S_L = P Do/(4 t_n) + 0.75 i M_A / Z ≤ S_h (0.75 i ≥ 1); S_E = i M_C / Z ≤ S_A + f (S_h − S_L).
- SIFs (§5.7) at bends, tees, olets; butt welds i = 1.0 (B31.3); reducers per edition.
- Ratio = code stress / allowable; governing per case and per pipe. `creepWarning` when T_n ≥ the creep onset
  given by the material table (`PST_CREEP_RANGE`).

### 5.7 SIF and flexibility factors (TR-PST-07)

| Component | h | k | i | Grade |
| --------- | - | - | - | ----- |
| Bend / welding elbow (B31.3 ≤ 2018 App. D, B31.1) | T R1 / r2² | 1.65 / h | ii 0.9 / h^(2/3), io 0.75 / h^(2/3) (≥ 1) | A |
| Unreinforced fabricated tee | T / r2 | 1 | io 0.9 / h^(2/3), ii 0.75 io + 0.25 | B |
| Welding tee (B16.9) | 3.1 T / r2 (B31.3); B31.1 4.4 T / r2 with crotch conditions | 1 | as above | B |
| Reinforced fabricated tee | (T + t_r/2)^2.5 / (T^1.5 r2) | 1 | as above | B |
| Weldolet / branch | 3.3 T / r2 | 1 | as above | B |
| B31.3 ≥ 2020, B31.1 ≥ 2020 | B31J tables (user import) | | | C until imported |

Flanged-end corrections (c = (T/r2)^(1/6) one end, ^(1/3) both) as in PSI `b311.py` (grade B, V1). An edition
that requires B31J with no override present ⇒ the App. D value is used **and** `PST_SIF_EDITION` (warning, cannot
be hidden) so the agent never silently under-states a SIF.

### 5.8 Spring hangers (TR-PST-08, V1)

1. Restrained-weight case: hanger locations rigid in −Z, solve W (+ insulation) ⇒ hot load P_hot at each.
2. Operating thermal case with hangers replaced by their (zero) force ⇒ vertical travel d at each.
3. For each vendor size in the imported table with P_hot within its working range: P_cold = P_hot + k d (d up
   positive), variability V = |k d| / P_hot; choose the smallest size and the lowest-rate series with V ≤ max
   (0.25, 0.15 near rotating equipment, both named); none ⇒ constant-effort hanger with load P_hot and travel d,
   else `PST_SPRING_NO_SIZE`.
4. Re-run OPE / SUS with springs as linear springs with preload P_cold (installed state) and report the residual
   load error (≤ 1 % target).

### 5.9 Nozzle checks (TR-PST-09, V1)

Reactions at the restraint representing the nozzle, transformed to the nozzle frame (03 EQP nozzle axis): F, M
components and resultants.

- API 610 Annex F: each component ≤ 2 × Table 5 (F.1.2a) and the resultant equations of F.1.2 b/c (imported with the
  table — formula text is paywalled; until imported only the component check runs and the result is marked
  `PST_NOZZLE_LIMIT_UNVERIFIED`).
- NEMA SM 23: per nozzle 3F + M ≤ 500 De (F lbf, M ft·lbf, De in; De = D for D ≤ 8 in, (16 + D)/3 above);
  cumulative at the exhaust: Fx ≤ 50 Dc, Fy ≤ 125 Dc, Fz ≤ 100 Dc, Mx ≤ 250 Dc, My ≤ 125 Dc, Mz ≤ 125 Dc,
  Fc + Mc/2 ≤ 125 Dc, Dc adjusted to (18 + D_eq)/3 above 9 in — one secondary source each (S19, S20), and a forum
  reports CAESAR II reading Dc differently ⇒ grade C, the user confirms the rule before it gates
  (`PST_RULE_CONFLICT`). API 617: NEMA × 1.85 (grade B).
- User table: allowable F, M per axis or resultant, with source; vessel nozzles until WRC 537 (V2).

### 5.10 Quick checks (TR-PST-10)

Closed forms with no model (`thermal_growth`, `guided_cantilever`, `pipe_sif`, `pipe_stress_allowables`,
`spring_variability`, `nozzle_load_check`): thermal growth ΔL = ᾱ ΔT L; spring P_cold = P_hot + k d, V = |k d| / P_hot; guided cantilever F = 12EIΔ/L³, M = 6EIΔ/L²,
S = 3 E Do Δ / L², L_min = √(3 E Do Δ / S_A) (M. W. Kellogg method, grade A as beam theory); SIF table §5.7;
allowables §5.6.

## 6. Interop and persistence

| Format | Direction | Phase | Notes |
| ------ | --------- | ----- | ----- |
| `.llull` document | read / write | MVP | `doc.pipeStress` slice, plugin `document` hook, version 1 |
| JSON / CSV results | write | MVP | `--json`, `--save results.csv` (one row per node × case) |
| CAESAR II neutral file `.cii` | write (V1), read (V2) | V1 | ASCII, sections headed by `#$` in columns 1–2, first section `#$ VERSION` (interface version, CAESAR II release, ANSI code page) [R12]; section list and field layout (elements, bends, restraints, SIF & tees, allowables, coordinates, units) TBD from the Hexagon CAESAR II User's Guide "Neutral file" chapter — **grade C until confirmed by a licensed user**; the writer is golden-tested on structure only until then |
| PCF (Alias ISOGEN) | write via 05 ISO | V1 | PST adds stress attributes (temperatures, pressures, support types, `COMPONENT-ATTRIBUTE` mapping) to the PCF writer of 05 ISO; CAESAR II imports PCF with a mapping file [R11, R12] |
| CAESAR II `.OUT` displacement report | read (V2) | V2 | comparison only; E3D uses the same pair (`.OUT` + `.cii`) for its return path [R10] |
| IFC 4.3 | write via 08 DAT | V2 | `IfcStructuralAnalysisModel` for the stress model is possible; not required |

## 7. CLI / MCP / UI surfaces and error codes

- CLI: every command via `llull <name> '<json>' --doc file --json`; files with `--save` (report, `.cii`,
  CSV). `llull guide` gains a "pipe stress" section: units (mm, N, MPa, °C, bar g), Z-up, defaults and their
  sources, the minimal plan (§FUNCTIONAL 6.1) (AF-03).
- MCP: toolset `pipestress`; `analyze_pipe_stress` paged by `cursor` and filtered by `nodes`, default output =
  governing summary only (AF-12).
- UI: overlay in `src/ui/viewport/3d/pipeStressOverlay.tsx` (deformed shape × scale, ratio colours green < 0.8,
  amber 0.8–1, red > 1, support arrows), a results panel reading `analyze_pipe_stress` data, and the approval
  dialog (09 PLM signature). `render_view` gains `overlay: "pipe_stress"` for `--save` (AF-22).

| Code | Severity | Meaning | Remediation |
| ---- | -------- | ------- | ----------- |
| `PST_MODEL_NOT_FOUND` | error | no stress model with that id | call `create_stress_model` first |
| `PST_NO_PIPES` | error | scope resolves to no pipe | give `pipeIds` or a `line` that exists (`building_schedule kind pipe`) |
| `PST_PIPE_NOT_FOUND` | error | a referenced pipe was deleted | `update_stress_model` scope |
| `PST_DISCONNECTED` | warn | sub-model not connected to the rest | connect the runs (02 RTE) or analyse separately |
| `PST_UNSTABLE` | error | singular stiffness: node / DOF free | add an anchor or a guide at the listed node (`add_pipe_support`) |
| `PST_BEND_TOO_TIGHT` | error | leg shorter than R1 tan(θ/2) | lengthen the leg or reduce `elbowRadiusFactor` |
| `PST_WALL_UNKNOWN` / `PST_WALL_DEFAULTED` | error / warn | no wall thickness / STD wall assumed | set `wallMm` or a 01 PSC spec |
| `PST_MATERIAL_NOT_FOUND` / `PST_MATERIAL_NO_DATA` | error | material missing E, α or S_h | `import_pipe_material_data` |
| `PST_MATERIAL_UNVERIFIED` | warn (not hideable) | allowables / α from an unsigned import | qualified reviewer signs the import |
| `PST_TEMPERATURE_OUT_OF_TABLE` | error | T outside the material table | extend the table; llull never extrapolates |
| `PST_EDITION_DEFAULTED`, `PST_CYCLES_DEFAULTED`, `PST_FRICTION_DEFAULTED`, `PST_INSTALL_TEMP_DEFAULTED` | warn | named default used | set the value explicitly |
| `PST_SIF_EDITION` | warn (not hideable) | edition requires B31J, App. D value used | `set_sif_override` with B31J values |
| `PST_NONLINEAR_NOT_CONVERGED` | error | support status oscillates | add stiffness / remove gap at listed restraints, or set them linear |
| `PST_SUPPORT_LIFTOFF` | warn | a rest lifts off in OPE or SUS | move / add a hanger or spring (`select_spring_hangers`) |
| `PST_SUSTAINED_OVERSTRESS` | fail | S_L > S_h | add supports near the node (span), reduce weight |
| `PST_EXPANSION_OVERSTRESS` | fail | S_E > S_A | add flexibility: loop / offset (02 RTE), move guides / line stops |
| `PST_OCCASIONAL_OVERSTRESS` | fail | S_L + S_OCC > 1.33 S_h | add guides / restraints for the occasional direction |
| `PST_DISPLACEMENT_LIMIT` | warn | displacement > `displacementLimitMm` | check clearances (`check_clashes` on the OPE shape, V1) |
| `PST_CREEP_RANGE` | warn | T above the creep onset of the material | out of scope: qualified engineer |
| `PST_SPRING_NO_SIZE`, `PST_SPRING_VARIABILITY`, `PST_SPRING_TABLE_MISSING` | fail / warn | no spring fits, V > limit, no table | import a vendor table; constant hanger |
| `PST_NOZZLE_OVERLOAD` | fail | ratio > 1 | add flexibility or a restraint near the nozzle |
| `PST_NOZZLE_LIMIT_MISSING`, `PST_NOZZLE_LIMIT_UNVERIFIED`, `PST_RULE_CONFLICT` | warn | no / unsigned / conflicting limits | import the standard's table under licence; confirm the rule |
| `PST_RESULTS_STALE` | warn | inputs changed since `record_pipe_stress_results` | re-run and record |
| `PST_RESULTS_FAILING` | error | approval of a failing model without disposition | fix, or record a non-conformance disposition (09 PLM) |
| `PST_HUMAN_GATE` | error | approval / verification attempted by an agent | a qualified reviewer signs in the desktop app |
| `PST_EXPORT_UNSUPPORTED` | warn | element / restraint not representable in `.cii` | listed in `data.skipped` |
| `PST_LOADCASE_INVALID`, `PST_TABLE_INVALID`, `PST_POINT_OFF_PIPE`, `PST_PARAM_INVALID` | error | malformed input | the `paths` name the param |

## 8. Performance and robustness budgets

| Item | Budget (desktop, single thread) |
| ---- | ------------------------------- |
| Model build, 2 000 nodes (≈ 12 000 DOF) | ≤ 150 ms |
| Linear solve, banded Cholesky after RCM, bandwidth ≤ 300 | ≤ 400 ms per factorisation; 10 load vectors ≤ 50 ms more |
| Non-linear case (≤ 200 one-way / friction supports) | ≤ 20 iterations typical, ≤ 50 max; ≤ 8 s |
| Full default B31.3 set (OPE, SUS, EXP, 2 OCC) on 2 000 nodes | ≤ 20 s; `--progress` per case, `--timeout` honoured (AF-40) |
| Results payload default (governing only) | ≤ 8 kB; full results paged 500 nodes / page |
| Memory | ≤ 200 MB for 12 000 DOF banded |
| Numerical | equilibrium residual ‖K u − F‖ / ‖F‖ ≤ 1e-9 checked per case; reported in `data.solver` |
| Determinism | identical node order (RCM with stable tie-break by node id), identical results bit-for-bit across runs (AF-13) |

## 9. Test strategy (mapped to VCs)

| Layer | Test | VC |
| ----- | ---- | -- |
| `@lib/frame3d` unit | cantilever tip deflection / rotation (PL³/3EI, Timoshenko term), torsion, axial; PSI element tests (10 ft NPS 10: axial 0.361 in under 1e6 lbf; reactions) | VC-PST-10, 11 |
| plugin unit `code/` | SIF / k table vs `data/sif_flexibility.json`; f by edition; SA 1a / 1b; occasional; B31.1 variants | VC-PST-01, 02, 03, 05, 13 |
| plugin unit quick checks | `thermal_growth`, `guided_cantilever` vs data files | VC-PST-04, 06 |
| plugin unit solver | PSI 3D fixture (thermal, weight, pressure) built from `add_pipe_run` + anchors; L-bend two anchors; limit stop; one-way lift-off | VC-PST-07, 08, 09, 10, 11, 12 |
| plugin unit springs / nozzles (V1) | variability closed form; NEMA example; API 610 component rule with grade-B inputs | VC-PST-14, 15 |
| contract | tool-schema snapshot gains `pipestress` tools; error codes present on every refusal; `reviewRequired` on every analysis | VC-PST-18 |
| golden (`tests/golden`) | `sc-pst-01` … `sc-pst-05` plans id-normalised, replay equality | all plans |
| integration | edit a pipe after `record_pipe_stress_results` ⇒ `PST_RESULTS_STALE`; agent `approve_pipe_stress` ⇒ `PST_HUMAN_GATE` | VC-PST-18 |
| production gate (agent driver) | refinery unit scenario: stress-critical lines (> 150 °C or on pumps) get a model, a check and a report unattended; the only stop is the approval gate | VC-AF-05 |
| reviewer-run (manual, licensed) | `.cii` import in CAESAR II; displacement comparison on 3 lines | VC-PST-16 |

Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/**` (the plugin) as for the other domain packages.

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 quick checks | `pipe_sif`, `pipe_stress_allowables`, `thermal_growth`, `guided_cantilever`, rule-set data, catalogue rows | none | 4 d |
| M2 solver core (built, §14) | `@lib/frame3d` (Timoshenko, bends with k, RCM + banded Cholesky), unit tests, PSI fixture | none | 6 d |
| M3 model + MVP commands (built, §15) | `create_stress_model`, conditions, load cases, restraints, `analyze_pipe_stress`, `check_pipe_stress`, record / approve, non-linear supports | M2; uses `add_pipe_run` / `add_pipe_support` as they are | 10 d |
| M4 review surface | overlay, panel, `render_view` overlay, report (HTML / CSV) | M3 | 5 d |
| M5 V1 | tees / olets / reducers / flanges / valves (02 RTE components), insulation, wind / seismic, springs, nozzles (03 EQP), B31.1, steel coupling (06 STA), `.cii` export, PCF attributes (05 ISO) | 01 PSC, 02 RTE, 03 EQP, 05 ISO | 20 d |
| M6 V2 | modal / response spectrum (NUREG/CR-1677), WRC 537 / 297, EN 13480-3, CAESAR II import | M5 | 25 d |

Sibling dependencies: 01-piping-specs-catalog (wall, schedule, material per spec, component dims and weights),
02-spec-driven-routing (connectivity graph, fittings with real bend radii, tees), 03-parametric-equipment (nozzle
positions / axes / growth), 05-isometrics-fabrication (PCF writer), 06-plant-structures-access (steel that receives
the support loads), 08-plant-data-reports-interop (line list "stress critical" flag), 09-plant-visualization-review
(overlay rendering at scale).

## 11. Open questions

1. Plugin home: one `plant` plugin for 01–07 or `industrial` extended? (proposal: `plant`, toolset `pipestress`).
2. Default code edition when the project does not say: proposal = **no default**, require `edition` (refuse
   `PST_EDITION_REQUIRED`) instead of a warning — safer for a non-engineer owner. Needs owner decision.
3. B31J: ship an importer for a licensed table only, or negotiate a licence for built-in values?
4. Elbow model: sub-divided chord elements (simple, proposed) or an exact curved-beam stiffness (closer to CAESAR II)?
5. Should `analyze_pipe_stress` be allowed in a plan without `record_pipe_stress_results`, or should approval
   always require a recorded revision (proposed: yes, approval needs a record)?
6. CAESAR II neutral file field layout: confirm against the CAESAR II User's Guide with a licensed user before V1.
7. Friction default μ = 0.3 (steel / steel): accept as a named default or require it per support type (PTFE 0.1)?

## 12. References

- [R1]–[R13]: see [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11.
- [R14] Pipe Stress Infinity (PSI), D. Gomes, GPL-3.0 — https://github.com/denisgomes/psi (raw files fetched 2026-10-18; tests and formulas read, not run)
- [R15] fluids 1.3.1, C. Bell, MIT — https://pypi.org/project/fluids/ (sdist read 2026-10-18; ASME B36.10M arrays)
- [R16] Hexagon CAESAR II User's Guide v13 — B31J Methods — https://docs.hexagonppm.com/r/en-US/CAESAR-II-Users-Guide/Version-13/1230689 (search extract, accessed 2026-10)
- [R17] AVEVA E3D Pipe Stress Interface User Guide 2.1 — https://help.aveva.com/AVEVA_Everything3D/2.1/PSIUG/PSIUG9.08.2.html (search extract, accessed 2026-10)
- [R18] CADMATIC Plant Modeller — Interfacing to CAESAR II — https://docs.cadmatic.com/plant/Content/Plant%20Modeller/Model/Interfacing%20to%20CAESAR%20II.htm (search result, not fetched; host blocked)
- Validation sources S1–S27: [`validation/sources.md`](validation/sources.md)

## 13. As built (M1 quick checks, 2026-11-02)

Plugin `pipeStress` (toolset `pipestress`), folder `packages/domain-aec/src/plant/stress/` (D2: one plant home, one plugin per area). No document state
yet: the four commands are read-only queries returning `data` (all `reviewRequired: true`, with `provenance`, `grade`, `defaulted`, `warnings`).

| Path | Content |
| ---- | ------- |
| `code/ruleSets.ts` | rule sets as data: `B31.3-2016..2024`, `B31.1-2016..2022` (f form, cap, floor, occasional factors, SIF basis) and the rule rows (clause, formula, sources, grade) of `validation/data/{code_rules_b313,sif_flexibility}.json` |
| `code/sif.ts`, `code/allowables.ts`, `code/thermalStrain.ts`, `data/carbonSteelC1.ts` | the closed forms and the carbon steel strain table (70 degF reference + 8 rows, source and grade per row) |
| `commands/` | `pipe_sif`, `pipe_stress_allowables`, `thermal_growth`, `guided_cantilever`; `catalog.ts`, `plugin.ts`, `codes.ts` (`PST_*` remediation) |

Section properties come from 01 PSC `sectionProperties` (`plant/catalog/sectionProperties.ts`, imported, not copied).

Decisions (recorded here; owner delegated, long-term-best):

1. **Edition is required (settles Q2, D8).** `pipe_sif` and `pipe_stress_allowables` take `rule` = `B31.3-<edition>` / `B31.1-<edition>`; no default edition, nothing to warn about. `pipe_sif` also accepts `user`. Allowable stresses `ScMPa` / `ShMPa` are inputs, never defaulted (D9).
2. **`PST_SIF_EDITION` is a warning, not a refusal** (§5.7 and §7 say warn; the §4 failure column said failure): editions that require B31J (B31.3 and B31.1 from 2020) return the appendix D value with the non-hideable warning and the `SIF-B31J` rule row (grade C); `rule: "user"` with `userSif { ii, io, k, source }` returns the caller's B31J factors unchanged and `unverified`.
3. **B31.1 returns one SIF** for both planes (`ii = io`, the 0.9 / h^(2/3) value); B31.1 f never exceeds 1.0 (no 1.2 cap), grade B rows.
4. **Components without a read source are refused, not guessed:** `sweepolet` and `reducer` (grade C) need `rule: "user"`. Flange end corrections (V1) are not implemented.
5. **`ferrousLowStrength`** is an explicit boolean (SMTS <= 517 MPa and T <= 371 degC); when omitted the cap is 1.0 and the result lists `ferrousLowStrength=false (cap 1.0)` in `defaulted`.
6. **Occasional check** folded into `pipe_stress_allowables` (inputs `sustainedMPa` + `occasionalLoadMPa` give `occasionalRatio`, VC-PST-13); `check_pipe_stress` reuses the same function in M3. B31.1 events class `occasionalEvents` (1.15 / 1.2 Sh).
7. **`thermal_growth` sources:** built-in table `carbon-steel-c1`, a document material (`thermalStrain` or secant `cte` model, through `materialCteProvider`, so PHY-01 validity ranges and `unverified` reasons apply), or `meanCtePerK`. The table is interpolated in strain from the 70 degF reference (strain 0, grade A) and never extrapolated; a temperature within 0.25 K of a row takes the row (21.1 / 204.4 degC are how SI spells 70 / 400 degF) and the result carries `PST_TABLE_EDGE_SNAPPED`. Grade A only when both ends sit on grade A nodes (the 400 degF row).
8. **Catalogue rows `pipingAllowableStress` / `meanCteFromInstall` (§2) are not added in M1.** They live in core `propertyCatalog.ts`, outside the M1 write scope, and no M1 command reads allowables from `doc.materials`; they arrive with `import_pipe_material_data` (M5; settled in section 15: M3 takes E, S_h and S_c as stated inputs). `spring_variability` and `nozzle_load_check` (listed in §5.10) belong to M5 with VC-PST-14 / 15.
9. Toolset name `pipestress` (the spec's §4 name, not the `plant_*` pattern of the sibling toolsets) is registered in `@protocol/toolsets` and the palette titles.
10. Review round 1: `guided_cantilever` takes `sif` (stress = sif x M/Z; without it an elbow is under-stated, so it no longer claims to be conservative) and warns `PST_BEAM_SLENDERNESS` below leg / OD 10; `pipe_sif` refuses R1 below the mean radius and warns `PST_SIF_CLAMPED`; `SA1b` is null with `PST_SUSTAINED_EXCEEDS_SH` when SL > Sh; `thermal_growth` refuses `cteReferenceC` without `materialId` and warns `PST_CTE_IMPLAUSIBLE` outside 1e-6..5e-5 /K; the B31.3-2022 f row (20 N^(-1/3)) is grade B (secondary sources, constant not read in a primary text).

Validation results (`tests/unit/plant/stress/`, references read from `validation/data/*.json`):

| VC | Result | Reference, tolerance |
| -- | ------ | -------------------- |
| 01 | NPS 6 Sch 40 LR / SR and DN150 SI: h, k, ii, io equal the reference | `sif_flexibility.json`, 1e-4 rel (grade A) |
| 02 | unreinforced 3.47954, welding tee 1.63662, weldolet 1.56981, reinforced (pad 0.25 in) 1.62563 | `closed_forms_output.json`, 1e-4 rel (grade B, named in the result) |
| 03 | f: 1.021249 / 1.0 / 1.045516 (N 7000), 0.6 / 0.430887 (N 1e5), 0.15 floor (N 2e8), cap crossings at 3125 and 4630 cycles | `code_rules_b313.json`, 1e-5 abs |
| 04 | 30 m, 70 -> 400 degF: 67.518 mm (reference 67.52), every table row to 0.01 in/100 ft | 0.05 mm |
| 05 | S_A (1a / 1b): 206.85 / 304.75 (f 1), 124.11 / 182.85 (f 0.6) | 1e-6 rel |
| 06 | F 6509.017 N, M 1.9527052e7 N.mm, S 140.25 MPa, Lmin 4940.546 mm | `lbend_guided_cantilever.json`, 1e-6 rel |
| 13 | occasional limit 183.407 MPa, ratio 0.76333 (rule grade B) | 1e-5 rel |

Plans: `plans/sc-pst-03-quick-checks.json` runs complete through `build_project` (plan params aligned to the built schema: `rule` instead of `edition`); `sc-pst-05` step 0 (occasional) runs, its other steps stay blocked (`blockedPlanCommands.json`).

Open: B31J import (Q3), flange corrections and reducer / sweepolet factors (V1), `spring_variability` / `nozzle_load_check` (M5), PHY-01 catalogue rows (M5, §15), VC-PST-19 stays TBD. The `doc.plant.stress` slice and the model commands are built in M3 (§15).

## 14. As built (M2 solver core, 2026-11-02)

Location: `packages/core/src/lib/frame3d/` (`@lib/frame3d/*`, a directory instead of the single `frame3d.ts` of §2; the pure leaf imports nothing outside `@lib`). Tests: `tests/unit/lib/frame3d{,Psi,Robust}.test.ts` (54 tests). No command and no plugin change: the M3 commands call `analyzeFrame` from `execute`.

**Decision (C7): TypeScript only, no Rust crate now.** The M3 commands run the solver synchronously inside a pure `execute`, so the engine must be callable in-process; `llull-route` (02 RTE V2) is a different shape (a heavy search job `auto_route_pipe` runs out of band and commits afterwards, with the TS A* kept as reference) and does not fit a read-only query. The spec's target sizes solve in TS in well under the budget: a 2 000-node lattice (11 804 free DOF, half bandwidth 243 after RCM, 2.1e6 factor entries) assembles, factors, solves two load cases and refines in about 0.5 s (budget in §8: 400 ms factorisation + 50 ms per 10 vectors; typical pipe networks have bandwidth well under 100). A native port is a later item, to be done only if M5 models (tees, insulation, response spectrum) make the 20 s full-case budget tight; the TS stays the reference and the contract (`FrameModel` in, `FrameAnalysis` out) is already host-transport shaped (plain data, typed arrays).

API (SI-style consistent units, llull plant stress uses N, mm, MPa, rad; PSI fixtures use in, lbf, psi; DOF order `[ux uy uz rx ry rz]`, Z up):

| Export | Role |
| ------ | ---- |
| `analyzeFrame(model, cases): FrameAnalysis` (`solve.ts`) | one assembly + factorisation, back-substitution per load case; never throws |
| `FrameModel { nodes, elements, restraints }` | elements carry `properties` (E, G, A, I, J, shear area; shear area 0 = Euler-Bernoulli), optional `flexibility` k (bending EI / k) and `up` |
| `FrameRestraint { node, dof, value?, stiffness? }` | no stiffness = rigid (DOF eliminated, `value` = prescribed displacement); with stiffness = ground spring (the hook M3's active-set loop uses for one-way / gap / friction supports) |
| `FrameLoadCase { name, nodal?, elemental? }` | nodal force / moment; per element global uniform load and free axial strain (thermal alpha dT, also used for the Poisson / pressure strain) |
| `FrameCaseResult` | displacements, reactions (support force on the pipe at rigid / spring DOFs), local element end forces `[N Vy Vz T My Mz] x 2`, equilibrium residual |
| `bendChords(corner, in, out, R, n?)`, `bendSubdivisions` (`bend.ts`) | near-to-far points of the arc replacing a corner; chord elements carry k |
| `pipeProperties(Do, t, E, nu, timoshenko?)` (`section.ts`) | thin-wall pipe section, A/2 shear area |
| `reverseCuthillMcKee`, `Skyline` | node ordering and the variable-band Cholesky |

Failures are typed: `FRAME_INVALID_MODEL`, `FRAME_INVALID_LOAD`, `FRAME_TOO_LARGE` (skyline above `limits.maxProfile`, default 5e7 entries = 400 MB, and never past the Int32 offset limit), `FRAME_UNSTABLE` (with the first mechanism `{ node, dof }`; M3 maps it to `PST_UNSTABLE`).

Deviations from §5.2 / §5.3 / §5.5, with reasons:

1. **Rigid restraints are eliminated, not penalised (1e12).** Exact, better conditioned, and a prescribed displacement is a right-hand-side term. Only genuinely elastic supports (springs, k_f friction stiffness) add to the diagonal.
2. **The matrix is Jacobi-scaled (D^-1/2 K D^-1/2, unit diagonal) before factoring and the pivot test is 1e-12 on the scaled pivot**, not 1e-12 of the largest diagonal: force and moment DOFs differ by orders of magnitude of L^2, and a stiff rigid link next to a soft span (tested at a 1e10 stiffness ratio) must not read as a mechanism. A true mechanism leaves a pivot of order 1e-16. (The relative pivot test is invariant under the scaling; the scaling gives the factor and the refinement a unit-diagonal system, and the 1e-12 threshold, down from 1e-10, is what stops a 1e10 stiffness ratio from reading as a mechanism: shown by the stiff-link test failing at 1e-9.)
3. **Bend sub-division is 7.5 degrees (12 chords per 90 degrees), not 15.** The spec's VC (curved-beam flexibility within 1e-3) is not met by 15 degrees: measured error vs the Castigliano closed form (bending k R^3 (3 pi/4 - 2) / EI + axial + shear terms, derived in the test) is 2.4e-2 at 2 chords, 1.9e-3 at 6, 1.0e-3 at 8, 4.4e-4 at 12 (O(1/n^2)); 12 chords is within 1e-3 for k = 1 and k = 3.2. The chord polygon keeps the arc nodes on the arc (arc-length matching made it worse).
4. **One iterative-refinement step set** (up to 3 passes, accepted only when the out-of-balance norm drops): the unrefined residual on the 12 000-DOF lattice was 1.5e-8, refined 1e-13 (thermal) and below 1e-9 (weight on a supported rim).
5. `bendChords` returns null for a near reversal (theta > pi - 0.05 rad); the caller must check each leg is at least `tangentLength` long (`PST_BEND_TOO_TIGHT`). `up` is ignored within ~0.08 degrees of the element axis. Residual (`FrameCaseResult.residual`) is `||K u - F||_free / ||F||`; on a very soft, lightly loaded model (a flat 40 m lattice carrying only its weight on four corners) it floors near 3e-9 from cancellation (0 when the load is zero); the M3 command reports it rather than refusing.

Validation results (`tests/unit/lib/`, references read from `validation/data/*.json`):

| VC | Result | Reference, tolerance |
| -- | ------ | -------------------- |
| closed form | cantilever tip P L^3 / 3EI + P L / G As, rotation P L^2 / 2EI, axial, torsion, fixed-fixed thermal E A eps, UDL R = wL/2, M = wL^2/12, cantilever UDL tip, prescribed settlement 3 E I d / L^3, orientation and split invariance | 1e-9 to 1e-12 rel |
| 03 (§5.3) | 90 degree bend (R = 300 mm, NPS 6) tip flexibility, k = 1 and 3.2; k scales bending only | Castigliano, 1e-3 |
| 12 | L-bend 6 m x 3 m: Rx, Ry at C (-7872.99, -2406.95 N), end moments C / B / A, residual; axially stiff variant (bending-only, 1e-3) | `lbend_guided_cantilever.json`, 1e-4 rel |
| 07 | PSI thermal 900 degF node 30: dy, dz, rx within 1 % of PSI (0.758, 1.891, 0.1521 deg), and 5e-4 of the independent python solver; Euler-Bernoulli variant rx 0.1534 | `psi_benchmarks.json` |
| 08 | PSI weight (steel): dy, dz, rx within 3 % of PSI (0.33, -1.31, -0.40 deg); dz 1e-3 of the python solver; sum of vertical reactions = total weight | `psi_benchmarks.json` |
| 10 | fully restrained 500 degF axial force 1.00290e6 lbf (PSI 1.00235e6) | 0.1 % |
| 11 | linear statics only (support switching is M3): simply supported 5000 lbf each end; 6 m DN100 propped cantilever rest 3125 N (Euler) and 3126.19 N (Timoshenko, 1e-4) | `expected_results.json` |

Mutations shown to fail the suite: shear term removed (9 tests), flexibility factor ignored (2), thermal load sign flipped (7), refinement off (1, the 2 000-node residual), pivot test relaxed (2). Dropping the prescribed-displacement term alone is masked by refinement (which corrects it); with refinement off as well the settlement test fails.

Left for M3: `doc.plant.stress` slice and model build (nodes, bend replacement via `bendChords`, supports to restraints), the active-set / gap / friction loop around `analyzeFrame` (re-assembly per iteration; the factorisation is not reused across support-set changes), OPE / SUS / EXP combination, code stresses from `elementForces` (end forces only; mid-element extrema are not recovered), `PST_UNSTABLE` mapping, results hash and staleness, pressure thrust as nodal loads.

## 15. As built (M3 model, analysis, check, record and approval, 2026-11-02)

Slice `doc.plant.stress` (D2: `{ models, modelOrder }`, zod-validated on load, plugin `pipeStress` document extension); code in `packages/domain-aec/src/plant/stress/`:

| Path | Content |
| ---- | ------- |
| `model/schema.ts`, `store.ts`, `document.ts` | the stored model (zod = type + load validation + tool parameters), accessors, validation, `carry` (approval through replay), `afterLoad` (stale warning) |
| `model/sources.ts`, `layout.ts`, `restraints.ts`, `build.ts` | what the model reads (building pipes, 02 RTE runs through `deriveRun`, supports), centreline to nodes and elements (`bendChords`, splits at attachments and `maxElementLengthMm`), supports and restraints to anchors and unilateral contacts |
| `solve/primitives.ts`, `nonlinear.ts`, `cases.ts`, `run.ts` | W / Tn / Pn / Fn primitives, the active-set + friction loop around `analyzeFrame`, the B31.3 default set and case validation, the per-case solve and the EXP combination |
| `code/codeStress.ts`, `analysis.ts` | S_L / S_E / occasional from element forces with SIFs and mid-element stations; the whole analysis, findings, governing, support loads, input and result hashes |
| `commands/` | `create_stress_model`, `update_stress_model`, `delete_stress_model`, `set_pipe_operating_conditions`, `set_stress_load_cases`, `add_stress_restraint`, `delete_stress_restraint`, `analyze_pipe_stress`, `check_pipe_stress`, `record_pipe_stress_results`, `approve_pipe_stress` |

Solver backstop (M2 review): `analyzeFrame` now returns `FRAME_UNSTABLE` when the Jacobi-scaled solution is out of all proportion to the scaled load (`||sqrt(K_ii) u|| / ||r / sqrt(K_ii)|| > 1e9`, about 1 over the smallest scaled eigenvalue) or non-finite; it is unit-free and does not misread a 1e10 stiffness ratio or a 200-element slender cantilever or roundoff-level loads (tested) (the unscaled `||u|| ||diag|| >> ||F||` form did: the stiff-link test failed). Test: a torsion spring of 0.1 N.mm/rad on a 9e8 N.mm/rad torsion stiffness passes the 1e-12 pivot test and is caught here. The commands map `FRAME_UNSTABLE` to `PST_UNSTABLE` (ids = nodes `N<k>`, paths = DOF names), `FRAME_TOO_LARGE` to `PST_MODEL_TOO_LARGE`.

Decisions (owner delegated, long-term-best):

1. **Material inputs are stated, not looked up (settles M1 decision 8).** `set_pipe_operating_conditions` takes `youngsModulusMPa`, `ShMPa` and `ScMPa` as required inputs (the engineer reads them from the code tables for the design metal temperature; never defaulted, D9); only the thermal strain can come from a document material (`materialId`, through `materialCteProvider`, so PHY-01 validity ranges and the `unverified` reasons apply), from the built-in carbon steel table or from a constant secant coefficient. The catalogue rows `pipingAllowableStress` and `meanCteFromInstall` are therefore **not added**: nothing reads allowables from `doc.materials`; they arrive with `import_pipe_material_data` (M5), which needs the temperature-indexed table, the licence flag and the signature of the unverified flag together.
2. **Edition is the `rule` id** (`B31.3-2018`, as `pipe_sif`), required; the spec's `code` + `edition` pair is one parameter. `friction` is `frictionCoefficient`; `millTolerancePct` and `insulation` are not in M3 (mill tolerance is not deducted, insulation and wind / seismic are M5), listed here so they are not read as forgotten.
3. **Scope = pipes or runs, not mixed.** `pipeIds` (building pipes from `add_pipe_run`, or 02 RTE run ids) or `lineId` (its runs, resolved at creation to run ids). Run bends use the RTE derived radius and the spec OD / wall; building pipes use `elbowRadiusFactor` x DN (OD when no DN); factor 0 keeps sharp corners (k = 1, i = 1, `PST_SHARP_CORNERS` warning). Pipe ends within 1 mm share a node. A pipe end on the interior of another pipe is `PST_BRANCH_UNSUPPORTED`; a run with a branch or a reducer is `PST_COMPONENT_UNSUPPORTED`; valves are plain pipe with `PST_COMPONENT_AS_PIPE`. Tees, reducers and component weights are M5.
4. **Restraints are global-axis.** Support mapping: anchor = six DOF; shoe = rest (+Z, friction mu); hanger = rest without friction; guide = rest (not on a riser) + two-way lateral restraint on the horizontal axis normal to the pipe (both horizontal axes on a riser). A guide on a pipe oblique in plan (more than 5 degrees from a horizontal axis) is `PST_RESTRAINT_OBLIQUE`: rotated restraints need frame3d support for oblique constraints (M5). Extra restraints (`anchor`, `rest`, `guide`, `translational` with axis / one-way / gap / friction) add to the mapped ones; on the same node, DOF and side the later wins with `PST_RESTRAINT_OVERRIDDEN`. Every unilateral contact has a normal sign and a gap: active = rigid at -normal x gap; two-way = two contacts.
5. **Non-linear loop.** One `analyzeFrame` per iteration (re-assembled; the factorisation is not reused), start with every zero-gap contact active, release when the reaction pulls, activate on penetration; all toggles at once until a state repeats, then the single most violated one; at most 50 iterations, `PST_NONLINEAR_NOT_CONVERGED` names the nodes and restraints that toggled in the last five. **Friction deviates from §5.5**: a stuck shoe is a stiff ground spring (1e6 N/mm, offset at the position it stuck), a slipping one a constant force mu N against the motion (direction relaxed 0.5 per iteration), slip when the spring reaction exceeds mu N, back to stick when the motion reverses. The spec's return-mapped spring offset creeps by mu N / k_f (about 1e-4 mm) per iteration, so 50 iterations never reach a thermal growth of millimetres. The slip force is reported as the support reaction. OPE, SUS and OCC cases are solved separately and never superposed; EXP is the algebraic combination (OPE - SUS).
6. **Pressure** acts through the code stress (S_a includes P Di^2 / (Do^2 - Di^2)); `poissonPressure` (default false, listed in `defaulted`) adds the hoop Poisson contraction as a free axial strain. Thrust and Bourdon are not modelled (V2).
7. **Code stress** at both ends of every element and at the interior bending extremum of a loaded element (equilibrium of the part before the cut, unit-tested against 9 w L^2 / 128 at x = 5L/8 of a propped cantilever). Interior stations are the component extrema (V = 0 per bending plane) and the maximum of the resultant moment sampled at 32 points when it exceeds both ends (a load out of one plane peaks where neither component does). Bends: the bend-plane normal splits the moment into in-plane and out-of-plane; straight pipe is i = 1. B31.3 sustained and occasional S_L = sqrt((|S_a| + S_b)^2 + (2 S_t)^2) on the wall less the corrosion allowance with I = max(1, 0.75 i); expansion S_E = sqrt(S_b^2 + 4 S_t^2) with i on the nominal wall; S_A is eq. (1b) with the sustained S_L of the SUS case when S_h > S_L (the larger S_L over both end nodes of the element, which is conservative: the smaller allowable), eq. (1a) otherwise (liberal, as the rule rows state). B31.1: P Do / 4 t + 0.75 i M_A / Z (0.75 i >= 1) and i M_C / Z. OPE is not checked (displacements and loads only). The B31J editions give `PST_SIF_EDITION`.
8. **Corrosion allowance** at or above the wall less 0.1 mm is `PST_CORROSION_EXCEEDS_WALL` (where it is set with a wall, and at analysis for walls read from specs); a non-finite stress or ratio is the refusal `PST_STRESS_NOT_FINITE` (§16), never a silent pass or a recorded value.
9. **Findings and status.** `PST_SUSTAINED_OVERSTRESS`, `PST_EXPANSION_OVERSTRESS`, `PST_OCCASIONAL_OVERSTRESS` (fail), `PST_SUPPORT_LIFTOFF`, `PST_DISPLACEMENT_LIMIT`, `PST_RESULTS_STALE`, `PST_SIF_EDITION`, `PST_MATERIAL_UNVERIFIED`, `PST_*_DEFAULTED`, `PST_DISCONNECTED`, `PST_CASE_INCOMPLETE` (warn). Status `fail` with any fail item, `incomplete` without a SUS or an EXP case, else `pass`. `analyze_pipe_stress` pages nothing: details are filtered by `cases` / `nodes` / `include` (the `cursor` of §4 is not built; the default output is the summary).
10. **Record and approval.** `record_pipe_stress_results` stores status, findings, governing ratios, support loads per case and two hashes: `inputHash` (the stored model without record and approval, the resolved pipes and supports, the thermal material record, the solver version) and `resultHash`. Any edit of the model, a pipe, a support or the material changes the input hash, so the record is stale (`PST_RESULTS_STALE`, never a silent pass; `afterLoad` warns too). `approve_pipe_stress` copies the PSC `approve_pipe_spec` gate: signature over `{ act plant:approve_pipe_stress, modelId, inputHash, resultHash }`, spent once, and **checked after** recorded-ness (`PST_NOT_RECORDED`), freshness (`PST_RESULTS_STALE`) and status (`PST_RESULTS_FAILING`, `PST_RESULTS_INCOMPLETE`), so a signature is never spent on results that cannot be approved. `at` is host-filled (`HOST_STAMPED`) and stored, not part of the signed payload (as in PSC: the human signs before the host stamps the time). Residual: an in-process caller that holds a valid signature can choose `at`; it is metadata (when), not authority (who and what: the signature over the hashes). Before a signature is spent the analysis is **rerun** and must reproduce the stored input hash, result hash and status (a forged record in a file is `PST_RESULTS_STALE`); on load an approval needs a record with equal hashes, sha256 hashes and an ISO-UTC time, else the file is rejected. Every edit command drops the approval; the record stays as stale evidence.
11. **Approval through replay: plugin `carry`, not a ledger.** PSC seeds an approval ledger through `replaySeed`, but the host merges seeds shallowly (`Object.assign`), so a second plugin seeding `plant` would erase the first. The stress plugin instead re-attaches, after a replay or regenerate, the approval of the previous document to a model whose replayed record has the same `inputHash` and `resultHash` (a recorded step is deterministic) and whose current input hash still equals the recorded one (a pipe or support edited after the record step is not covered), and to nothing else. It re-attaches even if the approve step was removed from the history: the approval is held by the previous document, not by the step. The recorded step carries `confirmation { verified: true }`, which is a no-op report (`approved: false`, `marker: true`), never an approval: a forged marker approves nothing, and a replay does not fail on it.

Validation results (`tests/unit/plant/stress/m3*.test.ts`, references from `validation/data/*.json`; the plans `sc-pst-01`, `02`, `04` run end to end through `build_project`, `scenarioPlans.test.ts`):

| VC | Result | Reference, tolerance |
| -- | ------ | -------------------- |
| 07 | PSI 3D thermal 900 degF through the commands, node 30: dy 0.758 in, dz 1.891 in, rx 0.1521 deg | `psi_benchmarks.json`, 1 % |
| 08 | PSI weight, node 30: dy 0.33, dz -1.31 in, rx -0.40 deg; the anchors carry the whole weight | 3 %; 1e-7 |
| 09 | pressure alone: B31.3 S_a = P Di^2 / (Do^2 - Di^2) = 8.0213 MPa, B31.1 P Do / 4t = 9.4934 MPa at 2 MPa DN100 | 1e-4 |
| 10 | fully restrained 10 ft NPS 10, 500 degF: 1.00290e6 lbf (PSI 1.00235e6) | 0.1 % |
| 11 | 6 m DN100 propped cantilever: rest 3126.19 N (5P/16 = 3125, Timoshenko), lift-off (reaction 0, `lifted`, `PST_SUPPORT_LIFTOFF`), 5 mm gap (open / closed at the gap face), friction (a shoe slides and carries mu N exactly; a stiff low-growth case sticks) | 1e-3; 1e-6 |
| 12 | two-anchor L-bend through the commands: Rx, Ry at C and S_max 106.79 MPa within 2 % of the Euler-Bernoulli reference (the model is Timoshenko: equal to a direct `analyzeFrame` call to 1e-6; 7772.37 vs 7872.99 N) | `lbend_guided_cantilever.json` |
| 18 | refusals carry codes; `reviewRequired` on every analysis; defaults listed; unsigned thermal source `PST_MATERIAL_UNVERIFIED`; edit after record `PST_RESULTS_STALE`; agent approval `PST_HUMAN_GATE` | exact codes |

Mutations shown to fail the suite: the sign of the mid-element load term, the freshness check of the approval, the approval drop on edit, the replay carry, the friction reaction, the release rule, the signed payload (hashes removed), the supports in the input hash; the backstop test fails with the ratio at 1e99; the host stamp test fails without the `HOST_STAMPED` entry.

Left for M4 / M5: overlay, panel, `render_view` overlay, report (M4); `import_pipe_material_data` with the `pipingAllowableStress` / `meanCteFromInstall` rows, tees / olets / reducers / flanges / valves, insulation, wind / seismic, mill tolerance, springs, nozzles, steel coupling, `.cii` export, PCF attributes, `set_sif_override`, imposed displacements Dn, hydrotest WW, `cursor` paging, rotated (oblique) restraints, E(T) and `scalar` / `srss` combinations (M5); the exact stress at a node shared by a straight pipe and a bend uses both elements' ends and takes the larger.

## 16. As built (PST-GATE and PST-HARDEN, 2026-11-03)

- **Marker only inside replay.** `approve_pipe_stress` with a recorded `{ verified: true }` is `PST_HUMAN_GATE` (path `confirmation`) unless `ctx.replaying` is set, which only `replayHistory` sets (as `approve_pipe_spec` / `issue_isometric`). During replay it stays the no-op report (`marker: true`) and the plugin `carry` re-attaches the real approval; this supersedes the "forged marker is a no-op report" wording of decision 11.
- **Non-finite stress is a refusal.** `analyzeStressModel` returns `PST_STRESS_NOT_FINITE` (ids = nodes or elements, path `conditions.material`) when any station stress or ratio is NaN or infinite, so `analyze_pipe_stress`, `check_pipe_stress` and `record_pipe_stress_results` refuse and nothing non-finite is recorded; this replaces the fail finding of decision 8. A non-finite solve (displacements or reactions) is already refused upstream by the `analyzeFrame` backstop as `PST_UNSTABLE` (tested with an overflowing force).
- Tests: `tests/unit/plant/stress/pstGate.test.ts` (live refusal, replay path, `carry` with a differing result hash, non-finite refusal; each shown to fail with its fix removed).
