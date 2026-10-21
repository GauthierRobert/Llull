# HALO v3: test-readiness package

v3 (`halo_v3.lld`) is the **first physical test article**. It comes out of a full engineering pass over v2:
- a sizing audit
- a design sweep
- CalculiX FEA
- 13 design checks

The audit found two blocking defects in v2, and v3 fixes both. Everything below comes with its source.
- **llull** = computed by a llull command on the model.
- **est.** = first-order theory in `analysis/halo_sizing.py`, with its assumptions listed in that file.
- **measure** = must come from the test itself.

Nothing here is approved for flight. A qualified engineer must review the analysis, and the flight tests must follow
your national aviation authority's rules. At 1.28 kg, HALO is above the 900 g threshold that many regulators use, so
check registration, operator ID and the category that applies to the test site.

## 1. What changed from v2 (audit → fix)

| v2 finding (`analysis/sizing_v2.json`) | Severity | v3 fix | v3 result |
| --- | --- | --- | --- |
| Pitch/roll authority 0.048 N·m (4 × 16 mm flaps in a q ≈ 39 Pa jet): **crosswind limit 0 m/s** | blocking | 8 struts, each with an 80 mm hinged flap, mixed on all 8; flap chord picked by the llull sweep (`analysis/sweep_results.json`) | 0.485 N·m, **26.7 rad/s²** in still air, crosswind limit **≈ 3.9 m/s** (est.) |
| Hub motors modelled at 49 g against ~68–78 g needed for 0.54–0.63 N·m peak | blocking | 22 mm stator stack, 2 mm 7075 bell: ~80 g per motor | spec in `test_article/bom_v3.csv` (HALO-E-001) |
| The loop root meets the bell only along its trailing-edge strip (TE is the innermost point) | structural | 7075 root socket per loop that captures the root section out to r = 39.5 | FEA MS +0.89 at proof spin |
| Upper rotor 0.5 mm proud of the duct inlet once the stack is re-spaced | geometry | duct chord 170 → 172 mm + new check line 217 (rotor inside the duct) | check passes |
| Static margin drifts with the new vane mass | stability | battery layer 2 at z = 226 | **+7.0 %** (llull VLM, 720 panels, `analysis/vlm_v3.json`) |
| Mass rises with the fixes | — | real layups: flaps Rohacell 31 + 1 ply (0.12 g/cm³), ring skin 3 × 75 µm thin-ply | 1215 g modelled (llull BOM), **≈ 1275 g** flight-test mass with a +60 g harness / fastener budget |

Things the sweep showed that are worth knowing:
- Shortening the duct to 150 mm puts the rotor outside it.
- Each extra 15 mm of flap chord buys about 0.8 m/s of crosswind margin for about 1.5 min of endurance.
- The limits are fundamental: HALO's low disc loading (≈ 107 N/m²) is what makes it quiet and efficient, and it is also
  why the control jet is weak. Operating in strong wind (> 5 m/s) needs a higher-disc-loading or cyclic-control v4.

## 2. Test article definition

| Quantity | Value | Source |
| --- | --- | --- |
| Envelope | Ø 440 mm × 447 mm (legs to dome) | llull |
| Mass | 1215 g modelled, 1275 g with harness / fasteners | llull BOM, +60 g budget |
| CG | on the axis, z = 134.8 mm (47.2 mm aft of the ring LE in cruise) | llull mass_properties |
| Inertia at the CG | Ixx = Iyy = 0.0182, Izz = 0.0131 kg·m² (flight mass) | llull, scaled |
| Static margin (cruise) | +7.0 % | llull VLM |
| Battery | 8 × Molicel P50B 21700, 4S2P, 14.4 V, 144 Wh | BOM |
| Hover | 12.5 N thrust, ≈ 111 W electrical, 7.7 A, **≈ 66 min** | est. |
| Rotors (hover / peak) | upper 1365 / 1931 rpm, 0.31 / 0.62 N·m; lower 1182 / 1672 rpm, 0.36 / 0.72 N·m | est. |
| Peak current | 21.8 A pack, 10.9 A per cell (P50B: 60 A) | est. |
| Cruise | 25 m/s, L/D ≈ 6.9, ≈ 82 W | est. + llull drag build-up |

Files:
- `halo_v3.lld` (design + 13 checks) and `halo_v3.llull.json`
- `test_article/halo_v3.step` (AP242, exact OCC B-rep)
- `test_article/drawings/` (GA + 7 part drawings, SVG + PNG)
- `test_article/bom_v3.csv` (make / buy, process, requirement per line)
- `test_article/ply_book_pod_barrel/` + `pod_barrel_flat_patterns.dxf`
- `production/foot_tpu95a.3mf` (foot pattern)

## 3. Analysis results (all in `analysis/`)

| Check | Result | Margin / gate | Source |
| --- | --- | --- | --- |
| Rotor loop, proof spin 2320 rpm (1.2 × peak at flight mass), with thrust and drag | 29.6 MPa (homogenised sandwich, E_eq 21 GPa → ≈ 1400 µε skin strain against a 4000 µε allowable) | **MS +0.89** after ×1.5 | CalculiX C3D10, 56k nodes, `fea_rotor_loop.lld` |
| Rotor loop radial tip growth at proof spin | 0.105 mm | 3 mm tip gap | same |
| Rotor loop first mode (root clamped, no spin stiffening) | 74.1 Hz | 2P at peak rpm = 64.4 Hz → 13 % separation; **watch item** | same, modal |
| Vane strut, 5 g hard landing (pod inertia on 8 struts), cantilever | 18.5 MPa | **MS +2.6** | `fea_strut.lld` |
| Vane strut first mode, as built (hub + rib) | 399 Hz | ≫ blade-pass 68–111 Hz (3 / 4 loops, hover to peak) | same, modal |
| Assembly: overlaps, floating parts, intended joints | pass (mesh and exact OCC kernel) | all joints declared | llull check_assembly |
| Clearance (all parts) | ≥ 0.35 mm; tightest are 0.4 mm between cells and the 0.5 mm motor air gap | pass | llull check_assembly |
| Rotor tips to the duct throat | 3.0 mm | ≥ 2.5 mm | check lines 211-212 |
| Rotor stack / struts / inlet | upper ≥ 121 > lower ≤ 86; lower ≥ 27.5 > struts 22; upper ≤ inlet | pass | check lines 213-217 |
| Pod barrel laminate | symmetric, balanced, 0/±45/90 families, ±45 outer: pass; 42.9 g | — | `pod_barrel_layup.lld` |
| Pitch authority / crosswind limit | 0.485 N·m; 26.7 rad/s²; ≈ 3.9 m/s | est. (lip-moment coefficient k = 0.5 assumed) | `sizing_v3_flight_mass.json` |

Not analysed; the tests have to close these gaps:
- no CFD of the duct (the lip thrust share and the crosswind moment are theory)
- no acoustics
- no ring-shell FEA under the landing load paths
- no fatigue
- no thermal analysis of the motors

## 4. Risks, ranked

1. **Crosswind (est. limit ≈ 3.9 m/s).** The crosswind moment coefficient is empirical (0.3–0.7 in the literature). The envelope stays ≤ 2 m/s until phase P4 has measured the flap moments and P6 the real wind response.
2. **Hover-to-cruise transition** (classic tail-sitter risk: the flaps lose the jet when the attitude is between hover and
   cruise). Transition only at ≥ 30 m height, in stages (30°, 60°, 90°), with an auto-recovery to hover.
3. **Rotor-loop resonance.**
   - 2P is 64 Hz at peak rpm against f1 = 74 Hz. The spin test sweeps slowly through the band and measures it.
   - Each loop passes the 8 struts every revolution. That 8P excitation crosses f1 (74 Hz) at about 560 rpm and f2
     (145 Hz) at about 1090 rpm during spin-up. Never dwell at those speeds.
   - In hover (8P = 182 Hz) and at peak (8P = 257 Hz), 8P sits between f2 and f3 (351 Hz).
4. **Custom hub motors:** a frameless 36N42P with a ≥ 60 mm bore. Start-up of high-pole-count motors on FOC ESCs has to
   be bench-checked before the motors go into the airframe.
5. **Yaw trim:** the lower rotor needs ≈ 15 % more torque than the upper at equal thrust. Yaw is trimmed with the
   rotor-speed split; check the yaw authority on the stand.
6. **Ring bonding and vents:** check vent continuity (air flow) and the LE/TE bond lines (tap test) before the first spin-up inside the ring.

## 5. Flight-control setup

- **Outputs:** 2 motors (upper, lower) + 8 flap servos, k = 0..7 at strut angle θ_k = k · 45°.
- **Pitch and roll:** a flap on strut θ makes a moment about the strut's own radial axis, so the mixer is
  `δ_k = sat_20°( u_roll · cos θ_k + u_pitch · sin θ_k + u_yaw,vanes )`. Under saturation-optimal allocation the
  authority per axis is Σ|cos θ_k| = 4.83 flaps.
- **Yaw (hover)** primarily comes from the differential torque of the two rotors: `ω_up = ω₀ (1 + u_yaw)`,
  `ω_low = ω₀ (1 − u_yaw)`. All 8 flaps deflected together add a vane-cascade swirl as a secondary yaw input.
- **Thrust:** common rotor speed.
- **Starting gains:** size them from Ixx = Iyy = 0.018, Izz = 0.013 kg·m². Expected control power is
  ≈ 26 rad/s² (pitch/roll at full flap) and ≈ 7.6 rad/s² of yaw from a 0.1 N·m torque split (est.). Identify the
  plant on the tether (P5) before free flight.
- **Fail-safes:**
  - a hardware kill switch that cuts the ESCs
  - geofence
  - low-battery land at 30 % (Li-ion sag)
  - motor-temperature limit
  - loss of link → hover, then land

## 6. Test plan (staged; each phase needs the previous one passed)

| Phase | Test | Set-up | Pass criteria | Predicted |
| --- | --- | --- | --- | --- |
| **P0** | Mass properties | scale; hang test for the CG; bifilar pendulum for Iyy | every part within ±10 % of the BOM; total ≤ 1.30 kg; CG z = 134.8 ± 3 mm; Iyy within ±20 % | 1275 g, z 134.8, 0.018 |
| **P1a** | Strut proof load | each strut clamped at the rib end, 6.6 N (1.25 × limit) at the root for 30 s | no cracking (tap test), root deflection ≤ 0.8 mm, recovers fully | 0.48 mm at the 5.3 N limit (FEA) |
| **P1b** | Drop test | complete airframe with a dummy battery, flat drop from 0.15 m onto concrete (≈ 1.7 m/s) | no damage; legs and struts intact | 5 g design case |
| **P2** | Rotor spin test, each rotor alone | spin rig with a containment ring and accelerometer; balance to G2.5 first | ramp 0 → 2320 rpm at ≤ 100 rpm/s, hold 60 s; no crack, debond or contact; radial tip growth < 0.5 mm; identify the loop mode in the 60–90 Hz band | f1 ≥ 74 Hz (higher with spin), growth 0.1 mm |
| **P3** | Thrust stand, full duct | vehicle clamped on a 6-axis load cell (vanes neutral); rpm, V, I, torque logged | at 12.5 N total thrust, electrical power ≤ 128 W (+15 %); measured FM ≥ 0.5; torque balance found (yaw trim map); motor temperature < 80 °C after 5 min | 111 W; split ≈ 1.16 |
| **P4** | Control authority on the stand | at hover thrust, flaps stepped −20 → +20° | pitch/roll moment ≥ 0.40 N·m at ±20°; linear to ±12°; servo step response < 0.1 s | 0.485 N·m |
| **P5** | Tethered hover (indoor, net, 2 m tether) | autopilot attitude mode | attitude hold ±3° rms; flap use < 50 % at hover; power within 15 % of P3; plant identification logged | — |
| **P6** | Free hover | indoor first, then outdoor in wind ≤ 2 m/s, then ≤ 3 m/s | position hold ±0.5 m; flap saturation < 70 % in any 1 s window; no oscillation | crosswind limit ≈ 3.9 m/s |
| **P7** | Hover endurance | 20 min hover, logged energy | extrapolated endurance ≥ 45 min at 20 % reserve | ≈ 66 min (est.) |
| **P8** | Transition | outdoor, ≥ 30 m height, wind ≤ 2 m/s; staged pitch 30°, 60°, 90° and back | each stage stable for ≥ 5 s; recovery to hover < 3 s; height loss < 5 m | — |
| **P9** | Cruise | speed sweep 15–25 m/s, steady points | power vs speed within 20 % of the estimate; trim flap < 10° | 82 W at 25 m/s |

**Abort criteria in every phase:**
- vibration > 2 g rms on the pod IMU
- a motor or ESC > 90 °C
- any noise or contact from the rotor
- flap saturation for > 1 s
- link loss

**Safety:**
- Spin and stand tests behind a polycarbonate shield.
- Li-ion: charge in a fire-safe container; cells from one lot, matched; storage at 3.7 V.
- Kill switch within reach of the safety officer.
- Clear area: hover tests ≥ 15 m from people; flight tests per the test-site rules.

## 7. llull notes from this pass

- `fea_mesh` ignores `target.intersectPlane` on a face target. A clamp meant for one curve fixed the whole face, and the
  first loop result came out 100× too stiff. Worked around by modelling the root socket as geometry (see
  `fea_rotor_loop.lld`). Worth fixing in `server/src/fea`.
- Native OCC kernel: subtracting a fully enclosed cavity gives a voided solid whose volume reads as the outer volume
  (v2's ring read 4.8 kg). The ring cavity is vented, as a real hollow composite part must be anyway, and the TE
  close-out avoids near-tangent surfaces.
- The 47-part pairwise `check_assembly` is slow on the OCC kernel. With `LLULL_OCC_TIMEOUT_MS=900000`, v3 passes
  **all 13 design checks on the exact kernel too**, in ≈ 25 min:
  - the exact BOM is 1215.4 g (mesh kernel: 1214.9 g)
  - `test_article/halo_v3.step` is AP242, 16 products, mm, 0 issues (`verify_exchange_file`)
