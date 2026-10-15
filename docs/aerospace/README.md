# Aerospace / aeronautics gap analysis — specifications

Status: **specifications only** (no implementation). Written 2026-10-15.
Product direction (user decision): **Electron desktop + offline first**, OpenCascade (OCC) as the desktop
kernel, bundled CPython + CadQuery (see [`../decisions/KI6-desktop-app-cli-first.md`](../decisions/KI6-desktop-app-cli-first.md)).

## Why this exists

llull today is production-grade for AEC (civil, building, industrial steel — see
[`../PRODUCTION_GATE.md`](../PRODUCTION_GATE.md)) and an entry-level parametric solid modeler for mechanical
parts. Aerospace design offices and their supply chain need capabilities that llull does not have. Each gap
below has a **functional spec** (what / why / for whom), a **technical spec** (how it fits llull's
architecture laws, data model, commands, algorithms, tests) and a **validation pack** (real use cases,
public reference files, analytic expected results with sources) to prove a future implementation.

Authoring rules and section layout: [`TEMPLATE.md`](TEMPLATE.md).

## Gaps

| # | Gap | Id | Functional | Technical | Validation |
| - | --- | -- | ---------- | --------- | ---------- |
| 01 | Exact B-rep kernel as production basis (OCC default, STEP→B-rep, naming, large assemblies) | KRN | [spec](01-exact-brep-kernel/FUNCTIONAL_SPEC.md) | [spec](01-exact-brep-kernel/TECHNICAL_SPEC.md) | [pack](01-exact-brep-kernel/validation/README.md) |
| 02 | Advanced freeform surfacing (NURBS, G2/G3, surface analysis, airfoils, wings, fuselage lofts) | SRF | [spec](02-advanced-surfacing/FUNCTIONAL_SPEC.md) | [spec](02-advanced-surfacing/TECHNICAL_SPEC.md) | [pack](02-advanced-surfacing/validation/README.md) |
| 03 | GD&T, Model-Based Definition, semantic PMI, tolerance stack-up | GDT | [spec](03-gdt-mbd-pmi/FUNCTIONAL_SPEC.md) | [spec](03-gdt-mbd-pmi/TECHNICAL_SPEC.md) | [pack](03-gdt-mbd-pmi/validation/README.md) |
| 04 | Data exchange: STEP AP242 (PMI), JT, IGES, QIF, LOTAR | XCH | [spec](04-interop-ap242-jt-iges/FUNCTIONAL_SPEC.md) | [spec](04-interop-ap242-jt-iges/TECHNICAL_SPEC.md) | [pack](04-interop-ap242-jt-iges/validation/README.md) |
| 05 | Structural analysis hand-off (idealization, meshing, Nastran / CalculiX, margins of safety) | FEA | [spec](05-fea-cae-handoff/FUNCTIONAL_SPEC.md) | [spec](05-fea-cae-handoff/TECHNICAL_SPEC.md) | [pack](05-fea-cae-handoff/validation/README.md) |
| 06 | Composite structures (plies, laminates, drape, flat patterns, CLT) | CMP | [spec](06-composites/FUNCTIONAL_SPEC.md) | [spec](06-composites/TECHNICAL_SPEC.md) | [pack](06-composites/validation/README.md) |
| 07 | Manufacturing features (aerospace sheet metal, holes, threads, pockets, feature recognition) | FTR | [spec](07-sheet-metal-machined-features/FUNCTIONAL_SPEC.md) | [spec](07-sheet-metal-machined-features/TECHNICAL_SPEC.md) | [pack](07-sheet-metal-machined-features/validation/README.md) |
| 08 | Aerospace materials (allowables, basis) & standard parts (NAS / MS / AN / EN fasteners) | MAT | [spec](08-materials-standards-libraries/FUNCTIONAL_SPEC.md) | [spec](08-materials-standards-libraries/TECHNICAL_SPEC.md) | [pack](08-materials-standards-libraries/validation/README.md) |
| 09 | Configuration management, revisions, effectivity, FAI, traceability, export control | PLM | [spec](09-plm-configuration-traceability/FUNCTIONAL_SPEC.md) | [spec](09-plm-configuration-traceability/TECHNICAL_SPEC.md) | [pack](09-plm-configuration-traceability/validation/README.md) |

## Dependencies and recommended order

```
01 KRN (exact B-rep, OCC default on desktop) ─┬─> 02 SRF ──> 06 CMP
                                              ├─> 07 FTR ──> 08 MAT (fasteners attach to holes)
                                              ├─> 03 GDT ──> 04 XCH (AP242 semantic PMI) ──> 09 PLM (LOTAR, FAI)
                                              └─> 05 FEA (needs exact faces for loads / BCs, midsurfaces)
08 MAT feeds 05 FEA (allowables) and 06 CMP (lamina properties).
```

1. **01 KRN** — everything else needs exact faces/edges, stable naming and B-rep STEP import.
2. **07 FTR + 08 MAT** — first sellable aerospace value: machined fittings and sheet-metal brackets with
   real holes, fasteners and materials (supplier / tier-2 / MRO work).
3. **03 GDT + 04 XCH** — MBD and AP242 make llull usable inside an OEM supply chain.
4. **09 PLM** — release discipline for AS9100 / EN 9100 suppliers.
5. **05 FEA, 02 SRF, 06 CMP** — engineering depth (analysis hand-off, aerodynamic surfaces, composites).

Each gap's `TECHNICAL_SPEC.md` § Delivery plan gives milestones and effort.

## What "validated" means here

A gap is done only when every `VC-*` case in its `validation/README.md` passes in an automated gate
(unit / golden / `npm run quality` / `npm run production` style), on the **desktop OCC kernel**, with the
reference data pinned in the validation folder (or pinned by URL + sha256 when the licence forbids
redistribution).
