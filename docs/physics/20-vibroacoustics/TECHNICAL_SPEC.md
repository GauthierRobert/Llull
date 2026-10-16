# PHY-20: Vibro-acoustics (hand-off) — technical specification

Gap id **VAC** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit |
| ---- | ----------- | ---- | ----- |
| Acoustics in code | Nothing: no file in `packages/*/src` or `server/src` mentions sound pressure, SPL, octave bands or decibels (grep 2026-10-15) | — | Everything is new |
| Face targeting | 05 FEA `FeaTarget { entityId, facesNear }` and face areas from 01 KRN (specified) | `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3 | Reused for exposures |
| Random structural response | PHY-09 vibration spectra, random response (specified) | `../09-structural-dynamics/TECHNICAL_SPEC.md` | V1 bridge target |

## 2. Target architecture

```
packages/domain-physics/src/vibroacoustics  (@phys/vibroacoustics)   CadPlugin "physics-vibroacoustics", toolset "analysis"
   commands/: define_acoustic_spectrum, delete_acoustic_spectrum, convert_acoustic_spectrum, define_acoustic_exposure,
              acoustic_level, acoustic_spectrum_report, export_acoustic_load, check_acoustic_handoff
   math/:     levels.ts (SPL <-> p, energy sums), bands.ts (IEC 61260-1 base-10 bands, nominal table), psd.ts (band PSD)
        ▼ public core API only; @cae FeaTarget type; 01 KRN face areas via ctx.kernel (export only)
```

Laws: L1/L5 (all registry commands), L2 (no I/O; `--save` is the CLI's job), L3 (pure), L4 (slice
`CadDocument.physics.vibroacoustics`, optional), L8 (feature steps; names as keys), L9 (face areas through
`ctx.kernel`, `requiresKernel` on `export_acoustic_load` only), L10 (plugin).

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-VAC-01 | MUST | Plugin with `document.validate`/`restore` for `physics.vibroacoustics`. |
| TR-VAC-10 | MUST | `levels.ts`: p = p₀·10^(L/20), L = 20 log₁₀(p/p₀), p₀ = 2e-5 Pa for `reference: '20uPa'` (only value accepted in MVP); 1e-12 relative round trip. |
| TR-VAC-11 | MUST | `bands.ts`: G = 10^(3/10), f_r = 1000 Hz; odd b: f_m = f_r G^(x/b); even b: f_r G^((2x+1)/(2b)); edges f_m G^(∓1/(2b)); nominal table 25 Hz…20 kHz (thirds), 31.5 Hz…16 kHz (octaves) as in [R4]; label → x by table lookup, never by rounding. |
| TR-VAC-12 | MUST | Energy sums in double precision: L = 10 log₁₀ Σ 10^(Lᵢ/10); results to 1e-9 dB. |
| TR-VAC-13 | MUST | Band PSD G = p²/(f₂ − f₁) (Pa²/Hz, band-averaged, one-sided); inverse exact. |
| TR-VAC-14 | MUST | Third → octave regrouping requires all three thirds of each octave present (else that octave is omitted and listed); octave → third refused. |
| TR-VAC-20 | MUST | Exposure = spectrum name + 05 `FeaTarget` + `field: 'diffuse' \| 'progressive'` (required) + optional `incidenceDeg` for progressive; export package schema §6. |
| TR-VAC-30 | MUST | Agent-first contract: unit-suffixed fields, provenance, `unverified`, `reviewRequired` on exports, codes §7.1. |

## 3. Data model

```ts
export interface AcousticBand { readonly nominalHz: number; readonly exactMidHz: number; readonly splDb: number }
export interface AcousticSpectrum {
  readonly name: string; readonly bandwidth: 'octave' | 'third_octave'; readonly reference: '20uPa';
  readonly bands: readonly AcousticBand[];                  // sorted by exactMidHz, unique
  readonly source: { readonly citation: string; readonly grade?: 'A' | 'B' | 'C'; readonly url?: string };
  readonly unverified: boolean;                             // true unless grade A
}
export interface AcousticExposure {
  readonly name: string; readonly spectrum: string;
  readonly target: { readonly entityId: string; readonly facesNear: readonly [number, number, number][] };  // 05 FeaTarget subset
  readonly field: 'diffuse' | 'progressive'; readonly incidenceDeg?: number; readonly notes?: string;
}
export interface VibroacousticsModel {          // CadDocument.physics?.vibroacoustics
  readonly spectra: Readonly<Record<string, AcousticSpectrum>>; readonly spectrumOrder: readonly string[];
  readonly exposures: Readonly<Record<string, AcousticExposure>>; readonly exposureOrder: readonly string[];
}
```

No document version change (optional slice, aerospace v3 envelope).

## 4. Commands

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `define_acoustic_spectrum` | mutating | `{ name, bandwidth, reference: '20uPa', bands: [{ nominalHz, splDb }], source }` | @affects spectra · @invariant labels in the nominal table, unique, splDb finite · @failure `VAC_BAND_UNKNOWN`, `VAC_BAND_DUPLICATE`, `VAC_REFERENCE_UNSET`, `VAC_NAME_TAKEN` |
| `delete_acoustic_spectrum` | mutating, destructive | `{ name }` | @failure `VAC_SPECTRUM_IN_USE` (referenced by an exposure) |
| `convert_acoustic_spectrum` | mutating | `{ spectrum, to: 'octave', name }` | @affects spectra (new) · @invariant TR-VAC-14; source copied with "regrouped from <name>" · @failure `VAC_CONVERSION_UNSUPPORTED` |
| `define_acoustic_exposure` | mutating | `{ name, spectrum, target, field, incidenceDeg?, notes? }` | @failure `VAC_SPECTRUM_UNKNOWN`, `VAC_FIELD_UNSET`, 05 `FEA_TARGET_*` |
| `acoustic_level` | query | `{ splDb? \| pRmsPa? \| levelsDb?: number[] }` → `{ pRmsPa, splDb, sumDb }` | pure |
| `acoustic_spectrum_report` | query | `{ spectrum }` → `{ oasplDb, pRmsPa, bands[{ nominalHz, exactMidHz, lowerHz, upperHz, bandwidthHz, splDb, pRmsPa, psdPa2PerHz }], octaves?, unverified }` | pure |
| `export_acoustic_load` | query (`requiresKernel`) | `{ exposure }` → package §6 in `data` (bounded) or `--save` | `reviewRequired: true` |
| `check_acoustic_handoff` | query | `{}` → `{ status, items[] }` | AF-20 |

All descriptions state units (Hz, dB re 20 µPa, Pa, Pa²/Hz) and say that response analysis is out of scope with
the hand-off path (AF-02). A request phrased as a response (`kind: 'sea'` etc. on `export_acoustic_load`) returns
`VAC_OUT_OF_SCOPE`.

## 5. Algorithms

Formulas of TR-VAC-10…14. Worked values (generator): 140 dB = 200 Pa; 1 Pa = 93.9794000867 dB; 1 kHz third:
891.250938134–1122.0184543 Hz, bandwidth 230.767516168 Hz; 27 thirds at 130 dB → OASPL 144.313637642 dB; 130 dB
third at 1 kHz → 17.3334621199 Pa²/Hz. Octave edges equal the outer third edges because
G^(±1/2) = G^(±1/6) · G^(±1/3) (exact in base 10).

## 6. Interop & persistence

Export package (`llull export_acoustic_load … --save x.json`; CSV sidecar for bands):

```json
{
  "schema": "llull.acousticLoad/1", "exposure": "enclosure_skin", "field": "diffuse",
  "spectrum": { "name": "flat130", "bandwidth": "third_octave", "reference": "20uPa", "oasplDb": 144.313637642,
                "bands": [{ "nominalHz": 25, "exactMidHz": 25.1188643151, "splDb": 130, "psdPa2PerHz": 2.75…e3 }] },
  "faces": [{ "entityId": "box-2.1", "faceIndex": 5, "areaMm2": 60000, "centroidMm": [150, 100, 100] }],
  "provenance": { "source": "…", "grade": "A", "documentHash": "…", "llullVersion": "…" },
  "unverified": false, "reviewRequired": true, "reviewReason": "acoustic environment for qualification analysis"
}
```

(Values in the example besides the spectrum ones are illustrative of the shape, not results.)

## 7. CLI / MCP / UI

Registry commands as `llull <command>`; `llull guide` gains a short acoustics section (dB re 20 µPa, band system,
hand-off only). MCP: `analysis` toolset. UI: band chart, highlighted faces, review only.

### 7.1 Stable codes (AF-11)

| Code | Severity | When | Remediation |
| ---- | -------- | ---- | ----------- |
| `VAC_BAND_UNKNOWN` | error | label not in the base-10 nominal table | use the nominal label (e.g. 1000, 1250) |
| `VAC_BAND_DUPLICATE` | error | same band twice | remove the duplicate |
| `VAC_REFERENCE_UNSET` | error | no `reference` | `reference: '20uPa'` |
| `VAC_NAME_TAKEN` | error | name exists | choose another name |
| `VAC_SPECTRUM_UNKNOWN` | error | exposure names a missing spectrum | define it |
| `VAC_SPECTRUM_IN_USE` | error | delete while referenced | delete the exposure first |
| `VAC_CONVERSION_UNSUPPORTED` | error | octave → third, or incomplete octave | supply third-octave data |
| `VAC_FIELD_UNSET` | error | exposure without field type | state `diffuse` or `progressive` |
| `VAC_SPECTRUM_UNVERIFIED` | warning (not suppressible) | grade below A / user data | confirm the source |
| `VAC_EXPOSURE_UNRESOLVED` | error | target faces no longer resolve | fix `facesNear` |
| `VAC_OUT_OF_SCOPE` | error | response (SEA / acoustic FE) requested | export the package to an acoustic analyst |
| `VAC_REVIEW_PENDING` | warning | export used without reviewer disposition | qualified reviewer |

### 7.2 Agent-first compliance

AF-01/02/04 (commands, units), AF-05 (one plan), AF-10/11 (data, codes), AF-12 (`--save` package), AF-13
(pure, deterministic), AF-20 (`check_acoustic_handoff`), AF-31 (no default field type or reference, no library
levels), AF-32/33 (flags), AF-35 (provenance), AF-41 (offline).

## 8. Performance budgets

All commands ≤ 20 ms except `export_acoustic_load` (face areas from the kernel, ≤ 500 ms for 1 000 faces).

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit | levels, bands, PSD, regrouping vs `expected_results.json`; every command happy / failure / `is pure` | 01–12, 30–33 |
| Golden | `plans/vac_flat_spectrum_handoff.plan.json` once commands exist | 06, 12 |
| Contract | tool-schema snapshot; plugin validate / restore | — |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Plugin, data model, spectra commands, math, report, unit tests | PHY-00 harness | 1 w |
| M2 | Exposures, export package (01 KRN face areas), check, guide, golden plan | 05 M1 (targets), 01 KRN | 1 w |
| V1 | Bridge to PHY-09 random pressure load; A-weighting (source to be read) | PHY-09 V1 | 1 w |

## 11. Open questions

1. **Library levels.** Who reads NASA-STD-7001B / GSFC-STD-7000B (and launch-vehicle user's guides) and approves
   library entries? Until then the library is empty (FR-VAC-07).
2. **Package format.** Is a llull JSON schema enough for the target acoustic / SEA tools, or is a specific import
   format needed (tool not chosen)?
3. **Reference values other than 20 µPa** (underwater 1 µPa) — out of scope unless asked.
4. **Bands outside 25 Hz–10 kHz** (thirds up to 20 kHz exist in the nominal table [R4]); allowed in MVP but no
   validation case covers them.

## 12. References

- [R2] IEC 61260-1:2014 — https://www.vde-verlag.de/iec-normen/preview-pdf/info_iec61260-1{ed1.0}b.pdf (catalogue, accessed 2026-10, search)
- [R3] ISO 1683:2015 — https://scc-ccn.ca/standardsdb/standards/8156718 (catalogue, accessed 2026-10, search)
- [R4] acoustic-toolbox (BSD-style licence) — https://github.com/Universite-Gustave-Eiffel/acoustic-toolbox/tree/9ac5f5bd2ff19163330681e424e2ce3e8e8db0b1 (accessed 2026-10)
- [R5] NASA-STD-7001 — https://standards.nasa.gov/standard/NASA/NASA-STD-7001 (accessed 2026-10, search)
- [R6] GSFC-STD-7000B — https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000 (accessed 2026-10, search)
- llull: `.claude/rules/architecture.md`, `../09-structural-dynamics/TECHNICAL_SPEC.md`, `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`
