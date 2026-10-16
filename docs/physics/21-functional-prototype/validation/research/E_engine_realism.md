# Research E: engine realism (losses, combustion, inertia, gearbox, validation data, accuracy targets)

Date of research: 2026-10-16. Every claim is tagged [Rn]. Each Rn is a URL that was actually fetched during this research (see the
reference list at the end). Values marked **UNCONFIRMED** were not found in a fetched source. Values marked **DERIVED** are
my own arithmetic from cited inputs, or values I read off a published graph by eye. They are not quoted from a source.

This note builds on note C (`C_engine_mujoco.md`). It does not repeat C's slider-crank kinematics, Wiebe definition, single-zone
dp/dθ equation, MEP↔power relation or the propeller coefficients. Propeller aerodynamics belongs to note F. References here are
numbered independently of note C. "C:R17" means reference R17 of note C.

Note on graphs: several manufacturer curves (Rotax, Lycoming, Continental) exist only as images in the PDFs. I rendered those pages
and read the values by eye. Every number taken this way is marked **DERIVED (digitised)**, with a reading uncertainty of about
±1 kW, ±1 N·m or ±1–2 hp.

---

## 0. Corrections and additions to note C's engine table

| Item | Note C status | Now found | Source |
|---|---|---|---|
| Rotax 912 S/ULS compression ratio | UNCONFIRMED | **10.8 : 1** (912 A/F/UL: 9.0 : 1) | OM-912 §7.1.2 [R2] |
| Rotax 912 i Series compression ratio | UNCONFIRMED | **10.8 : 1** | OM-912 i §7.1.2 [R3] |
| Rotax 912 firing order | UNCONFIRMED | **1-4-2-3** | OM-912 §7 ignition [R2] |
| Rotax 912 gear | "i = 2.43 with overload clutch" | 912 S/ULS: 2.43 : 1 (A/F/UL: 2.27 : 1, 2.43 optional) [R2]. IM gives exact values **i = 2.2727 (50 T / 22 T) or 2.4286 (51 T / 21 T)** [R4] | [R2][R4] |
| Rotax 912 rod length | UNCONFIRMED | "Crank radius × connecting rod length 30.5 × 130 mm" for the 912 iS. This comes from one secondary paper only (low confidence, see §5.4) | [R8] |
| Continental O-200 ignition timing | UNCONFIRMED | The OCR of the specification table reads **24° BTC** for the O-200 column. The table is badly scanned, so verify before use | [R7] |
| Lycoming O-320 materials | not given | Crankshaft: "chrome nickel molybdenum steel forging", journals nitrided. Rods: "H sections from alloy steel forgings". Pistons: "machined from an aluminum alloy", full-floating pin | [R6] |

---

## 1. Friction and mechanical losses (SI engine)

### 1.1 Definitions

- Total friction work = pumping work + rubbing friction work + accessory work. Normalised by displacement:
  **tfmep = pmep + rfmep + amep**. Net output: **bmep = imep(g) − tfmep**. Mechanical efficiency: **η_m = bmep / imep(g)** [R11].
- Friction components [R11][R9]:
  1. Crankshaft: main bearings, front and rear main-bearing oil seals.
  2. Reciprocating: connecting-rod bearings, piston assembly (skirt and rings).
  3. Valvetrain: camshafts, followers, valve actuation.
  4. Auxiliaries: oil, water and fuel pumps, alternator.
  5. Pumping: intake, throttle, valves, exhaust.
- Friction work falls into three scaling families: independent of speed (boundary lubrication), proportional to speed
  (hydrodynamic) and proportional to speed squared (turbulent dissipation) [R9].
- Simplest overall model: **tfmep = a + b·N + c·N²** [R11].
- Measurement: "firing" (imep from cylinder pressure minus bmep) or "motoring" with sequential teardown. Motoring gives lower gas
  loads and temperatures, so it gives lower rubbing friction than firing [R9].

### 1.2 Chen–Flynn (global, 4 constants)

**FMEP = A + B·p_max + C·n + D·n²** [R10]. A covers accessories and other speed-independent terms, B the gas-load effect, and
C and D the speed effect [R10]. **No fetched source gave generic values of A–D**, because they must be fitted to data
(UNCONFIRMED as generic constants).

Measured accuracy on a 1242 cm³ four-cylinder SI engine (bore 70.8 mm, stroke 78.86 mm, CR 9.8, rod/crank 3.27, CNG fuel,
50 cycles per point) [R10]:
- Chen–Flynn fitted to the data gave a **mean error of 13 %, a maximum error of 35 % and a worst case of 0.668 bar**.
  Adding p_max² and p_max³ terms did not help (13 % / 33 % / 0.619 bar).
- The author found that FMEP depends on the location of peak pressure (LPP) more than on p_max: retarded combustion means more
  friction (piston side thrust). His replacement is FMEP = (A + FMEP_n·(n/1000)·(a·LPP + b·LPP² + c·LPP³)) with
  FMEP_n = C·n + D·n². It gives a **mean error of 6 %, a maximum of 18 % and a worst case of 0.336 bar**. For LPP ≤ 20° ATDC
  the figures are 5 % / 15 % / 0.243 bar, against 8 % / 22 % / 0.358 bar for Chen–Flynn [R10].
- Magnitude: the measured FMEP of that 1.2 L engine spans roughly **0.6–2.1 bar** over 1500–5000 rpm (graph axes and points of
  Figs. 1, 4 and 7 of [R10]). DERIVED (digitised, coarse).
- TDC phasing: "a 1 degree error ... can cause up to a 10% error in the IMEP estimation" [R10]. This matters for any measured
  validation trace.

### 1.3 Patton–Nitschke–Heywood (PNH, SAE 890836) and Sandoval–Heywood (SAE 2003-01-0725)

Component model, kPa. Inputs: B, S, D_b, L_b in mm; N in rpm; S̄_p (mean piston speed) in m/s; pressures in kPa;
n_c = number of cylinders, n_b = number of bearings, n_v = number of valves. Equations from Sandoval's MIT thesis [R9].
**Caveat: the thesis PDF is an OCR scan and some equations are garbled. The forms below are my reconstruction of [R9] eqs. 7–13
and Appendix A-2. Verify them against SAE 890836 / 2003-01-0725 or Heywood ch. 13 before coding (marked "R" = reconstructed).**

- Crankshaft (eq. 7, R):
  cfmep = 1.22·10⁵·(D_b/(B²·S·n_c)) + 3.03·10⁻⁴·(N·D_b³·L_b·n_b/(B²·S·n_c)) + 1.35·10⁻¹⁰·(D_b²·N²·n_b/n_c).
  The terms are seals (boundary), main-bearing hydrodynamic and turbulent oil dissipation. Sandoval–Heywood multiply only the
  hydrodynamic term by the viscosity ratio [R9].
- Reciprocating, no gas load (eq. 8, R):
  rfmep = 2.94·10²·(S̄_p/B) + 4.06·10⁴·(1 + 1000/N)·(1/B²) + 3.03·10⁻⁴·(N·D_b³·L_b·n_b/(B²·S·n_c)).
  The terms are piston skirt (hydrodynamic), rings (mixed; the factor was chosen so that "the friction coefficient decrease[s] by a
  factor of 2.5 from low to high speeds") and rod bearings. Sandoval–Heywood change 1+1000/N to **1+500/N** (factor 1.8) and add
  ring-tension and roughness factors [R9].
- Reciprocating, gas load (eq. 9, R):
  rfmep_gas = 6.89·(p_i/p_a)·[0.088·r_c + 0.182·r_c^(1.33 − K·S̄_p)], with **K = 2.38·10⁻²**. Sandoval–Heywood double K
  ("1.33 − 2K·S̄_p") to reflect smoother liners [R9].
- Valvetrain (eq. 10, R): a camshaft-bearing hydrodynamic term 244·(N·n_b/(B²·S·n_c)) plus a constant **4.12 kPa** for cam-bearing
  seals, flat-follower C_ff·(1+1000/N)·n_v/(S·n_c), roller-follower C_rf·N·n_v/(S·n_c), oscillating hydrodynamic C_oh and
  oscillating mixed C_om terms [R9].
  Constants (Table 4.2 of [R9]): SOHC finger follower C_ff = 600, C_rf = 0.0227, C_oh = 0.2, C_om = 42.8; SOHC rocker arm 400 /
  0.0151 / 0.5 / 21.4; DOHC direct acting 133 / 0.0050 / 0.5 / 10.7. The **OHV** row reads "400 … 0.5 32.1" with the roller
  column illegible in the scan (UNCONFIRMED). Lycoming and Rotax are OHV pushrod engines with hydraulic tappets
  [R6][R1][R2] (Rotax "OHV" abbreviation [R2]; Lycoming "valve tappets, push rods" [R6]).
- Auxiliaries (eq. 11): **afmep = 6.23 + 5.22·10⁻³·N − 1.79·10⁻⁷·N²** (oil pump, water pump, non-charging alternator, fitted to
  "a group of small, high-speed diesel engines") [R9].
- Pumping (eqs. 12–13): intake (p_a − p_i) + valve term; exhaust 0.178·(…)·S̄_p² + valve term. Sandoval–Heywood set the
  valve-drop constant to **3.0·10⁻³ kPa·s²/m²** [R9].
- Oil temperature: viscosity scaling makes **cold (20 °C) mechanical friction ≈ 2.1× hot (90 °C)**, consistent with Shayler's
  warm-up firing data [R9][R13]. Reference oil 10W30, 10.6 cSt at 90 °C [R9].
- **Measured accuracy** of the revised model [R9]: crankshaft friction "significantly under predicted". Reciprocating friction was
  ~13 kPa low at high speed on the 3.0 L engine. Total mechanical friction was over-predicted by ~15 % on the 6.8 L prototype
  (firing), by ~15 kPa on average on the 3.0 L (motored with gas loading), and under-predicted by ~10 kPa on the 5.4 L (with gas
  exchange). Conclusion: "The model now predicts, with acceptable accuracy, total friction and its major components" [R9].
- Breakdown proportions (C/R/V/A/P vs speed) for a 2.0 L I-4 SOHC appear as a figure from SAE 890836 in [R11]. The numbers are not
  extractable (UNCONFIRMED).

**DERIVED example (Rotax 912 S/ULS at 5800 rpm, WOT, p_i = p_a, PNH constants)**: B = 84 mm, S = 61 mm [R1], r_c = 10.8 [R2],
S̄_p = 2·0.061·5800/60 = 11.79 m/s.
- Piston skirt: 2.94·10²·11.79/84 = 41.3 kPa. Rings: 4.06·10⁴·(1 + 1000/5800)/84² = 6.7 kPa.
- Gas loading: 6.89·[0.088·10.8 + 0.182·10.8^(1.33 − 0.0238·11.79)] = 21.8 kPa (PNH). With Sandoval–Heywood's 2K the
  exponent is 0.769 and the term is 14.4 kPa.
- Auxiliaries: 6.23 + 30.28 − 6.02 = 30.5 kPa.
- Sum of these terms ≈ **0.9–1.0 bar**, **without** crank and rod bearings, valvetrain and pumping (bearing dimensions
  UNCONFIRMED).
- With BMEP = 11.25 bar at 5800 rpm (note C), an assumed FMEP of 1.3–2.0 bar gives η_m = 11.25/(11.25 + FMEP) ≈
  **0.85–0.90**. The FMEP range is an assumption; the η_m arithmetic is DERIVED.

### 1.4 Bearing friction (journal and rolling)

- **Petroff** (concentric journal, lightly loaded): it gives "the coefficient of fluid friction in terms of lubricant viscosity,
  speed and dimensions" and "has been found to a very good approximation for lightly loaded conditions" [R26]. The equation is an
  image in [R26]. Standard form, DERIVED from Newton's viscous law: torque T = 2π·η·ω·R³·L/c_r, friction coefficient
  f = 2π²·(η·N/P)·(R/c_r) with N in rev/s and P the unit load (load/(2RL)).
- Engine bearings run in hydrodynamic lubrication. Rings run boundary/mixed/hydrodynamic around TDC/BDC (Stribeck diagrams in
  [R9][R11]).
- **Rolling bearings (simple constant-μ model)**: M = F·f·(d/2), with d the bore diameter. f = 0.0015 deep-groove ball (radial),
  0.0011 cylindrical roller with cage, 0.0018 taper or spherical roller, 0.003 needle with cage. The values assume "running
  bearings without seals" with optimum lubrication; start-up can be "up to twice the values"; add ~0.001 for seals [R25].
  Koyo gives ranges: deep groove 0.0010–0.0015, cylindrical roller 0.0008–0.0012, needle cage 0.0020–0.0030, and plain bearings
  0.01–0.02 [R24]. The full SKF four-component model was not fetched (UNCONFIRMED). For llull, rolling bearings matter only for
  gearbox and propeller-shaft supports. Engine mains and big ends are plain bearings, covered by PNH.

---

## 2. Combustion realism

### 2.1 Burn-rate and phasing targets

- Burn durations for "modern fast-burn engines under medium speed, part load": **0–10 % ≈ 15°, 0–50 % ≈ 25°, 0–90 % ≈ 35° CA**.
  Burn duration in CA degrees "increases approximately as rpm^0.2" [R12].
- MBT phasing: "**a peak cylinder pressure usually occurs around 15° ATDC** ... and the 50 percent Mass Fraction Burned (MBF)
  location generally occurs from **8° to 10° ATDC**". The maximum acceleration of the mass fraction burned is at TDC [R16].
- Torque near MBT is flat: "roughly 5 to 7° CA retard from MBT results in 1% loss in torque" [R12].
- Aviation engines use **fixed** spark timing: O-320 **25° BTC** [R6] (also in note C), O-200 ~24° BTC (OCR, verify) [R7].
  The Rotax 912 carbureted versions use breakerless capacitor-discharge ignition [R2]; the timing value is UNCONFIRMED.
  Fixed timing means combustion phasing drifts away from MBT with rpm. That is a realism point: LPP is not pinned at 15°.
- Wiebe a = 5, m = 2 and Yeliana's fit method: see note C. **DERIVED Wiebe start for an MBT-like case**: with a = 5, m = 2, CA50
  sits at θ₀ + Δθ·(ln2/5)^(1/3) = θ₀ + 0.517·Δθ. For Δθ = 50° and CA50 = 9° ATDC, θ₀ ≈ 17° BTDC.

### 2.2 Minimum model that gives a realistic pressure trace

The usual 0-D minimum is: single zone + first law + Wiebe heat release + **Woschni** wall heat transfer, integrated with
Runge–Kutta. A published 0-D model of the **Rotax 912 iS** uses exactly this [R8]:
- Energy equation dQ_in/dθ − dQ_loss/dθ − p·dV/dθ = m·c_v·dT/dθ + c_v·T·dm/dθ, giving
  dp/dθ = −k·(p/V)·dV/dθ + ((k−1)/V)·(dQ_in/dθ − dQ_loss/dθ) [R8].
- Woschni as written in [R8]: **h = 3.26·p^0.8·U^0.8·b^−0.2·T^−0.55**, with **U = 2.28·v̄_p + 0.00324·(V_d·T_a/(p_a·V_a))·(p − p_mot)**
  (the motored-pressure difference is implied by the Woschni structure [R17]). Inputs: wall temperature T_w = 450 K, LHV =
  44 650 kJ/kg, T_a = 297 K, p_a = 90 kPa [R8].
- Woschni constants elsewhere: C1 = 3.26, T exponent **−0.53**, h in W/(m²K) with p in kPa (code uses p/1000 with p in Pa), C2 =
  2.28 closed valves / 6.18 gas exchange, C3 = 0.00324 for combustion/expansion and 0 for compression. Motored pressure follows a
  polytropic with **n = 1.32** (default) [R17]. Gas velocity "U = 6.18 U_piston" for intake/exhaust and "2.28 U_piston" for
  compression [R18]. The same 6.18/2.28 constants are used in a patent spreadsheet model, which adds a multiplier k_tc = 1.7
  [R13]. **The T exponent differs between sources (−0.55 [R8] vs −0.53 [R17]). The original SAE 670931 was not fetched
  (UNCONFIRMED which is canonical.)**
- Outputs of [R8] for the 912 iS at 5800 rpm: **peak pressure ≈ 53 bar near TDC** (the paper says manufacturer "test records" give
  55 bar), peak heat flux ≈ 2.8 MW/m² ("typical range of 2–3 MW/m²"), peak bulk temperature ≈ 1600 K, and heat loss ≈ 21 % of fuel
  energy. Its validation table: p_max 55 vs 53 bar (3.6 %), brake power 73.5 vs 77.2 kW (the paper prints 2.5 %; DERIVED:
  (77.2−73.5)/73.5 = 5.0 %), bsfc 264 vs 254 g/kWh (paper 4.9 %; DERIVED 3.8 %). The acceptance rule was "not over 5%" [R8].
  **Quality warning**: [R8] gives CR = 10.5 where the OM says 10.8 [R3], its percentage errors do not recompute, and it reports a
  heat-release rate of "0.04 kW". Treat its p_max ≈ 53–55 bar as a plausible order of magnitude, not a validated measurement.
- Polytropic exponents: Woschni motored reference n = 1.32 is a model default [R17]. Measured whole-stroke average compression
  exponents on a production SI car engine at full load were **n = 1.160 (1100 rpm), 1.144 (2200), 1.140 (3300), 1.198 (4100)**,
  and the local n decreases along the stroke [R19]. That rig used industrial sensors, and the low values include heat loss and
  blow-by. Expansion exponent: no fetched measured value (**UNCONFIRMED**). A polytropic-only model therefore needs n_c and n_e
  as calibration parameters. The single-zone + Woschni model derives them from heat transfer instead (DERIVED reasoning).

### 2.3 Cycle-to-cycle variation (CCV)

- For a naturally aspirated 1.6 L four-cylinder SI engine at MBT spark, typical **COV(p_max) = 6.5–10.0 %** and **SDEV(CA50) =
  1.6–3.2° CA** across 1000–6000 rpm and 2–10 bar IMEP. "The frequently applied limit value for smooth engine run is COV(PMAX) <
  15%", with SDEV(CA50) < 5° CA as a companion limit. CCV rises at IMEP < 1 bar [R14].
- Causes: flame-kernel development (dominant), turbulence, and variation of fuel, air and residuals per cycle [R14].
- COV(IMEP) criterion: "stable combustion lean boundary ... criterion in which **COV IMEP is set 5%**", measured over 100
  consecutive cycles [R15]. The commonly quoted drivability limit of ~10 % COV(IMEP) appeared only in a search snippet
  (**UNCONFIRMED**).
- Modelling hook (DERIVED from [R14]): sample θ₀ (or CA50) per cycle from N(μ, σ) with σ ≈ 2° CA. This reproduces COV(p_max) of
  order 6–10 % at MBT.

---

## 3. Inertia and dynamics realism

### 3.1 Reciprocating and rotating masses

- Note C gives the inertia force m_rec·r·ω²(cosθ + λ·cos2θ). DERIVED magnitudes at 5800 rpm for the Rotax (rω² = 11 252 m/s²,
  note C): **11.25 kN per kg of reciprocating mass (primary)**. With λ = 30.5/130 = 0.235 [R8] (low confidence), the secondary
  amplitude is 2.64 kN/kg. Compare the gas force: 55 bar × 0.00554 m² = **30.5 kN** (DERIVED, using [R8]'s 55 bar). So inertia
  is of the same order as gas load at rated rpm for any plausible piston + pin + small-end mass of a few hundred grams. Inertia
  **must** be in the model; rigid bodies with real masses capture it.
- DERIVED inertia torque per cylinder (standard series, rod mass lumped): T_i ≈ m_rec·r²·ω²·[(λ/4)·sinθ − (1/2)·sin2θ −
  (3λ/4)·sin3θ]. For four cylinders at 180° crank spacing, the sinθ and sin3θ terms cancel in pairs while the **sin2θ terms
  add** (×4). The 2nd-order inertia torque is therefore a dominant 2E ripple at high rpm. This is a good MuJoCo-vs-analytic
  verification case.
- Flat-four balance: "perfect secondary balance"; primary rocking couples cancel; "a secondary rocking couple" remains
  [R29] (Wikipedia, secondary). Force balance at the crankcase does **not** remove the bearing and pin loads or the torque ripple
  inside the mechanism.
- **Piston and rod masses of Rotax 912 / O-200 / O-235 / O-320: not published in any fetched source (UNCONFIRMED).** Lycoming
  sorts rods into weight classes A, B, S, D, E ("S" = service part of "median weight") and pistons into A/B with AS/BS service
  parts. No gram values are given [R30]. Lycoming's materials are listed in §0 [R6].
- Material densities (for a mass estimate from CAD volume): **4032 piston alloy SG 2.68** (0.097 lb/in³), "racing pistons"
  [R32]. 2618A "Aluminium for Pistons" (density not given on the fetched sheet [R33]). **AISI 4340 steel 7.85 g/cc, E = 200 GPa,
  G = 78 GPa**, "piston pins, bearings, ... gears" [R31]. Lycoming's "chrome nickel molybdenum steel" [R6] is of the 4340 family
  (the identification is UNCONFIRMED). Practical route (DERIVED): mass = CAD volume × density, which llull already supports
  through mass properties.
- Rotax engine inertias for mounting: the whole engine is 11 100 / 10 900 / 17 400 kg·cm² about the x/y/z axes
  (configuration 2) [R4]. **Propeller moment of inertia must be 1500–6000 kg·cm² (0.15–0.60 kg·m²)**, maximum propeller-shaft
  torque 315 N·m for 912 S/ULS at i = 2.4286, and maximum shaft extension 120 mm [R4]. These are realistic bounds for the
  propeller body in the sim.

### 3.2 Torsional vibration: are rigid bodies acceptable?

- Engine forces act at multiples of engine speed ("E orders"), aerodynamic forces at multiples of propeller speed ("P orders").
  "Engine crankshaft torsional dampers and crankshafts have a significant effect on propeller vibratory load"; higher compression
  means higher propeller vibratory loads; propeller inertia and diameter changes call for re-evaluation [R27].
- Rotax 912 drive: "torsional shock absorber ... progressive torsional cushioning due to axial spring load acting on a dog hub".
  With the overload clutch, "a friction damped free play at the dogs" causes "a distinct torsional impact ... at start, stop and
  at sudden load changes" [R2]. Vibration limit if none is available: 0.5 in/s at 5000 rpm [R4].
- Comparable light-aircraft study (motorcycle engine + shaft + fan): the dominant torque harmonics for the four-cylinder were the
  2nd, 4th and (at low speed) 6th orders. Resonances fell inside the operating range, and the clutch stiffness was nonlinear and
  amplitude-dependent [R28].
- DERIVED: the Rotax firing frequency is 2E = 2·5800/60 = 193 Hz (4E = 387 Hz) at take-off. The propeller turns at 5800/2.43 =
  2387 rpm. **Torsional natural frequencies of the Rotax 912 or Lycoming crank–propeller systems: not found (UNCONFIRMED).**
- Conclusion (DERIVED): rigid bodies are acceptable for mean torque, power, rpm equilibrium, cyclic speed ripple (with flywheel
  and propeller inertia) and pin and bearing load waveforms away from resonance. They cannot predict gearbox and propeller
  vibratory loads, dog-clutch impacts or resonance placement. Those need at least one torsional spring-damper plus backlash
  between crank and propeller (a later phase).

---

## 4. Gearbox realism

- **Spur gear mesh efficiency** (NASA analysis validated against published data, covering sliding, rolling and windage, plus a
  support ball-bearing term): "Gear efficiencies were generally greater than 98 percent except at very low torque levels". All
  three gear sizes "reach 99 percent at relatively low torque levels"; **peak efficiencies 99.3–99.9 %**. "Tare (no-load) losses
  are generally a significant percentage of the full-load loss except at low speeds" [R21]. High-contact-ratio gears can have
  losses "about 15 percent higher" than the best low-contact-ratio set while keeping comparable efficiency [R22].
  → Model: η_mesh = 0.99 at rated load, plus a speed-dependent tare torque (DERIVED from [R21]). Helical-gear efficiency was not
  fetched (UNCONFIRMED).
- **Backlash**: AGMA recommended normal-plane backlash for coarse-pitch spur and helical gears. Center distance up to 5 in with
  10–19.99 DP: **0.005–0.015 in (0.13–0.38 mm)**. Over 5–10 in: 0.010–0.020 in [R23]. The Rotax centre distance and module are
  UNCONFIRMED. The Rotax dog-hub free play (separate from tooth backlash) exists but is not quantified [R2].
- **Rotax 912 gearbox type**: a single reduction pair, 51/21 or 50/22 teeth [R4], with mechanical (torsional) shock absorber,
  optional overload clutch (1.7 kg) and friction-damped free play at the dogs [R1][R2][R4]. Spur vs helical: **UNCONFIRMED**.
  The overload clutch "will prevent any undue load to the crankshaft in case of ground contact of the propeller" [R2].
  Oils with friction modifiers are not suitable "because of the incorporated overload clutch" [R2]. **Verdict on the user's
  question**: there is no dog *clutch* for engagement. There is a dog hub with a spring-loaded torsional damper and a separate
  friction overload (slip) clutch.

---

## 5. Measured validation data

### 5.1 Rotax 912 S/ULS (carbureted, 1352 cm³, CR 10.8, i = 2.43)

Datasheet: 73.5 kW (100 hp) at 5800 rpm, **max torque 128 N·m at 5100 rpm**, max rpm 5800, engine with gearbox 56.6 kg, TBO
2000 h, Vers. 2021/01 [R1].

OM-912 Ed.4 Rev.1 (2023), ISA, without governor or external alternator [R2]:
- Limits: take-off 73.5 kW at 5800 rpm (max 5 min); max continuous 69 kW at 5500 rpm; idle ≥ 1400 rpm.
- Power-setting table along the variable-pitch propeller curve (912 S/ULS). The PDF columns are scrambled, so I re-paired them and
  checked each pair with P = T·ω (all close within 1 %, DERIVED):

  | Setting | rpm | kW / hp | N·m | MAP in Hg |
  |---|---|---|---|---|
  | Take-off | 5800 | 73.5 / 100 | 121.0 | 27.5 |
  | Max continuous | 5500 | 69.0 / 90 (sic) | 119.8 | 27 |
  | 75 % | 5000 | 51.0 / 68 | 97.4 | 26 |
  | 65 % | 4800 | 44.6 / 60 | 88.7 | 26 |
  | 55 % | 4300 | 38.0 / 50 | 84.3 | 24 |

- Fuel (912 S/ULS): 27.0 l/h at take-off, 25.0 l/h at max continuous, 18.5 l/h at 75 %, specific **285 g/kWh** at max continuous
  [R2]. (The PDF column layout is ambiguous between the A/F/UL and S/ULS columns. I read 24.0 / 22.6 / 16.2 l/h and 285 g/kWh as
  the A/F/UL values.)
- **Fig. 4 full-throttle ("max. engine output") and torque curves, DERIVED (digitised)** [R2]:

  | rpm | 2500 | 3000 | 3500 | 4000 | 4500 | 5000 | 5100 | 5500 | 5800 |
  |---|---|---|---|---|---|---|---|---|---|
  | Torque, N·m | ≈99 | ≈107 | ≈114.5 | ≈119 | ≈124 | ≈127.5 | ≈128 (peak) | ≈124.5 | ≈121 |
  | Power, kW | ≈26.5 | ≈34 | ≈42 | ≈50 | ≈59 | ≈67.5 | – | ≈71 | 73.5 |
  | Propeller power requirement, kW | ≈6 | ≈11 | ≈16 | ≈24 | ≈34 | ≈47 | – | ≈61 | 73.5 |

  The peak matches the datasheet's 128 N·m at 5100 [R1]. Power and torque agree through P = T·ω within the reading error. Fig. 5
  (along the propeller curve): MAP ≈ 16.6 inHg at 2500, ≈24 at 4000, ≈27 at 5000, ≈29 at 5600 rpm; fuel flow ≈ 6 l/h at 2500,
  ≈12 at 4000, ≈20 at 5000, ≈27 at 5800 rpm (DERIVED, digitised).
- Altitude (Fig. 6, full throttle): at 5800 rpm, ≈ 73.5 kW at 0 m, ≈ 51 kW at 3000 m, ≈ 27.5 kW at 7500 m density altitude
  (DERIVED, digitised). Non-standard temperature correction: **P_act = P_std · T_std / T_act** (K) [R2].
- Operational constraint useful as a sim check: fixed-pitch propellers "should be set so that the take off rpm is above 5200 rpm
  (WOT)" [R5].
- DERIVED cross-checks: BMEP at peak torque = 4π·128/1.352·10⁻³ = **11.9 bar**. At 285 g/kWh with LHV 44.65 MJ/kg [R8], brake
  efficiency = 3.6/(0.285·44.65) = **28 %**.

### 5.2 Rotax 912 iS / iS Sport / iSc Sport (injected, CR 10.8)

OM-912 i Ed.2 Rev.1 (2019) [R3]: take-off 73.5 kW at 5800 rpm (max 5 min); max continuous 69 kW (912 iS) or **72 kW (iS Sport,
iSc Sport)** at 5500 rpm. Tables (re-paired the same way, DERIVED):
- **912 iS**: 5800 rpm 73.5 kW 121.0 N·m; 5500 69.0 kW 119.8 N·m; 5000 51.8 kW 98.7 N·m; 4800 44.9 kW 89.5 N·m; 4300 34.5 kW
  75.3 N·m.
- **iS Sport / iSc**: 5800 73.5 kW 121.4 N·m; 5500 72.02 kW 126.4 N·m; 5000 54.0 kW 103.1 N·m; 4800 46.7 kW 93.3 N·m; 4300
  35.9 kW 78.5 N·m.
- Some pairs do not close exactly (72.02 kW at 5500 rpm implies 125.0 N·m, not 126.4). This is a manufacturer rounding or table
  inconsistency, so allow ≥ 1.5 % tolerance on these points.
- Fuel: POWER and ECO modes "differ significantly in fuel consumption", with the switch at ~97 % throttle. Data measured at
  974 hPa (curves only, not digitised) [R3].

### 5.3 Lycoming O-320 and Continental O-200 (sea-level curves, DERIVED digitised)

- **O-320-A, -E** (CR 7.00, 25° BTC, MA-4SPA carburetor, full rich, 80/87, std sea level; curve 9540-B) [R6]:
  full-throttle bhp ≈ 128 at 2200 rpm, ≈ 146 at 2600, **150 at 2700 (rated)**, ≈ 152 at 2800. Propeller-load bhp ≈ 50 at
  1900, ≈ 85 at 2200, ≈ 106 at 2400, ≈ 130 at 2600. Full-throttle SFC ≈ 0.57–0.58 lb/bhp/h; propeller-load SFC minimum ≈ 0.53
  near 2400 rpm.
  DERIVED torque: ≈ 414 N·m at 2200, ≈ 396 N·m at 2700.
- **O-320-B, -D** (CR 8.5, 25° BTC, 91/96; curve 11259) [R6]: full throttle ≈ 138 bhp at 2200, ≈ 146 at 2400, ≈ 155 at 2600,
  **160 at 2700**, ≈ 163 at 2800. Propeller load ≈ 52 at 1900, ≈ 84 at 2200, ≈ 108 at 2400, ≈ 134 at 2600. Full-throttle
  SFC ≈ 0.52–0.54; propeller-load minimum ≈ 0.47 near 2500 rpm. DERIVED torque ≈ 447 N·m at 2200, ≈ 422 N·m at 2700.
- **Continental O-200** (X30012, 2011) [R7]: rated 100 hp at 2750 rpm, CR 7.0 : 1 (spec table, OCR). Full-throttle bhp ≈ 69 at
  1950, ≈ 87 at 2400, ≈ 100 at 2750. Propeller load ≈ 40 at 2000, ≈ 67 at 2400, ≈ 83 at 2600. SFC 0.53–0.69 lb/bhp/h
  (DERIVED, digitised, Fig. 5).

### 5.4 Published simulation-vs-test studies

- **Grabowski, Siadkowska, Skiba, "Simulation research of aircraft piston engine Rotax 912", MATEC Web Conf. 252 (2019) 05007**:
  AVL Boost 1-D model. [R8] reports its deviations as "within approximately ±3 kW in brake power and ±2 Nm in engine torque". The
  MATEC PDF was behind a bot check and **was not fetched (UNCONFIRMED first-hand)**.
- **Vinh & Quân, JAST 2025** [R8]: the 0-D Wiebe + Woschni 912 iS model in §2.2, with a ≤ 5 % acceptance rule. Only three scalar
  comparisons and no measured pressure trace. Low quality.
- **No published measured cylinder-pressure trace, IMEP or FMEP for the Rotax 912, O-200 or O-320 was found (UNCONFIRMED).**
  Parker & Rizzoni, "Individual cylinder model of a general aviation aircraft engine", J. Propulsion & Power 15(5) 1999 is cited
  in [R8] but was not fetched.

---

## 6. Accuracy expectations and the V&V framing

### 6.1 What mature tools and studies achieve

- GT-Power calibration targets recommended by **Gamma Technologies** (as reported in a Volvo/Chalmers thesis): **IMEP ±5 %,
  CA50 ±3° CA, peak cylinder pressure ±5 bar, ignition delay ±3°**. Air flow ±2 % and volumetric efficiency ±3 % are also
  recommended [R20]. Achieved results at 1000/1500/3900/5400 rpm validation points: SITurb model IMEP error 1.08 / 0.03 / 0.08 /
  −1.61 %, CA50 0.62 / 0.61 / −0.35 / 0.43°, p_max 0.64 / 2.22 / −2.28 / −1.93 bar. FKFS model IMEP 0.15 / −3.71 / −3.3 /
  −4.66 % [R20].
- Measurement quality limits: TDC encoder phasing error "0.6 degrees or less is acceptable" [R20]; 1° TDC error → up to 10 % IMEP
  error [R10]; thermal shock of piezo sensors can affect IMEP "by about 10%" [R20]. Validation data has its own uncertainty, of
  order ±5 % on IMEP.
- Friction sub-models: Chen–Flynn 13 % mean / 35 % max error; LPP model 6 % / 18 % [R10]; PNH/S-H ±10–15 % on totals [R9].
- AVL Boost Rotax 912: ±3 kW and ±2 N·m (second-hand, see 5.4).
- **Adams Engine / AVL Excite / Ricardo WAVE published accuracy figures: not found (UNCONFIRMED).**

### 6.2 Verification vs validation, and how acceptance criteria are stated

- NASA-STD-7009B (2024) [R34]:
  - **Verification**: "the process of determining the extent to which an M&S is compliant with its requirements and
    specifications as detailed in its conceptual models, mathematical models, or other constructs".
  - **Validation**: "the process of determining the degree to which a model or a simulation is an accurate representation of the
    real world from the perspective of the intended uses of the M&S".
  - Requirement [M&S 43]: "A record of acceptance criteria for the M&S shall be maintained, including: a. Criteria for
    Verification. b. Criteria for Validation. c. Criteria for Uncertainty. d. Criteria for Sensitivity. e. M&S assessment level
    thresholds". Rationale: the criteria "provide qualitative or quantitative information with which to judge that the M&S ...
    satisfy the intended use". It points to ASME V&V 10 and AIAA G-077 for discipline practice [R34].
- ASME V&V 20-2009 structure: Section 2 "Code Verification and Solution Verification", Section 3 input-parameter uncertainty,
  Section 4 experimental uncertainty, Sections 5–6 validation uncertainty u_val and interpretation of E and u_val [R35].
  Method [R36]: **E = S − D** (simulation minus data). **U_val = √(U_num² + U_input² + U_D²)** at 95 %. The model error δ_model
  lies in [E − U_val, E + U_val]. If |E| ≫ U_val, the model error ≈ E and the model can be improved. If |E| ≤ U_val, the model
  error is within the noise. Validation is an interval estimate, not a single pass/fail number [R36].
- Applied to llull (DERIVED):
  - *Code verification*: MuJoCo vs analytic slider-crank kinematics, torque identity and cycle energy, as in note C.
  - *Solution verification*: timestep and solref convergence.
  - *Validation*: simulated full-throttle torque curve vs Rotax Fig. 4. Here U_D includes the ~±1 N·m digitising error and the
    manufacturer table inconsistencies (~1.5 %).

---

## Recommendations for the spec

**MVP (realistic, cheap, source-backed)**

1. **Gas force** stays a single-zone pressure model. Keep Wiebe a = 5, m = 2 (note C) and set the burn so that CA50 ≈ 8–10° ATDC
   and LPP ≈ 15° ATDC at the calibration point [R16]. Take 0–90 % duration ≈ 35° at medium speed, scaled ∝ rpm^0.2 [R12].
   Keep spark fixed for Lycoming (25° BTC [R6]). Add **Woschni heat loss** (C1 = 3.26, C2 = 2.28/6.18, C3 = 0.00324, T_w ≈
   450 K) [R8][R17][R18] rather than fixed polytropic exponents [R19]. Calibrate Q_total so that BMEP matches the target (Rotax
   11.9 bar at 5100 rpm, DERIVED from [R1]). Sanity bound: p_max of order 50–55 bar at 5800 rpm WOT for the 912 iS [R8] (low
   confidence).
2. **Friction**: an FMEP(N, load) torque on the crank hinge, opposite to ω. MVP form: Chen–Flynn A + B·p_max + C·N + D·N²
   [R10], **or** PNH components [R9] (preferred: geometry-driven, no test data needed). Report FMEP and η_m. Expect η_m ≈
   0.85–0.90 at rated (DERIVED). Apply friction as a torque, not as per-joint MuJoCo damping, so that FMEP is reported exactly.
3. **Inertia**: real masses from CAD volume × density (4032 aluminium SG 2.68 [R32], 4340 steel 7.85 g/cc [R31]). Propeller
   inertia bounded to 0.15–0.60 kg·m² for Rotax [R4]. Verification test: the 2E inertia-torque ripple (DERIVED formula §3.1) vs
   the MuJoCo crank-hinge torque in a motored run without gas force.
4. **Gearbox**: rigid joint equality (note C) with **η_mesh = 0.99** applied as a loss torque ∝ transmitted torque, plus an
   optional tare term [R21]. Ratio 2.4286 for 912 S/ULS/iS [R4].
5. **Validation targets (acceptance criteria per NASA-STD-7009B [M&S 43] [R34])**:
   - V1 full-throttle torque vs Rotax Fig. 4 at 2500–5800 rpm, **±5 %** per point (GT/Chalmers practice [R20]).
   - V2 rated point 73.5 kW / 121 N·m at 5800 rpm, ±3 % [R1][R2].
   - V3 max torque 128 N·m at 5100 rpm, ±5 % and ±300 rpm [R1].
   - V4 bsfc 285 g/kWh ±10 % (needs fuel flow) [R2].
   - V5 propeller-curve operating points (table §5.1) once the propeller (note F) is coupled.
   - V6 O-320-A/B full-throttle curves ±5 % as a second engine [R6].
   - Report E and U_val per V&V 20 [R36].

**Later**

- CCV: per-cycle CA50 jitter σ ≈ 2° CA to hit COV(p_max) 6–10 % [R14]; report COV(IMEP) (≤ 5 % = stable [R15]).
- LPP-dependent friction (Pipitone) [R10]; oil-temperature viscosity scaling (cold ≈ 2.1× hot) [R9].
- Torsional compliance: crank–gear–propeller spring-damper, Rotax dog-hub free play and friction overload clutch [R2]; Campbell
  check of 2E/4E orders [R27][R28]. Gear backlash 0.13–0.38 mm as a start [R23].
- Pumping loop (PNH pmep [R9]) once intake/MAP modelling exists; altitude correction P·T_std/T_act [R2].
- Bearing-level friction (Petroff [R26], rolling μ [R24][R25]) if per-bearing losses are wanted.

**Not found / UNCONFIRMED**

- Piston, pin and rod masses and rod lengths for Rotax 912, O-200, O-235 and O-320 (except the low-confidence 130 mm rod in [R8]).
- Any measured cylinder-pressure trace, IMEP or FMEP for these engines. The Grabowski AVL Boost paper itself was not fetched.
- Generic Chen–Flynn constants; clean (non-OCR) PNH/S-H equations; the OHV valvetrain constants; the original Woschni SAE 670931
  (T exponent −0.53 vs −0.55).
- Measured expansion polytropic exponent; Rotax ignition timing; O-200 firing order.
- Torsional natural frequencies of Rotax or Lycoming crank–propeller systems; Rotax gear tooth form (spur vs helical), module and
  centre distance; helical-gear efficiency.
- Published accuracy figures for Adams Engine, AVL Excite, Ricardo WAVE; ASME V&V 10 text (only cited via NASA-STD-7009B); the
  ~10 % COV(IMEP) drivability limit; the full SKF friction model.

---

## References (all fetched 2026-10)

- [R1] Datasheet Aircraft Engine Rotax 912 ULS | S (Vers. 2021/01) — BRP-Rotax — https://www.flyrotax.com/assets/files/products/Datasheet-Aircraft-Engine-Rotax-912ULS.pdf (accessed 2026-10)
- [R2] Operators Manual for Rotax Engine Type 912 Series, OM-912, Ed.4 Rev.1 (Jan 2023) — BRP-Rotax — https://www.rotax-owner.com/pdf/OM_912-Series_ED4_R1.pdf (accessed 2026-10; graph pages 5-5 and 5-7 rendered and digitised)
- [R3] Operators Manual 912 i Series, Ed.2 Rev.1 (June 2019) — BRP-Rotax — https://rotax-owner.com/manuals/OM_912iSeries_ED2_R1.pdf (accessed 2026-10)
- [R4] Installation Manual 912 Series, IM-912, Ed.3 Rev.0 (Jan 2021) — BRP-Rotax — https://www.rotax-owner.com/pdf/IM_912_Series_Ed3_R0.pdf (accessed 2026-10)
- [R5] Service Letter SL-912-016 / SL-914-014, "Essential information regarding engine behavior, performance and manifold pressure data" (July 2009) — BRP-Powertrain — https://www.rotax-owner.com/pdf/SL-912-016.pdf (accessed 2026-10)
- [R6] Lycoming O-320 Series Operator's Manual, P/N 60297-30 (same document as note C:R20) — Lycoming — https://www.lycoming.com/sites/default/files/attachments/O-320%2520Operator%2520Manual%252060297-30.pdf (accessed 2026-10; Figs. 3-2 and 3-5 rendered and digitised)
- [R7] A & C and O-200 Series Engines Operator's Manual, Publication X30012 (Aug 2011) — Continental Motors (copy hosted by Taylorcraft forum) — https://vb.taylorcraft.org/filedata/fetch?id=183111 (accessed 2026-10; Fig. 5 rendered and digitised; spec table is a poor OCR scan)
- [R8] N. Q. Vinh, P. V. Quân, "A Simulation of Piston Engines Aircraft Based on Wiebe and Woschni Models", Journal of Aviation Science & Technology (JAST) 2025 — Vietnam Aviation Academy — https://vjol.info.vn/vaajast/article/download/136718/111765 (accessed 2026-10; low-quality source, see §2.2)
- [R9] D. Sandoval, "An Improved Friction Model for Spark Ignition Engines", S.B. thesis, MIT, May 2002 (supervisor J. B. Heywood) — MIT / Semantic Scholar copy — https://pdfs.semanticscholar.org/bfbf/1944c9a8d568a994082b40109ec8c3fe65ea.pdf (accessed 2026-10; OCR scan, equations reconstructed)
- [R10] E. Pipitone, "A new simple friction model for S.I. engine", SAE Technical Paper 2009-01-1984, doi 10.4271/2009-01-1984 — author's copy — http://emilianopipitone.altervista.org/files/pubblicazioni/SAE%20Paper%202009-01-1984.pdf (accessed 2026-10)
- [R11] MIT 2.61 Internal Combustion Engines (Spring 2017), Lecture 19 "Engine Friction and Lubrication" — MIT OCW — https://ocw.mit.edu/courses/2-61-internal-combustion-engines-spring-2017/ad971a51c4a7f2db8a20f9570c870f0d_MIT2_61S17_lec19.pdf (accessed 2026-10)
- [R12] MIT 2.61 Lecture 09 "SI engine combustion I" (same document as note C:R17) — MIT — https://web.mit.edu/2.61/www/Lecture%20notes/Lec.%2009%20SI%20engine%20combustion%20I.pdf (accessed 2026-10)
- [R13] US Patent 8,851,043 B1 "Energy recovery from compressed gas" (friction model after Patton/Sandoval–Heywood; Woschni constants 6.18/2.28, k_tc = 1.7) — Google Patents — https://patents.google.com/patent/US8851043B1/en (accessed 2026-10)
- [R14] K. Páv, "Implication of Cycle-to-Cycle Variability in SI Engines", MECCA 01/2018, doi 10.1515/mecdc-2018-0002 — CTU Prague — https://ojs.cvut.cz/ojs/index.php/MECCA/article/view/6841/6026 (accessed 2026-10)
- [R15] US Patent 8,061,321 B2 "Ignition device" (COV IMEP 5 % stability criterion, 100 cycles) — Google Patents — https://patents.google.com/patent/US8061321B2/en (accessed 2026-10)
- [R16] US Patent 7,290,442 B2 "Method and system of estimating MBT timing using in-cylinder ionization signal" (LPP ≈ 15° ATDC, CA50 8–10° ATDC) — Google Patents — https://patents.google.com/patent/US7290442B2/en (accessed 2026-10)
- [R17] libICEpost documentation, `HeatTransferModel.Woschni` (F. Ramognino) — readthedocs — https://libice-post.readthedocs.io/en/latest/autoapi/libICEpost/src/engineModel/HeatTransferModel/Woschni/index.html (accessed 2026-10)
- [R18] A. Kirkpatrick, "Instantaneous Heat Transfer Coefficients" (Woschni gas-velocity constants) — Colorado State University — https://www.engr.colostate.edu/~allan/heat_trans/page7a/page7a.html (accessed 2026-10; equations are images, constants in text)
- [R19] D. C. Caputo et al., "Determinación experimental de la variación del coeficiente politrópico de compresión utilizando diagramas abiertos", Ciencia y Tecnología 17 (2017) 9–28 — Universidad de Palermo / Dialnet — https://dialnet.unirioja.es/descarga/articulo/6223474.pdf (accessed 2026-10; n values read from figure titles)
- [R20] M. Nagappa, A. Hebbur Rameshbabu, "Comparison of Predictive Gasoline Combustion Models Using GT-Power", MSc thesis 2016:20, Chalmers (Volvo Cars) — Chalmers — https://publications.lib.chalmers.se/records/fulltext/255898/255898.pdf (accessed 2026-10)
- [R21] N. E. Anderson, S. H. Loewenthal, "Effect of Geometry and Operating Conditions on Spur Gear System Power Loss", NASA TM 81426 / AVRADCOM TR-80-C-2 (1980) — NASA NTRS — https://ntrs.nasa.gov/api/citations/19800010132/downloads/19800010132.pdf (accessed 2026-10)
- [R22] N. E. Anderson, S. H. Loewenthal, "Efficiency of Nonstandard and High Contact Ratio Involute Spur Gears", NASA TM 83725 / USAAVSCOM TR 84-C-9 (1984) — NASA NTRS — https://ntrs.nasa.gov/api/citations/19840021154/downloads/19840021154.pdf (accessed 2026-10)
- [R23] "Specifying AGMA Spur Gear, Helical Gear, and Herringbone Gear Backlash" (AGMA recommended backlash table) — Engineers Edge — https://www.engineersedge.com/gears/determining_gear_backlash.htm (accessed 2026-10)
- [R24] "Friction of rolling bearings", Table 8-1 friction coefficients — JTEKT / Koyo — https://koyo.jtekt.co.jp/en/support/bearing-knowledge/8-4000.html (accessed 2026-10)
- [R25] "Bearing Friction" (rolling-bearing friction torque and coefficients) — Roymech — https://roymech.org/Useful_Tables/Tribology/Bearing-Friction.html (accessed 2026-10)
- [R26] Module 3 "Bearing Systems", Lecture 2 (Petroff's equation, variables and validity) — NPTEL — https://archive.nptel.ac.in/content/storage2/courses/112103024/module3/lec2/1.html (accessed 2026-10; equation is an image)
- [R27] FAA Advisory Circular AC 20-66B "Propeller Vibration and Fatigue" (24 Mar 2011) — FAA — https://www.faa.gov/sites/faa.gov/files/2022-11/AC20-66B.pdf (accessed 2026-10)
- [R28] D. Hlaváček, "Dynamical behaviour of a fan propulsion unit for an unconventional ultra-light aircraft", READ 2012 — CTU Prague / Warsaw Univ. of Technology — https://read.meil.pw.edu.pl/wp-content/uploads/Program/2012/Papers/Students/Paper_READ2012_Hlavacek_David.pdf (accessed 2026-10)
- [R29] "Flat-four engine" (balance of the boxer-four) — Wikipedia — https://en.wikipedia.org/wiki/Flat-four_engine (accessed 2026-10; secondary source)
- [R30] "Replacing Connecting Rods or Pistons" (weight classes A/B/S/D/E, AS/BS) — Lycoming — https://lycoming.com/node/126507 (accessed 2026-10)
- [R31] AISI 4340 Steel, normalized, 25 mm round (MatWeb data sheet) — Quickparts copy — https://quickparts.com/wp-content/uploads/2024/05/Steel-4340.pdf (accessed 2026-10)
- [R32] 4032 Aluminium technical datasheet — Smiths High Performance — https://www.smithshp.com/assets/pdf/aluminium/high-performance-aluminium/4032-aluminium-english.pdf (accessed 2026-10)
- [R33] 2618A Aluminium technical datasheet (rev. 11.02.2025) — Smiths High Performance — https://www.smithshp.com/assets/pdf/aluminium/high-performance-aluminium/2618a-aluminium-english.pdf (accessed 2026-10)
- [R34] NASA-STD-7009B "Standard for Models and Simulations" (approved 2024-03-05) — NASA — https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf (accessed 2026-10)
- [R35] ASME V&V 20-2009 "Standard for Verification and Validation in Computational Fluid Dynamics and Heat Transfer" (front matter / contents) — ASME — https://www.asme.org/getmedia/692ee706-d396-49fd-b62c-d8e3de655a27/21356.pdf (accessed 2026-10; contents only, not the full standard)
- [R36] "Validation Procedure for 3rd Workshop on CFD Uncertainty Analysis" (V&V 20 E and U_val method), Lisbon, Oct 2008 — Instituto Superior Técnico — https://maretec.tecnico.ulisboa.pt/~maretec.daemon/html_files/VV2010_files/ValidationProcedure.pdf (accessed 2026-10)
