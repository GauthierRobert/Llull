# Aerospace starter — pylon fitting design study

The "Aerospace pod" starter (`src/ui/actions/aerospace{Geometry,Plan}.ts`) mounts a 16x8 propeller and outrunner motor under a wing
stub on a machined 7075-T6 pylon fitting bolted through a doubler. The first version of the fitting was a solid 48 mm wide
extrusion: 802 g of fitting plus a 215 g doubler for a 60 N thrust, with a minimum margin of safety of 666. This study sizes it
against stated requirements with llull's own loop (Gmsh mesh, CalculiX solve, `compute_margins`, thermal solve,
`check_temperature_limits`, `check_machining`, `mass_properties`), and records the decision. The result is `STARTER_FITTING`.

All results are computed by llull and **not approved**: the 7075-T6 values are typical-basis (MatWeb), so every margin is
flagged unverified, and a qualified engineer must review the model, loads and results.

## Loads (static case, N-mm-t-s)

| Case             | Category | Content                                                                                                                                                                                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LC1_thrust_10g   | limit    | 60 N thrust (1.35 x the 44.6 N static thrust simulated by MuJoCo at 6,613 rpm), 10 g down on the 0.65 kg motor + rotor (64 N), motor torque reaction 2.1 N·m stall x 1.25 = 2.63 N·m as tangential 26.25 N forces on the four tapped screw holes |
| LC2_emergency_9g | ultimate | 9 g forward on the motor mass (58 N)                                                                                                                                                                                                             |
| LC3_stiffness    | (probe)  | 100 N down on the motor face, for the stiffness estimate                                                                                                                                                                                         |

Factors: ultimate 1.5, yield 1.0, fitting factor 1.15 (14 CFR 25.625(a)). Fixed support on the flange top (bonded and bolted to
the doubler). Thermal: 2,500 W/m² motor heat into the motor face (about 14 W of the 1.1 kW loss), 45 °C wing sink on the flange, slipstream
convection h = 30 W/(m²·K) at 40 °C.

The torque reaction was first modelled as two point forces on the motor face. That produced a singular peak right under the
point (MS 63) that is a modelling artefact, so it is applied through the screw holes, as the screws carry it in reality.

## Requirements

| Id  | Rule                                                                                    | Source                                         |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| R1  | MS >= 0.25 on every ultimate and yield row                                              | company margin policy (sample)                 |
| R2  | Motor-face deflection under LC1 <= 50 µm                                                | alignment / tip clearance (owner rule, sample) |
| R3  | Every machined member and the doubler >= 3 mm                                           | DFM minimum gauge (company rule, sample)       |
| R4  | Motor web >= 6 mm (1.5 D thread engagement of M4 in aluminium)                          | common design guideline                        |
| R5  | Bolt edge distance >= 2 D (NAS6203-3: 9.5 mm); screw edge distance >= D (4 mm)          | AC 43.13-1B 4-57(c) practice                   |
| R6  | Tmax <= 90 °C (120 °C 7075-T6 over-ageing limit with a 30 K band)                       | company rule (sample)                          |
| R7  | First mode above 1.25 x two-per-rev at no-load speed (2 x 9,500 rpm = 317 Hz -> 396 Hz) | vibration rule (sample)                        |

R7 cannot be checked directly: llull refuses modal cases. It is estimated as a lumped mass on the measured vertical stiffness,
f ≈ (1/2π)·√(k/m), with k = 100 N / u_z(LC3) and m = 0.65 kg. That ignores the motor's rotary inertia about the web, so it is optimistic.
A modal analysis remains an open item before release.

## Candidates

Flange, web and strut are the as-machined thicknesses: the truss pocket shares their faces. B0 reproduces the first version's
proportions under the new loads. C5 and C6 change the topology: a 20 mm wide truss (enough for 2 D edge distance on the
centreline bolts) unioned to a 52 mm wide, 6 mm motor-web plate that carries the Ø50 screw circle.

| Design | Truss / web plate width | Flange / web / strut / doubler | Fitting   | Doubler   | Min MS (where)          | LC1 deflection | f1 estimate  | Tmax        |
| ------ | ----------------------- | ------------------------------ | --------- | --------- | ----------------------- | -------------- | ------------ | ----------- |
| B0     | 48 / 48                 | 14 / 14 / 8 / 6                | 929 g     | 215 g     | 160 (web, screw circle) | 0.7 µm         | ~5.7 kHz     | 49.4 °C     |
| C1     | 48 / 48                 | 10 / 10 / 6 / 5                | 685 g     | 179 g     | 118 (screw hole)        | 1.3 µm         | ~5.0 kHz     | 51.4 °C     |
| C2     | 48 / 48                 | 6 / 8 / 4 / 4                  | 456 g     | 143 g     | 115                     | 2.2 µm         | ~4.5 kHz     | 53.8 °C     |
| C3     | 48 / 48                 | 4 / 6 / 3 / 3                  | 327 g     | 107 g     | 88 (screw hole)         | 4.6 µm         | ~3.9 kHz     | 57.1 °C     |
| C5     | 20 / 52                 | 4 / 6 / 3 / 3                  | 189 g     | 107 g     | 82 (screw hole)         | 5.0 µm         | ~3.9 kHz     | 59.8 °C     |
| **C6** | **20 / 52**             | **5 / 6 / 4 / 3**              | **217 g** | **107 g** | **83 (screw hole)**     | **4.6 µm**     | **~4.0 kHz** | **59.2 °C** |

Every candidate meets R1, R2, R6 and R7 by a wide margin; C3, C5 and C6 sit on the R3/R4 gauges. Strength, stiffness and heat do
not size this part at these loads: the manufacturing rules (minimum gauge, thread engagement, edge distances) and the topology do.

## Decision: C6

C6 is the starter's fitting: **217 g instead of 802 g (−73 %), and the fitting plus doubler weigh 324 g instead of 1,017 g (−68 %)**.
C5 is 28 g lighter, but C6 keeps a 4 mm strut and a 5 mm flange. That more than doubles the strut's in-plane Euler buckling load (π²EI/L²,
about 1.9 kN against 0.8 kN for C5) and gives margin for handling damage on a part that hangs below the wing, where a 3 mm strut
200 mm long is easy to bend. The bolt grip changes from NAS6203-9 to NAS6203-6.

### Mesh convergence (C6, LC1)

| Global size  | C3D10 elements | Motor-face deflection | Peak von Mises |
| ------------ | -------------- | --------------------- | -------------- |
| 4 mm (study) | 8,491          | 4.585 µm              | 3.95 MPa       |
| 2.8 mm       | 20,904         | 4.508 µm              | 4.11 MPa       |
| 2 mm         | 52,586         | 4.515 µm              | 5.19 MPa       |

`check_convergence` reports the deflection as oscillatory, inside a 1.7 % band, so it is converged to noise. It reports the peak
stress as divergent: the peak sits on the edge of a tapped hole where the torque enters, a concentration that grows with refinement.
The hand check is about 31 N per screw over 3.3 x 6 mm of engagement, roughly 1.6 MPa of bearing. Even taking the finest-grid FE peak, the
margin is MS = 572 / (5.19 x 1.5 x 1.15) − 1 ≈ 63.

## Open items

- Modal analysis of the motor on the fitting (llull does not build modal cases yet); the f1 figures above are lumped estimates.
- Replace the typical-basis 7075-T6 values with A/B-basis allowables (MMPDS or a company library). Every margin stays unverified until then.
- Fatigue under propeller 1P/2P excitation. At about 4 MPa peak against a 7075-T6 endurance limit of the order of 150 MPa it is not
  expected to govern, but it is not computed.
- The 160 x 80 x 3 mm doubler is sized by the 60 mm wide skin cutout it bridges, not by load. A smaller cutout would allow a smaller doubler.
