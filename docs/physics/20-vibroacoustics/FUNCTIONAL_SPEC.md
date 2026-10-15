# PHY-20: Vibro-acoustics (hand-off) — functional specification

Gap id **VAC** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Summary

Spacecraft and launch-vehicle payloads are qualified against **acoustic** environments (diffuse sound fields of
around 130–150 dB in reverberant chambers), and cabin noise matters for aircraft. These are specified as sound
pressure levels per octave or one-third-octave band. llull has nothing for them: no way to hold an acoustic
spectrum, convert between band levels, overall level (OASPL), rms pressure and pressure PSD, or attach such an
environment to the faces of a part so a specialist tool can compute the response.

Acoustic response analysis proper (acoustic finite elements, boundary elements, statistical energy analysis, SEA)
is a separate product and stays **out of scope** (gap list decision, README PHY-20). This pack is a **hand-off**:

1. Acoustic spectra as document data (SPL dB re 20 µPa per band, octave or one-third-octave on the base-10 band
   system of IEC 61260-1 [R2]), with source and grade.
2. Exact conversions as pure queries: SPL ↔ rms pressure, band ↔ OASPL, third-octave → octave, band SPL →
   band-averaged pressure PSD (Pa²/Hz).
3. An **acoustic exposure** that binds a spectrum to faces of a part (diffuse or progressive field, stated), and
   an export of the exposure (spectrum, PSD, faces, areas, provenance) for an external acoustic / SEA tool or for a
   later PHY-09 random-pressure load (PHY-09 V2).
4. A read-only check (`check_acoustic_handoff`) with stable codes.

## 2. Aerospace context & value

| Context | Today | What llull adds | Source |
| ------- | ----- | --------------- | ------ |
| Payload vibroacoustic test criteria | NASA-STD-7001 sets vibroacoustic test factors and minimum workmanship levels for payloads; 7001B (2017) supersedes 7001A | Hold the programme's acoustic spectrum with its source; compute OASPL and PSD exactly; never ship levels that were not read from the standard | [R5] |
| GSFC environmental verification | GEVS requires an acoustic test at payload level and random vibration at component level | The acoustic side is a spectrum on faces; the random side is PHY-09 | [R6] |
| Band systems | Octave and fractional-octave filters per IEC 61260-1 (base-10 ratio G = 10^0.3, f_r = 1 kHz) | Bands are stored by exact mid-band frequency; nominal labels only for display | [R2][R4] |
| Levels and reference values | Reference sound pressure 20 µPa in air (ISO 1683 family) | One conversion module, unit-tested | [R3][R4] |

**Value statements** (sourced only): the band and level arithmetic is exact and public [R2][R4]; holding it in
llull removes hand transcription between a test specification and an analysis hand-off.

## 3. Personas & user stories

Roles per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1.

| Role | Who | Main need |
| ---- | --- | --------- |
| **Operator (primary)** | AI agent via the `llull` CLI | Exact conversions, a clean hand-off package, stable codes |
| **Owner** | Payload team member; not assumed to be an acoustics engineer | "What does 141 dB OASPL mean for my panel, and who computes the response?" |
| **Qualified reviewer** | Vibroacoustics engineer / test authority | Checks the spectrum source, field type and exposed faces before the hand-off is used |

- **US-1 (operator).** The owner pastes a one-third-octave table from their launch-vehicle user's guide; the agent
  stores it with the citation, reports OASPL, octave levels and band PSDs, and flags it `unverified` until a
  reviewer confirms the source.
- **US-2 (operator).** The agent binds the spectrum to the exterior faces of an enclosure as a diffuse field and
  exports the hand-off package (`--save`) for the acoustic analyst.
- **US-3 (operator).** Asked for the panel's acoustic response, the agent gets `VAC_OUT_OF_SCOPE` with the hand-off
  path, instead of an invented number.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Acoustic spectra (octave, third-octave, base-10 bands 25 Hz–10 kHz for thirds), conversions (SPL ↔ p, OASPL, regrouping, PSD), acoustic exposure on faces, export package (JSON + CSV), `check_acoustic_handoff`, quick query `acoustic_level`. |
| **V1** | Narrow-band PSD ↔ band SPL (integration over bands), acoustic exposure as a PHY-09 random-pressure load (uniform, fully correlated — a stated simplification), A-weighting for cabin noise (IEC 61672 weights, to source). |
| **Out of scope** | Acoustic FE / BEM / SEA, structural-acoustic coupling, spatial correlation of diffuse fields, test-level derivation (human act), cabin noise prediction. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-VAC-01 | MUST | Acoustic spectra are document data: name, bandwidth (`octave` / `third_octave`), bands (nominal label + exact mid-band frequency), SPL in dB, reference, source, grade, `unverified`. | Traceable environment | AF-31/32 |
| FR-VAC-02 | MUST | Levels state their reference explicitly (`20uPa` in air); a missing reference is a refusal. Conversions p = p₀·10^(L/20), L = 20 log₁₀(p/p₀). | No silent reference | [R3][R4] |
| FR-VAC-03 | MUST | Band centres and edges follow the base-10 system: f_m = f_r G^(x/b) (odd b), f₁,₂ = f_m G^(∓1/(2b)), G = 10^0.3, f_r = 1000 Hz; nominal labels map to exact frequencies; unknown labels are refused. | Unambiguous bands | [R2][R4] |
| FR-VAC-04 | MUST | OASPL and any band group by energy sum 10 log₁₀ Σ 10^(Lᵢ/10); overall rms pressure reported. | Overall level | derived |
| FR-VAC-05 | MUST | Band SPL → band-averaged one-sided pressure PSD G = p²/(f₂ − f₁) in Pa²/Hz, and back; the result states it is band-averaged. | Input for structural random analysis | derived |
| FR-VAC-06 | MUST | Third-octave → octave regrouping (three thirds per octave, edges coincide); refuse the reverse (no information to split). | Common conversion | derived |
| FR-VAC-07 | MUST | No acoustic test level from NASA-STD-7001 / GEVS is shipped until read from the standard; the spectrum library is empty in MVP. | No fabricated numbers | [R5][R6] |
| FR-VAC-08 | MUST | Acoustic exposure: spectrum + 05 face targets (`facesNear`) + field type (`diffuse` / `progressive`, no default) + optional notes; export package with face ids, areas (01 KRN), spectrum, PSD and provenance. | Hand-off | 05 FR-FEA-07 |
| FR-VAC-09 | MUST | `unverified` propagates from spectra into exposures and exports; exports carry `reviewRequired` (they feed qualification). | AF-32/33 | AF-32, AF-33 |
| FR-VAC-10 | MUST | Stable codes for every refusal and check item (TECHNICAL_SPEC §7.1). | AF-11 | AF-11 |
| FR-VAC-11 | MUST | Response requests (SEA, acoustic FE) return `VAC_OUT_OF_SCOPE` with the hand-off instruction. | Honest boundary | README decision |
| FR-VAC-12 | SHOULD (V1) | Exposure → PHY-09 random-pressure load with the correlation assumption named. | Simple quick checks | PHY-09 V2 |

## 6. Workflows

### 6.1 CLI

```bash
D="--doc box.llull.json --kernel occt --json"
llull acoustic_level splDb=140 $D                             # 200 Pa rms
llull run vac_flat_spectrum_handoff.plan.json --validate $D
llull run vac_flat_spectrum_handoff.plan.json $D             # define spectrum, report, regroup, exposure, check
llull acoustic_spectrum_report spectrum=flat130 $D            # OASPL 144.313637642 dB, band PSDs
llull export_acoustic_load exposure=enclosure_skin --save out/enclosure_acoustic.json $D
llull check_acoustic_handoff $D
```

### 6.2 MCP

Same commands (all pure); the export returns the package in `data` (bounded) or writes to the exchange directory.

### 6.3 UI

Band bar chart and exposure faces highlighted; review only.

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Band label not in the base-10 series | `VAC_BAND_UNKNOWN` | FR-VAC-03 |
| Duplicate band | `VAC_BAND_DUPLICATE` | FR-VAC-01 |
| No reference | `VAC_REFERENCE_UNSET` | FR-VAC-02 |
| Octave → third split requested | `VAC_CONVERSION_UNSUPPORTED` | FR-VAC-06 |
| Field type missing on exposure | `VAC_FIELD_UNSET` | FR-VAC-08 |
| Response requested | `VAC_OUT_OF_SCOPE` | FR-VAC-11 |

## 7. Acceptance criteria

| # | When (CLI) | Then (JSON) | VC |
| - | ---------- | ----------- | -- |
| AC-1 | `llull acoustic_level splDb=140` | `data.pRmsPa` = 200 | VC-VAC-01 |
| AC-2 | `llull acoustic_spectrum_report spectrum=flat130` | `data.oasplDb` = 144.313637642; `data.bands[1000 Hz].psdPa2PerHz` = 17.3334621199 | VC-VAC-06, 10 |
| AC-3 | `llull convert_acoustic_spectrum … to=octave` on the VC-VAC-12 thirds | octave 1 kHz = 133.785922887 dB | VC-VAC-12 |
| AC-4 | define a band "1100 Hz" | exit 1, `VAC_BAND_UNKNOWN` | VC-VAC-30 |
| AC-5 | export an exposure of an unverified spectrum | `unverified: true`, `reviewRequired: true` | VC-VAC-32 |
| AC-6 | ask for an SEA response | exit 1, `VAC_OUT_OF_SCOPE` | VC-VAC-33 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| IEC 61260-1:2014 [R2] | Base-10 band formulas | Formulas through an open implementation [R4] and search; standard text not read |
| ISO 1683:2015 [R3] | Reference values (20 µPa) | Catalogue; value via [R4] |
| NASA-STD-7001B [R5], GSFC-STD-7000B [R6] | Scope only | No values read; none shipped |

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Conversion cases | 100 % of VC-VAC-01…12 at 1e-12 rel / 1e-9 dB |
| Fabricated levels | 0 library levels without a read primary source |
| Hand-off completeness | export package loads in a JSON-schema validator with no missing field |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| Users mix nominal and exact frequencies | Exact frequencies stored; labels display only |
| Band-averaged PSD read as narrow-band | Field name and summary say "band-averaged" |
| Diffuse-field correlation ignored in a simple PHY-09 load (V1) | Named assumption, `reviewRequired`, reviewer sign-off |
| Standard levels unread | Library empty until a human reads them |

## 11. References

- [R2] IEC 61260-1:2014 Electroacoustics — Octave-band and fractional-octave-band filters — Part 1: Specifications — IEC (catalogue; formulas via [R4]) — https://www.vde-verlag.de/iec-normen/preview-pdf/info_iec61260-1{ed1.0}b.pdf (accessed 2026-10, search)
- [R3] ISO 1683:2015 Acoustics — Preferred reference values for acoustical and vibratory levels — ISO (catalogue) — https://scc-ccn.ca/standardsdb/standards/8156718 (accessed 2026-10, search)
- [R4] acoustic-toolbox (BSD-style licence; successor of python-acoustics), `standards/iec_61260_1_2014.py`, `standards/iso_tr_25417_2007.py`, `decibel.py` — https://github.com/Universite-Gustave-Eiffel/acoustic-toolbox/tree/9ac5f5bd2ff19163330681e424e2ce3e8e8db0b1 (accessed 2026-10)
- [R5] NASA-STD-7001 Payload Vibroacoustic Test Criteria (7001B supersedes 7001A, 2017) — https://standards.nasa.gov/standard/NASA/NASA-STD-7001 (accessed 2026-10, search)
- [R6] GSFC-STD-7000B GEVS — https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000 (accessed 2026-10, search)
- llull: `../README.md` (PHY-20 row), `../09-structural-dynamics/TECHNICAL_SPEC.md`, `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`
