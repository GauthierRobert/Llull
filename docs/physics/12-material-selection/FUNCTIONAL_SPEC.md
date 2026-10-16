# PHY-12 — Material selection & substitution — Functional spec

Gap id **SEL** · Status: specification (no implementation) · Written 2026-10-15
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Sources: [validation/sources.md](validation/sources.md) · Gap list: [../README.md](../README.md) (PHY-12, P3)

---

## 1. Summary

Once the aerospace packs are built, llull holds rich, sourced material records (08 MAT), linear FEA with
margins (05 FEA) and laminate properties (06 CMP). It still cannot answer the most common question an owner
asks about a part: **"would another material be lighter, stiffer, cheaper, or still strong enough?"** There is
no way to rank materials for a loading case, to filter them by constraints, or to swap a material on a part
and see what happens to mass, stiffness and margins without rebuilding the analysis by hand.

This gap adds that capability as **read-only data plus checks**. Ashby performance indices are stored as a
sourced rule table and derived analytically; `material_index`, `compare_materials` and `material_chart_data`
rank and plot materials from the document's library; `substitute_material` is a what-if that re-computes mass
exactly, scales stiffness by an explicit design rule, and either re-scales margins (only when that is exact)
or returns the plan that re-runs 05 FEA. Applying a substitution stays the existing 08 `assign_material`
command, under 09 PLM change control for released parts. Nothing is defaulted silently; missing properties
are reported, never imputed.

## 2. Aerospace context & value

- **Why indices.** The mass of a part that must meet a stiffness or strength target depends on a combination
  of properties, not on one property. A tie needs high E/ρ; a beam with free section size needs high E^½/ρ; a
  panel with free thickness needs high E^⅓/ρ. The exponents come from how the constraint scales with the free
  dimension [R1][R2]. Ranking by density alone or by E alone gives the wrong answer for most structural parts.
- **Who does it today.** Ansys Granta Selector (formerly CES Selector, Granta Design, acquired by Ansys in 2019)
  applies the Ashby method over a 4,000+ material dataset with charts and an Eco Audit of energy and CO₂ per
  life stage [R5]. Small suppliers use spreadsheets of handbook values. Neither is connected to the CAD part:
  a substitution means re-entering geometry, re-running FEA and re-checking mass by hand.
- **Why it matters for certification.** A material change on a certified part is a type-design change whose
  minor/major classification is a recorded human decision (14 CFR 21.93, handled by 09 PLM) [R6]. The
  substitution study is the evidence package for that decision, so it must be reproducible, sourced and flagged
  where data is typical rather than an allowable (AF-32, AF-33).
- **llull's value.** One CLI call ranks the materials the user actually holds (seed, company or licensed
  library, 08 private storage) against the part's real loading case, and a second call shows the effect of the
  swap on that part, with every number carrying its source, basis and `unverified` flag.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent driving the `llull` CLI (cloud: MCP) | `material_index`, `compare_materials`, `substitute_material`, `check_material_selection` | Rankings and what-ifs as JSON with units, provenance, stable codes |
| **Owner** | Person asking "can this be lighter / cheaper?" **Not assumed to be an engineer** | Natural language; may watch the desktop app | A short, honest answer: which option wins, by how much, and which numbers are typical or need a human |
| **Qualified reviewer** | Stress or M&P engineer | Desktop review of the substitution report; 09 ECO classification | Decides whether a substitution is acceptable and classifies the change (human gate) |

- **US-1 (owner → operator).** "Could this 7075 bracket be lighter in titanium?" The agent runs
  `substitute_material designRule=same_geometry` and reports +57.6 % mass (same shape), and the equal-stiffness
  mass ratio 1.25, with "Ti modulus is a secondary value; result unverified" (VC-SEL-11/12).
- **US-2 (operator).** The agent ranks four candidates for a beam-like fitting with
  `compare_materials objectives=[beam_stiffness 0.7, beam_strength 0.3] constraints=[Fty ≥ 400 MPa]`. The CFRP
  row is excluded with `SEL_PROPERTY_MISSING` (no sourced density), never ranked on a guess (VC-SEL-14).
- **US-3 (operator).** After a swap the agent sees `SEL_MARGINS_NEED_RESOLVE` because the model mixes two
  materials, runs the returned plan (05 `fea_mesh`, `fea_solve`, `compute_margins`) and then
  `check_material_selection`.
- **US-4 (reviewer).** The M&P engineer reads the saved substitution report, sees the basis of every input,
  and classifies the change in the 09 ECO.
- **US-5 (operator, COULD).** With a user-imported, licensed cost or embodied-carbon table, the agent adds a
  cost or CO₂ objective and reports the Pareto set (VC-SEL-05).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Performance-index rule table (7 cases) with derivations; `material_index`; `compare_materials` (single objective, constraints, missing-data report); `substitute_material` mass + same-geometry stiffness; `check_material_selection`; stable codes; `unverified`/basis propagation |
| **V1** | Multi-objective weighted ranking and Pareto set; equal-stiffness / equal-strength design rules; margin re-scaling with exactness conditions, else a re-solve plan for 05 FEA; `material_chart_data` (numeric Ashby chart); temperature-dependent selection through PHY-01 property models; composite laminate effective properties from 06 CMP |
| **V2** | User-defined indices (exponent form) with mandatory derivation note; cost (`pricePerMass`) and embodied carbon (`embodiedCarbon`) objectives from user-imported licensed tables; batch substitution across an assembly; link of a saved study to the 09 ECR |

**Out of scope.** Shipping any property dataset (08 data policy), shipping ICE or other embodied-carbon data
(licence, §8), shape factors and section-efficiency charts beyond the square/solid sections of the rule table,
process selection, automatic material choice without a human decision on certified parts.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-SEL-01 | MUST | llull holds a **performance-index rule table** (case, component, objective, constraint, free variable, property, exponent, index) for: tie stiffness E/ρ, tie strength σf/ρ, beam stiffness E^½/ρ, beam strength σf^⅔/ρ, panel stiffness E^⅓/ρ, panel strength σf^½/ρ, Euler column E^½/ρ. Each row names its derivation and source. | AF-30: the agent must not need to know the rule | R1, R2; VC-SEL-01 |
| FR-SEL-02 | MUST | `material_index` returns, for each requested material and index, the value with its unit string, the property values used (with basis, source, temperature) and the `unverified` flag. | AF-10, AF-35 | VC-SEL-02, VC-SEL-10 |
| FR-SEL-03 | MUST | `compare_materials` ranks materials by one index (descending), with a deterministic tie-break (material id). | AF-13 | VC-SEL-03 |
| FR-SEL-04 | MUST | Constraints: minimum / maximum on any 08 property (with unit), required properties, temperature range. Materials that fail are listed with the failing constraint; materials that lack a constrained property are listed as `missing`, never treated as passing or failing. | Silent exclusion hides data gaps | VC-SEL-04 |
| FR-SEL-05 | SHOULD | Multi-objective ranking: weighted sum of indices normalised to the best candidate, and the Pareto (non-dominated) set for 2–3 objectives. Weights are explicit; equal weights only as a named default. | Owners trade mass against cost | VC-SEL-05, VC-SEL-06 |
| FR-SEL-06 | COULD | User-defined index `Π Pᵢ^aᵢ / ρ` with a required derivation note stored with the study. | Special loading cases | VC-SEL-19 |
| FR-SEL-07 | MUST | `substitute_material` (read-only what-if) computes, for given entities and a candidate material: mass before/after (same `mass_properties` path, 08 units), and under an explicit `designRule` (`same_geometry`, `equal_stiffness_beam`, `equal_stiffness_panel`, `equal_stiffness_tie`, `equal_strength_tie`, `equal_strength_beam`, `equal_strength_panel`) the stiffness, deflection or mass ratio. | US-1 | VC-SEL-07, VC-SEL-10…13 |
| FR-SEL-08 | MUST | Margins: when 05 results exist, `substitute_material` re-scales margins **only** when the re-scaling is exact (TECHNICAL_SPEC §5.4 conditions); the rescaled MS is labelled `method: "rescaled"`. Otherwise it returns `SEL_MARGINS_NEED_RESOLVE` with the failed conditions and a ready-to-run plan (dry-run substitution, `fea_mesh`, `fea_solve`, `compute_margins`). | Margins drive substantiation | VC-SEL-08, VC-SEL-15 |
| FR-SEL-09 | MUST | The exactness conditions are reported one by one (single material in the analysed model, same ν within tolerance, no density-driven or thermal loads, no non-zero prescribed displacements, same allowable basis). | AF-35: explain why | VC-SEL-09 |
| FR-SEL-10 | MUST | No property is imputed. A material without a required property is excluded with `SEL_PROPERTY_MISSING` and the missing names. | AF-31 | VC-SEL-14 |
| FR-SEL-11 | MUST | `unverified` propagates from every 08 input (typical, supplier_unstated, legacy, secondary) into indices, rankings, ratios and margins (AF-32). Rescaled margins carry `reviewRequired: true` (AF-33). | Typical values are not allowables | VC-SEL-10, VC-SEL-15 |
| FR-SEL-12 | MUST | Mixed bases in one comparison (e.g. a typical E against an A-basis Fty, or typical vs A between candidates) give the warning `SEL_BASIS_MIXED` listing the bases. | Like-for-like comparison | VC-SEL-16 |
| FR-SEL-13 | SHOULD | Selection at an operating temperature evaluates PHY-01 property models; outside a model's valid range the material is excluded with the PHY-01 code `PROP_OUT_OF_RANGE`, never extrapolated. | Properties at the operating point | PHY-01; VC-SEL-20 |
| FR-SEL-14 | COULD | Cost and embodied-carbon objectives from user-imported values (`pricePerMass`, `embodiedCarbon`) carrying date, currency or system boundary, licence flag and source. llull ships no such data. | ICE licence (R4) | R4; VC-SEL-05 |
| FR-SEL-15 | MUST | Anisotropic materials: a 06 composite is compared only through the effective in-plane properties of a named layup (06 CLT), with the warning `SEL_ANISOTROPIC` (through-thickness and failure modes not represented by a scalar index). Lamina E1 is never used as an isotropic E. | Avoid a 2× error | VC-SEL-17 |
| FR-SEL-16 | MUST | Applying a substitution is the 08 `assign_material` command. On a 09-released item it is refused by 09's lock until an ECO is open; the saved study (`--save`) is the evidence for the ECO. SEL itself has no mutating command. | L1, 09 change control | R6; VC-SEL-21 |
| FR-SEL-17 | MUST | `check_material_selection` (AF-20) lists: unverified inputs, mixed bases, missing properties, anisotropic warnings, stale 05 results after a material change, and substitutions applied to released items without an ECO. | Agent proves its work | VC-SEL-16 |
| FR-SEL-18 | SHOULD | `material_chart_data` returns log-log points for two chosen properties (or indices) and the index guide lines (slope = 1/n) as data; the UI Ashby chart is drawn from it (AF-21). | Numeric equivalent of the chart | VC-SEL-18 |
| FR-SEL-19 | MUST | Every refusal and check item has a stable `SEL_*` code, ids and remediation (TECHNICAL_SPEC §7.1). | AF-11 | VC-SEL-16 |
| FR-SEL-20 | MUST | Named defaults (AF-31): weights (equal, `defaulted: true`), ν tolerance for margin re-scaling (0, i.e. identical; OQ-SEL-02), the yield factor reused from 05 with its source. | No silent rule values | VC-SEL-22 |

## 6. Workflows

### 6.1 CLI (operator, primary)

```bash
llull search material index ; llull describe compare_materials substitute_material   # AF-01, AF-02
llull material_index '{"materials":["aa7075_t6","ti6al4v_annealed"],"indices":["beam_stiffness","tie_strength"],"strengthProperty":"Fty"}' --doc part.llull.json --json
llull run validation/plans/compare_bracket_materials_proposed.json --validate --doc part.llull.json
llull run validation/plans/compare_bracket_materials_proposed.json --doc part.llull.json --json
llull substitute_material '{"entityIds":["box-3.1"],"from":"aa7075_t6","to":"ti6al4v_annealed","designRule":"same_geometry","include":["mass","stiffness","margins"]}' --doc part.llull.json --json --save out/substitution.json
# if data.code == SEL_MARGINS_NEED_RESOLVE: run data.resolvePlan (05 FEA) on a copy, then
llull check_material_selection --doc part.llull.json --json
# decision by a human; then (unreleased part) apply:
llull assign_material materialName=ti6al4v_annealed 'entityIds=["box-3.1"]' --doc part.llull.json
```

The agent's report to the owner lists: the winner and the margin over the runner-up, the effect on mass,
which inputs are typical / secondary (`unverified`), and that the change needs a qualified engineer's decision
when the part is certified.

### 6.2 MCP (cloud)

The `selection` toolset exposes the four read-only commands. Private-library values follow 08 TR-MAT-32
redaction: a cloud client receives rankings and ratios (dimensionless) but redacted property values when the
library licence is `licensed-no-redistribution`.

### 6.3 UI (review only)

Ashby chart (from `material_chart_data`), ranking table with basis and `unverified` badges, substitution
report viewer. No selection logic lives in the UI.

## 7. Acceptance criteria

`D` = `--doc case.llull.json --json`. Expected values: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | the rule table | `llull material_index …` on each case | exponents 1, 1, ½, ⅔, ⅓, ½, ½ | VC-SEL-01 |
| AC-2 | the 5 synthetic materials | `llull compare_materials … objectives=[beam_stiffness] D` | order syn_d, syn_a, syn_e, syn_b, syn_c; index values to 1e-9 | VC-SEL-02, 03 |
| AC-3 | constraint strength ≥ 550 MPa, service T ≥ 110 °C | `compare_materials … D` | passing = syn_b, syn_c, syn_d | VC-SEL-04 |
| AC-4 | objectives relative mass and relative cost | `compare_materials … pareto=true D` | Pareto set syn_a, syn_c, syn_d | VC-SEL-05 |
| AC-5 | syn_a → syn_b, MS 0.25 | `substitute_material … D` | same-geometry mass ×2, beam equal-stiffness mass ×1.59545, rescaled MS 1.25 | VC-SEL-07, 08 |
| AC-6 | a two-material model | `substitute_material include=[margins] D` | exit 0, `data.margins.code: "SEL_MARGINS_NEED_RESOLVE"`, failed condition `single_material` | VC-SEL-09 |
| AC-7 | the 7075 block (08 plan) | `llull run plans/substitute_block_ti_proposed.json D` | mass 140.5 g → 221.439 g, `unverified: true` | VC-SEL-10, 11 |
| AC-8 | CFRP row without density | `compare_materials D` | excluded, `SEL_PROPERTY_MISSING`, `missing: ["density"]` | VC-SEL-14 |
| AC-9 | typical vs A-basis inputs | `check_material_selection D` | warning `SEL_BASIS_MIXED` | VC-SEL-16 |

## 8. Standards & regulatory alignment

- **Method:** Ashby performance indices (ASM Handbook vol. 20, catalogue only) [R1]; derivations re-done
  analytically in the validation generator, so llull does not depend on paywalled text [R2].
- **Data:** material values come only from 08 MAT records with basis and provenance; certification use needs
  A/B-basis values (14 CFR 25.613, see 08) — SEL never upgrades a basis.
- **Change control:** a substitution on a certified part is a type-design change; classification per 14 CFR
  21.93 / Part 21.A.91 is a human act in 09 PLM [R6].
- **Embodied carbon:** ICE (Circular Ecology) requires a Tools and Integration Licence to embed data in a tool;
  llull therefore only imports user-licensed tables [R4].

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Index exponents vs analytic derivation | exact (abs 1e-9) |
| Ranking and Pareto results on the synthetic set | 100 % match |
| Results computed from typical/secondary data without `unverified` | 0 |
| Materials ranked despite a missing required property | 0 |
| Margins re-scaled when an exactness condition fails | 0 |
| `compare_materials` over 1,000 records × 3 objectives | ≤ 200 ms (TECHNICAL_SPEC §8) |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Owner treats a typical-value ranking as a design allowable comparison | `unverified` on every row, `SEL_BASIS_MIXED`, summary sentence in plain words |
| Index misapplied to a part whose loading is not one of the cases | The agent must name the case; `check_material_selection` warns when no case is given for a substitution (`SEL_DESIGN_RULE_UNSET`) |
| Margin re-scaling used outside its validity | Exactness conditions enforced, else re-solve plan |
| Licensed cost/CO₂ data leaking | 08 licence flags and private storage; no bundled data |
| Assumption | 08 MAT records, 05 FEA, 06 CLT and 09 PLM exist (aerospace baseline); PHY-01 for temperature |

## 11. References

- [R1] M. F. Ashby, "Performance Indices", ASM Handbook Vol. 20 — ASM International — https://dl.asminternational.org/handbooks/edited-volume/59/chapter/687368 (accessed 2026-10; catalogue)
- [R2] Ashby method lecture notes — NPTEL 112104122 lecture 24; IIT Kharagpur DOME notes — https://archive.nptel.ac.in/content/storage2/courses/112104122/lecture24/24_5.htm ; https://facweb.iitkgp.ac.in/~jeevanjyoti/teaching/dome/2025/notes/materials.pdf (accessed 2026-10; secondary, exponents re-derived)
- [R3] Stress independence of elastic constants (Michell) — arXiv 1204.6419; J. Elasticity — https://arxiv.org/pdf/1204.6419 ; https://link.springer.com/article/10.1007/s10659-005-9040-2 (accessed 2026-10)
- [R4] ICE database registration and licence changes — Circular Ecology — https://circularecology.com/?p=7239 ; https://circularecology.com/?p=7291 (accessed 2026-10)
- [R5] Ansys Granta Selector — CADFEM / Develop3D — https://www.cadfem.net/en/systematic-selection-of-materials-using-ansys-granta-selector-13138.html ; https://develop3d.com/product-design/masters-of-the-material-world/ (accessed 2026-10)
- [R6] 14 CFR 21.93 Classification of changes in type design — Cornell LII — https://www.law.cornell.edu/cfr/text/14/21.93 (accessed 2026-10; via 09 PLM [R7])
- [R7] 08 MAT FUNCTIONAL/TECHNICAL_SPEC and validation sources S12, S15, S16 — llull — `../../aerospace/08-materials-standards-libraries/`
- [R8] 05 FEA TECHNICAL_SPEC §5.8 margins — llull — `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`
