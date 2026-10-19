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
packages/core/src/lib/frame3d.ts            pure 3D frame/pipe-beam numerics (stiffness, assembly, banded Cholesky, RCM)   [new, core lib]
packages/core/src/model/propertyCatalog.ts  + rows 'pipingAllowableStress' (Pa, strength, owner 07 PST) and 'meanCteFromInstall' (1/K)
packages/domain-aec/src/plant/stress/       plugin `plant` (toolset `pipestress`) — the PST commands
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
| `thermal_growth` | query | `materialId` \| `table: "carbon-steel-c1"`, `fromC`, `toC`, `lengthM` | `growthMm`, `mmPerM`, `meanCtePerK`, source | `PST_TEMPERATURE_OUT_OF_TABLE`, `PST_MATERIAL_NO_DATA` |
| `pipe_sif` | query | `component: elbow\|bend\|welding_tee\|unreinforced_tee\|reinforced_tee\|weldolet\|sweepolet\|reducer\|butt_weld`, `odMm`, `wallMm`, `bendRadiusMm?`, `padMm?`, `rule` (`B31.3-2018`, `B31.1`, `user`) | `h`, `k`, `ii`, `io`, `formula`, `grade` | `PST_SIF_EDITION` (B31.3 ≥ 2020 without user values), `PST_PARAM_INVALID` |
| `pipe_stress_allowables` | query | `ScMPa`, `ShMPa` \| `materialId`+`tempC`+`installTempC`, `cycles`, `edition`, `SLMPa?`, `ferrousLowStrength?` | `f` (raw, capped, floored), `SA1aMPa`, `SA1bMPa`, `occasionalMPa` | `PST_PARAM_INVALID` |
| `guided_cantilever` | query | `legMm`, `displacementMm`, `odMm`, `wallMm`, `EMPa`, `SAMPa?` | `forceN`, `momentNmm`, `stressMPa`, `minLegMm` | `PST_PARAM_INVALID` |
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
| M2 solver core | `@lib/frame3d` (Timoshenko, bends with k, RCM + banded Cholesky), unit tests, PSI fixture | none | 6 d |
| M3 model + MVP commands | `create_stress_model`, conditions, load cases, restraints, `analyze_pipe_stress`, `check_pipe_stress`, record / approve, non-linear supports | M2; uses `add_pipe_run` / `add_pipe_support` as they are | 10 d |
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
