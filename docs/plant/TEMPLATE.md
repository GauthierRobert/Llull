# Plant design gap specs — authoring template

Same layout and rules as the aerospace packs ([`../aerospace/TEMPLATE.md`](../aerospace/TEMPLATE.md)) and the same
agent-first requirements ([`../aerospace/AGENT_FIRST.md`](../aerospace/AGENT_FIRST.md), `AF-nn`), applied to process-plant
design (the AutoCAD Plant 3D / Plant Design Suite, AVEVA E3D, Hexagon Smart 3D, CADMATIC class of tools).

Every gap folder `docs/plant/NN-<gap>/` holds:

```
FUNCTIONAL_SPEC.md     what / why / for whom (owner-operator, EPC, fabricator) — product view, no code
TECHNICAL_SPEC.md      how it lands in llull — layer, data model, commands, algorithms, error codes, tests, delivery
validation/README.md   validation plan: real use cases, VC table (inputs, expected value, tolerance, source, grade)
validation/sources.md  every source: id, URL, what was taken, how it was checked, grade A/B/C
validation/expected_results.json   index of every VC
validation/data/       downloaded reference files (sha256 + licence) and transcribed tables
validation/plans/      build_project scenario plans (CLI `llull run plan.json`), unbuilt commands flagged
```

Plant-specific rules:

- Requirement ids `FR-<GAP>-nn`, `TR-<GAP>-nn`, `VC-<GAP>-nn`; `<GAP>` is the three/four-letter id in [`README.md`](README.md).
- Source grades: **A** primary source read, reference code run, or ≥ 2 independent sources agree; **B** one secondary
  extract; **C** located, numbers not confirmed. Only grade A values and cited closed forms gate pass / fail.
- Paywalled standards (ASME, API, ISO, EN, TEMA, ISA): cite the catalogue page, state only public facts; dimension
  tables are taken from freely published manufacturer catalogues or open-source data packages, cross-checked by two
  sources, never invented.
- Downloaded files: record URL, sha256, size, licence; redistribute only when the licence allows, otherwise keep the
  hash, the URL and the extracted numbers.
- Specs only: no change under `packages/`, `src/`, `server/`, `desktop/`.
