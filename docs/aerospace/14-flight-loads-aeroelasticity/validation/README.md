# Gap 14 FLL — Validation pack

Same rules as 13 FLT. Closed-form cases use stated inputs; derived values computed with a Node.js script (2026-11-02),
not by llull. Material inputs in closed-form cases are **test inputs**, not material data claims.

## Real use cases

| #   | Use case                                                                        | VC            |
| --- | ------------------------------------------------------------------------------- | ------------- |
| U1  | Strut socket / body margins at the gust peak of 13 FLT                          | VC-FLL-01, 02 |
| U2  | Is an arm or camera mount resonating with the rotors between hover and max rpm? | VC-FLL-04     |
| U3  | 0.5 m drop of the 1.115 kg drone                                                | VC-FLL-05     |
| U4  | Printed PETG body: stiffness and strength with 2 walls + lightning infill       | VC-FLL-06     |
| U5  | Mesh the implicit one-piece body (failed today)                                 | VC-FLL-09     |

## Cases

| Id        | Proves                          | Inputs                                                                                    | Expected                                                                                                                                      | Tol                             | Derivation                     | Grade                        |
| --------- | ------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------ | ---------------------------- |
| VC-FLL-01 | FR-FLL-01 thrust load on an arm | cantilever b 10 mm, h 8 mm, L 150 mm, E 2 GPa, tip force 5.4 N                            | δ = FL³/(3EI) = 7.1191 mm; σ_root = FLc/I = 7.5938 MPa                                                                                        | 2 % (quadratic tets, converged) | Euler–Bernoulli                | A                            |
| VC-FLL-02 | FR-FLL-01, 02 inertial relief   | free solid, uniform acceleration a = [0, 0, 2g] + 3-2-1 support                           | support reactions < 1e-6 · m·a                                                                                                                | as stated                       | d'Alembert equilibrium         | A                            |
| VC-FLL-03 | FR-FLL-07 centrifugal           | uniform bar rotating about one end, ρ 1270 kg/m³, L 0.127 m, 8000 rpm                     | σ_root = ρω²L²/2 = 7.1882 MPa                                                                                                                 | 2 %                             | closed form                    | A                            |
| VC-FLL-04 | FR-FLL-03 resonance             | bar of VC-FLL-01, ρ 1270 kg/m³                                                            | f₁ = (1.8751²/2π)√(EI/(m'L⁴)) = 72.078 Hz; 2P crossing 2162.3 rpm (2-blade), 1P 4324.7 rpm                                                    | 1 %                             | Euler–Bernoulli cantilever     | A                            |
| VC-FLL-05 | FR-FLL-06 drop                  | h 0.5 m, m 1.115 kg on a linear spring k 2e4 N/m (gear idealisation)                      | v₀ = √(2gh) = 3.1316 m/s; peak spring force = mg + √((mg)² + 2mghk) = 478.703 N                                                               | 2 % (explicit, converged)       | energy balance                 | A                            |
| VC-FLL-06 | FR-FLL-04 printed idealisation  | PETG coupons per [R1]: UTS XY 19.27, XZ 14.30, YZ 16.48 MPa (25 % infill, 0.2 mm, 230 °C) | idealisation reproduces the orientation ratio of the coupon inputs it is given; absolute allowables TBD — measure with the owner's coupons    | —                               | input propagation              | B (context) / C (allowables) |
| VC-FLL-07 | FR-FLL-11 divergence            | typical section `Kα` 0.5 N·m/rad, e 5 mm, S 0.0136 m², `CLα` 2π, ρ 1.225                  | `qD = Kα/(e·S·CLα)` = 1170.26 Pa; `VD` = 43.711 m/s                                                                                           | 1 %                             | typical-section aeroelasticity | A                            |
| VC-FLL-08 | FR-FLL-09 pressure mapping      | any mapped field                                                                          | ΣF and ΣM of mapped pressures equal the source within 0.5 %                                                                                   | 0.5 %                           | conservation                   | A                            |
| VC-FLL-09 | FR-FLL-05 implicit tets         | reference body field (lite8.lld, f_body) at 2 mm                                          | valid tet mesh; volume within 0.5 % of the implicit body volume (686 657 mm³ at voxel 0.8, decimated reference); min dihedral above the bound | as stated                       | geometric                      | A (geometry)                 |

## Files

`expected_results.json` (index); `plans/` (FLL-M1):

- `fll_m1_field_cantilever.plan.json`: the VC-FLL-01 cantilever as an implicit field box meshed from its field (`source=implicit_field`,
  2 mm, C3D10) and solved by CalculiX: tip deflection **7.1022 mm** vs FL³/(3EI) = 7.1191 mm (−0.24 %, tolerance 2 %) on 2026-11-08. This
  checks the field mesh against an analytic stiffness only; VC-FLL-01 itself (export_flight_loads) is FLL-M2.
- `fll_m1_drone_standin.plan.json`: VC-FLL-09 on a **stand-in** of the reference body (lite8.lld is not in the repository): 250 × 250 × 44 mm
  blended hub, arms, 20 mm motor pads and battery pocket, body at voxel 0.8, meshed at 2 mm: 889 868 C3D10 in 28 s, volume 569 003 mm³ vs
  the implicit body 568 843 mm³ (+0.028 %, tolerance 0.5 %), dihedral 20.1°-143.1°; the support and load face sets stay on their pad faces
  (nodes within h of z = ∓10 and r ≤ 16 + h) with areas 802.4 and 795.6 mm² vs π 16² = 804.2 mm² (2026-11-08, review round 1). **The
  reference body itself stays open** until lite8.lld is added (expected 686 657 mm³).

Run by `server/tests/feaFieldMesh.test.ts` (real llull-compute and CalculiX); analytic-field checks (sphere C3D10 −0.0012 %, box exact,
determinism over thread counts) in `solver/crates/llull-field/src/tets_tests.rs`.
