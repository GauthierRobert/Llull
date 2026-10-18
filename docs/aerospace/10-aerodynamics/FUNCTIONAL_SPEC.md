# Gap 10 AER — Aerodynamics (aerospace and performance sport): functional specification

Status: written 2026-10-18 with the MVP implemented on the same branch (TECHNICAL_SPEC §13). Authoring rules:
[`../TEMPLATE.md`](../TEMPLATE.md). Operator model: [`../AGENT_FIRST.md`](../AGENT_FIRST.md).

## 1. Summary

llull models the shape of a wing, a fuselage, a bicycle frame or a rider, but cannot say how that shape behaves in
air. It has no atmosphere model, no airfoil or wing analysis, no drag estimate and no link between a CAD body and
its aerodynamic reference areas. Every aerodynamic number has to come from another tool and be re-typed. This is
the first thing an aircraft, drone, launcher or performance-sport designer asks after "what does it weigh":
"how much lift and drag, and how much power does it need?"

This gap adds an **engineering-level aerodynamics toolset**. It covers the standard atmosphere, 2D airfoils
(inviscid panel method and thin-airfoil theory), finite wings (Prandtl lifting line), drag from CdA or from the
frontal area measured on the model, flat-plate skin friction, and cycling power models validated against
published data.

These methods stay the **first pass**: they answer in milliseconds, and an agent uses them to size a design
before any flow simulation. The **flow field** (Mach and pressure maps, shocks, streamlines) is computed by the
local GPU solvers of [`12 CFD`](../12-cfd-gpu/FUNCTIONAL_SPEC.md) (decided 2026-10-18). This pack keeps three
links to it:

- CFD results feed the formula-level commands: a CdA or forces from a CFD case can drive `aero_drag` and
  `road_load_power` (FR-AER-14);
- the methods here cross-check CFD: panel / lifting-line with compressibility corrections against the Euler
  solver at the same Mach (FR-AER-15);
- a prepared CFD case can be exported to an external solver the user runs locally (OpenFOAM, SU2), and its forces
  and surface Cp imported back (FR-AER-13).

## 2. Aerospace and sport context

| Domain                                 | Typical question                                                                     | Tool used today                                                          | What llull adds                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Light aircraft / UAV conceptual design | wing area and aspect ratio for a stall speed; induced drag; tip loading with washout | XFLR5, OpenVSP VSPAERO, spreadsheets with Raymer / Anderson formulas     | the same lifting-line and panel results on the CAD section and planform, scriptable by an agent          |
| Launcher / sounding rocket             | air density, Mach and dynamic pressure along a trajectory (max-q)                    | US Standard Atmosphere tables, RASAero                                   | `standard_atmosphere` with Mach / q / Reynolds in one call                                               |
| Wind-tunnel and test preparation       | Reynolds number of a model, blockage area                                            | hand calculation                                                         | `standard_atmosphere`, `frontal_area` on the model                                                       |
| Road cycling / triathlon               | watts saved by a position or a helmet, speed at a given power on a climb             | Martin 1998 power model in spreadsheets, field "virtual elevation" tests | `road_load_power` `vehicle: bicycle` (Martin 1998) with CdA typed in or measured on a rider + bike model |
| Track hour record                      | power needed for a distance, effect of altitude                                      | Bassett et al. 1999 model                                                | `road_load_power` `model: bassett_1999`, reproducing the published table                                 |
| Automotive / wind loads                | drag force and power at speed                                                        | Cd × A from catalogues                                                   | `aero_drag` with the frontal area measured on the model                                                  |

## 3. Personas and user stories

- **Operator: an AI agent driving the `llull` CLI** (AF-01..05). "Give the drag and lift of this wing at 120 km/h
  and 1500 m." The agent finds the commands with `llull search aerodynamics`, runs one `build_project` plan
  (sketch section → analyse → planform → forces) and reads `data` (AF-10).
- **Owner: not an engineer** (a cyclist, a drone hobbyist, a small UAV company founder). They want an answer in
  watts or newtons and a sentence on how reliable it is. Every result names its model, its validity range and
  every defaulted input (AF-31, AF-35).
- **Qualified reviewer**: an aerodynamicist who signs off a wing load or a drag budget used for certification.
  These results never claim more than engineering-level accuracy. A summary that supports a certification
  decision must say "computed by llull, not approved" (AF-33). In the MVP none does: all commands are conceptual
  design tools, and the result `warnings` say what is not modelled.

User stories:

1. As an agent, I draw a NACA 2412 section at chord 1.2 m and get cl, cm and the zero-lift angle, so I can pick an
   incidence (FR-AER-03/04).
2. As an agent, I give span, root and tip chord and washout and get CL, CDi, span efficiency and the spanwise lift,
   so I can size a wing for a stall speed (FR-AER-05).
3. As a cyclist owner, I ask "how many watts do I save at 45 km/h if I go from the drops to a time-trial
   position?" and get two powers with the CdA used and their source (FR-AER-08).
4. As an agent, I measure the frontal area of a rider + bike assembly along the riding direction and turn it into a
   drag force with a stated Cd (FR-AER-06/07).
5. As a launcher engineer, I get density, Mach and dynamic pressure at 11 km for 600 m/s (FR-AER-01/02).

## 4. Scope

| Phase           | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MVP (built)** | US Standard Atmosphere 1976 to 86 km (+ ISA ΔT), flow quantities (Mach, q, EAS, Re); NACA 4-digit + 230-series 5-digit sections into the sketch; inviscid linear-vortex panel method (cl, cm, Cp) + thin-airfoil theory; Prandtl lifting line (trapezoidal / elliptical, linear twist) + Helmbold check; frontal / wetted area of solids along a flow direction; drag and power from CdA, Cd·A or the model, flat-plate skin friction (4 correlations); cycling power (Martin 1998 road, Bassett 1999 track) |
| V1              | Viscous section polars via an XFOIL hand-off (host transport like CalculiX, bundled binary, GPL) or a built-in integral boundary layer; drag build-up (form factors, interference) with sourced tables; vortex-lattice method for swept / multi-surface configurations; stability derivatives (neutral point, static margin); drafting / drafting-line positions in cycling from Blocken et al.                                                                                                              |
| V1 + 12 CFD     | CdA and forces read from a converged, non-stale 12 CFD case in `aero_drag` / `road_load_power` (FR-AER-14)                                                                                                                                                                                                                                                                                                                                                                                                   |
| V2              | Compressible corrections (Prandtl-Glauert / Kármán-Tsien), cross-checked against the 12 CFD Euler solver (FR-AER-15); propeller blade-element momentum theory; **external-solver export**: write the watertight surface, farfield box and boundary patches prepared by 12 CFD `cfd_prepare` as OpenFOAM or SU2 case files for a solver the user runs locally, and import its forces and surface Cp as 12 CFD result records (05 FEA result pattern)                                                                                                                    |
| Out of scope    | Flow-field solvers in this pack (they live in 12 CFD), aeroelasticity / flutter (physics PHY "not in this list"), certification load cases                                                                                                                                                                                                                                                                                                                                                                  |

## 5. Functional requirements

| Id        | Priority | Requirement                                                                                                                                                                                                                                       | Rationale                                                | Source                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| FR-AER-01 | MUST     | Air properties of the U.S. Standard Atmosphere 1976 (T, p, ρ, a, μ, ν, g) from −5 to 86 km, geometric or geopotential altitude, m / ft / km, with an ISA+ΔT option                                                                                | every aerodynamic and propulsion result needs ρ, μ, a, p | NASA-TM-X-74335 [R1]                           |
| FR-AER-02 | MUST     | Flow quantities for a speed: Mach, dynamic pressure, equivalent airspeed, Reynolds number per metre or for a reference length                                                                                                                     | sizing, test planning, max-q                             | [R1]                                           |
| FR-AER-03 | MUST     | Generate NACA 4-digit and 230-series sections as 2D sketch geometry (chord, incidence, open / closed TE) usable by extrude / loft                                                                                                                 | wings and blades start from a section                    | NACA Report 824 [R2]                           |
| FR-AER-04 | MUST     | Inviscid section analysis of a NACA designation or any closed sketch polyline: cl, cm about a chosen point, Cp distribution, lift slope and zero-lift angle; thin-airfoil zero-lift angle and cm c/4 for NACA camber lines                        | section choice, incidence, pitching moment               | Kuethe & Chow [R5], Abbott & von Doenhoff [R2] |
| FR-AER-05 | MUST     | Finite-wing analysis by lifting line: CL, CDi, span efficiency, lift slope, spanwise cl and loading for trapezoidal / elliptical planforms with linear twist; lift and induced drag in N with an air state                                        | wing sizing, induced drag, tip stall tendency            | Glauert [R6], Anderson [R7]                    |
| FR-AER-06 | MUST     | Frontal (projected) area of solids along any flow direction, overlaps counted once, plus wetted area and body length, with an uncertainty                                                                                                         | Cd reference area from the CAD model, not a guess        | —                                              |
| FR-AER-07 | MUST     | Drag force and power from CdA, Cd + area, or Cd + measured frontal area; optional flat-plate skin friction (Blasius, 1/7 power, Prandtl-Schlichting, ITTC-1957); Cd never defaulted                                                               | drag budgets, wind loads                                 | [R8], [R9]                                     |
| FR-AER-08 | MUST     | Cycling power ↔ speed: Martin et al. 1998 road model (aero incl. wheel rotation, rolling, bearings, gravity, drivetrain, wind, grade) and Bassett et al. 1999 track model (frontal area from height and mass, K1 factors, altitude density ratio) | the sports use case of this gap                          | [R10], [R11]                                   |
| FR-AER-09 | MUST     | Every result names its model, formulas and sources; every defaulted input is flagged (`defaulted: true`); warnings state what is not modelled (stall, viscosity, compressibility)                                                                 | AF-31, AF-35                                             | [AGENT_FIRST]                                  |
| FR-AER-10 | MUST     | Refusals carry stable `AER_*` codes with ids / paths and a one-line remediation                                                                                                                                                                   | AF-11                                                    | —                                              |
| FR-AER-11 | SHOULD   | Viscous polars (cd, cl_max) by XFOIL hand-off                                                                                                                                                                                                     | profile drag and stall                                   | V1                                             |
| FR-AER-12 | SHOULD   | Vortex-lattice method for swept wings, tails and canards; neutral point                                                                                                                                                                           | configuration studies                                    | V1                                             |
| FR-AER-13 | COULD    | Export a case prepared by 12 CFD (surface, farfield, patches, free stream) to OpenFOAM / SU2 case files, and import the external forces and surface Cp as 12 CFD result records; the built-in solvers are 12 CFD                                   | users who already run OpenFOAM / SU2 locally             | V2; [12 CFD](../12-cfd-gpu/FUNCTIONAL_SPEC.md) |
| FR-AER-14 | SHOULD   | `aero_drag` and `road_load_power` accept a 12 CFD case as the drag-area source (`cfdCaseId`); a stale or non-converged case is refused, and the case's provenance and `unverified` flags propagate into the result                                | measured-on-the-model CdA without retyping               | AF-32; after 12 CFD M2                         |
| FR-AER-15 | SHOULD   | Compressibility corrections (Prandtl-Glauert, Kármán-Tsien) on panel and lifting-line results, cross-checked against the 12 CFD Euler solver on the same section / wing at Mach 0.3–0.7                                                          | one model, two methods that must agree                   | Anderson [R7]; V2                              |

## 6. Workflows

CLI first (`llull-cli` skill). Typical plan:

```json
[
  { "command": "draw_naca_airfoil", "params": { "naca": "2412", "chord": 1000 }, "as": "section" },
  { "command": "analyze_airfoil", "params": { "entityId": "$section", "alphasDeg": [0, 4] } },
  { "command": "extrude_profile", "params": { "id": "$section", "depth": 2000 }, "as": "panel" },
  {
    "command": "analyze_wing",
    "params": { "span": 10, "rootChord": 1, "naca": "2412", "alphasDeg": [0, 4], "speed": 50, "altitudeM": 1500 }
  }
]
```

Cycling: `llull road_load_power '{"vehicle":"bicycle","massKg":80,"cdA":0.243,"speed":45,"speedUnit":"km/h"}' --json`.
A car: `llull road_load_power '{"massKg":1500,"cdA":0.65,"crr":0.01,"speed":120,"speedUnit":"km/h"}' --json`.
MCP: the `aerodynamics` toolset (`enable_toolset aerodynamics`), until MCP is removed (owner directive 2026-10-18;
the CLI is the agent surface). UI: the commands appear in the command palette under "Aerodynamics". A plot surface
for Cp and span loading is a V1 item.

From estimate to flow field (FR-AER-14, with 12 CFD):

```bash
llull road_load_power '{"vehicle":"bicycle","massKg":80,"cdA":0.243,"speed":45,"speedUnit":"km/h"}' --json   # first pass, published CdA
llull cfd_solve caseId=rider --file model.llull                                                                # 12 CFD, low-speed solver on the rider + bike model
llull road_load_power '{"vehicle":"bicycle","massKg":80,"cfdCaseId":"rider","speed":45,"speedUnit":"km/h"}' --json   # same model, CdA from the flow solution
```

## 7. Acceptance criteria

| Given                                                   | When                                   | Then                                                                                        | VC           |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- | ------------ |
| the PDAS USSA76 table, −2..86 km by 2 km                | `standard_atmosphere` at each altitude | T within 0.006 K, p / ρ / a / μ within 1e-4 relative                                        | VC-AER-01    |
| a box 1000 × 600 × 400 mm and a sphere r 0.5 m          | `frontal_area`                         | 0.24 m² within the uncertainty; πr² within the tessellation bound (−1.5 %..+0.1 %)          | VC-AER-02/03 |
| D = ½ρV²CdA and the four skin-friction correlations     | `aero_drag`                            | exact to 1e-6; Cf within 5e-4 of the check values                                           | VC-AER-04/05 |
| three Joukowski airfoils with exact potential-flow lift | `analyze_airfoil` on the polyline      | cl within 1 % (300 panels / side)                                                           | VC-AER-10    |
| NACA 2412                                               | `analyze_airfoil`                      | thin-airfoil α_L0 = −2.077°; panel α_L0 within 0.4° of the measured −2°                     | VC-AER-11    |
| NACA 0012                                               | `analyze_airfoil`                      | inviscid lift slope 5–15 % above McCroskey's 0.1063 /deg (the documented viscous reduction) | VC-AER-12    |
| an elliptical wing                                      | `analyze_wing`                         | e = 1, CL_α = a0/(1 + a0/πAR), CDi = CL²/πAR within 1e-6                                    | VC-AER-13    |
| the 13 rows of Bassett et al. 1999 Table 7              | `road_load_power bassett_1999`         | power within 2 W of the published value (Boardman 1996: the paper's model value 452 W)      | VC-AER-20    |
| Martin 1998 terms                                       | `road_load_power` bicycle              | each term equals its closed form; speed ↔ power round trip                                  | VC-AER-21/22 |
| a converged 12 CFD case with CdA 0.25 m², and the same case after a geometry edit | `aero_drag` with `cfdCaseId` | drag equals ½ρV²·0.25 (1e-6); the stale case is refused `AER_CFD_RESULT_UNUSABLE` | VC-AER-30 (planned) |
| NACA 0012 at Mach 0.5, α 2°                             | panel + Prandtl-Glauert vs 12 CFD Euler | cl agree within 5 % (both inviscid)                                                         | VC-AER-31 (planned) |
| a case prepared by `cfd_prepare`                        | OpenFOAM export                        | patch names and farfield box equal the 12 CFD case; re-import of a known result round-trips  | VC-AER-32 (planned) |

## 8. Standards and regulatory alignment

- U.S. Standard Atmosphere 1976 (identical to ICAO Doc 7488 / ISO 2533 up to 32 km) [R1].
- NACA airfoil definitions, NACA Report 824 [R2].
- No certification standard is claimed: CS-23 / 14 CFR 23 load and performance substantiation require validated
  methods and test data. Results are conceptual-design estimates (AF-33).
- Cycling: UCI rules on positions and equipment are outside the tool; the models are those of the cited papers.

## 9. KPIs

- 100 % of VCs automated (unit tests + `docs/…/validation/plans` scenarios run by `tests/unit/aero/scenarioPlans.test.ts`).
- An agent produces a wing estimate (section + planform + forces) in ≤ 4 commands, a cycling power answer in 1.
- No result without its model, sources and defaulted-input flags.

## 10. Risks and assumptions

- **Inviscid lift is optimistic.** Panel and lifting-line results have no drag, no stall and no Reynolds effect;
  real sections reach about 85–95 % of the inviscid lift slope (NACA 0012: 0.106 /deg measured vs 0.1195 /deg
  inviscid here, cl 1.195 vs 1.06 at 10°). This is stated in every result.
- **Frontal area from the display mesh.** Curved surfaces read slightly low (32-segment circle: 99.4 %).
- **CdA values for riders are inputs, not predictions.** The tool does not predict a cyclist's Cd. Published values
  [R12] are documented as examples, and the measured frontal area needs a Cd from tests.
- **Bassett model scope.** Velodrome, no wind, ±4 % on power (the paper's own estimate).
- **Network-limited sourcing.** Several primary PDFs (NASA NTRS, journals) could not be fetched from the authoring
  sandbox; values used as gates come from a primary source read directly (Bassett 1999) or from two or more
  concordant sources (see `validation/sources.md`).

## 11. References

- [R1] U.S. Standard Atmosphere, 1976 — NOAA / NASA / USAF, NASA-TM-X-74335 — https://ntrs.nasa.gov/citations/19770009539 (accessed 2026-10); tabulated by PDAS "Atmosphere to 86 km by 2 km" — https://www.pdas.com/atmosdownload.html.
- [R2] Abbott, von Doenhoff, Stivers, Summary of Airfoil Data — NACA Report 824, 1945 — https://ntrs.nasa.gov/citations/19930090976.
- [R3] Ladson C. L., Effects of independent variation of Mach and Reynolds numbers on the low-speed aerodynamic characteristics of the NACA 0012 airfoil section — NASA TM-4074, 1988 — https://ntrs.nasa.gov/citations/19880019495.
- [R4] McCroskey W. J., A critical assessment of wind tunnel results for the NACA 0012 airfoil — NASA TM-100019, 1987 — https://ntrs.nasa.gov/citations/19880002254.
- [R5] Kuethe A. M., Chow C.-Y., Foundations of Aerodynamics, 5th ed., Wiley 1998, §5.10 (linear vortex panel method; book, formulation public in many course notes).
- [R6] Glauert H., The Elements of Aerofoil and Airscrew Theory, Cambridge University Press 1926, ch. XI.
- [R7] Anderson J. D., Fundamentals of Aerodynamics, McGraw-Hill, §4.8 (thin airfoil), §5.3 (lifting line).
- [R8] NASA Glenn Research Center, Beginner's Guide to Aeronautics, "Shape Effects on Drag" — https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/shape-effects-on-drag/.
- [R9] Schlichting H., Gersten K., Boundary-Layer Theory (Blasius, Prandtl-Schlichting); ITTC 1957 correlation line (Proc. 8th ITTC).
- [R10] Martin J. C., Milliken D. L., Cobb J. E., McFadden K. L., Coggan A. R., Validation of a mathematical model for road cycling power — J. Appl. Biomech. 14(3):276-291, 1998 — doi:10.1123/jab.14.3.276.
- [R11] Bassett D. R. Jr, Kyle C. R., Passfield L., Broker J. P., Burke E. R., Comparing cycling world hour records, 1967-1996: modeling with empirical data — Med. Sci. Sports Exerc. 31(11):1665-1676, 1999.
- [R12] Defraeye T., Blocken B., Koninckx E., Hespel P., Carmeliet J., Aerodynamic study of different cyclist positions: CFD analysis and full-scale wind-tunnel tests — J. Biomech. 43:1262-1268, 2010 — doi:10.1016/j.jbiomech.2010.01.025.
- [R13] Blocken B. et al., CFD simulations of the aerodynamic drag of two drafting cyclists — Computers & Fluids 71:435-445, 2013; Aerodynamic drag in cycling pelotons — J. Wind Eng. Ind. Aerodyn. 179:319-337, 2018.
