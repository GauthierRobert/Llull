# PHY-20 VAC: validation pack

Proves [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-VAC-*`) and [`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md)
(`TR-VAC-*`). All numeric values are **derived** by [`generate_acoustic_reference.py`](generate_acoustic_reference.py)
(Python 3 standard library, `python3 -I generate_acoustic_reference.py`, byte-identical on re-run, checked twice on
2026-10-15) from definitions whose sources are in [`sources.md`](sources.md). Every spectrum used here is a
**synthetic test input**, not a test level. No NASA-STD-7001 / GEVS acoustic level is pinned (TBD, VC-VAC-20).

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_acoustic_reference.py` | generator | writes the three files below |
| `expected_results.json` | (b)+(c) | 19 cases VC-VAC-01…35 (PHY README §6.3 schema) |
| `third_octave_bands.csv` | (b) | x, nominal label, exact mid, edges, bandwidth, relative bandwidth, 25 Hz–10 kHz |
| `example_spectrum.csv` | (b) | flat 130 dB third-octave spectrum: p_rms, bandwidth, band PSD |
| `plans/vac_flat_spectrum_handoff.plan.json` | draft plan | spectrum → report → octave regrouping → exposure on a box face → check |

## Validation cases

| VC | Proves | Setup | Expected | Tol. | Grade | Gate |
| -- | ------ | ----- | -------- | ---- | ----- | ---- |
| VC-VAC-01 | FR-VAC-02; TR-VAC-10 | `acoustic_level` 94/120/140/150 dB | 1.00237446725, 20, 200, 632.455532034 Pa | 1e-12 rel | A | unit |
| VC-VAC-02 | FR-VAC-02 | 1 Pa, 1 kPa | 93.9794000867, 153.979400087 dB | 1e-9 dB | A | unit |
| VC-VAC-03 | FR-VAC-03; TR-VAC-11 | third at 1 kHz | 1000, 891.250938134, 1122.0184543, Δf 230.767516168 Hz | 1e-12 rel | A | unit |
| VC-VAC-04 | FR-VAC-03 | relative bandwidths | 0.230767516168 (third), 0.704591760239 (octave) | 1e-12 rel | A | unit |
| VC-VAC-05 | FR-VAC-03 | labels 25 Hz, 10 kHz | exact 25.1188643151, 10000 Hz | 1e-12 rel | A | unit |
| VC-VAC-06 | FR-VAC-04; TR-VAC-12 | 27 thirds at 130 dB | OASPL 144.313637642 dB | 1e-9 dB | A | unit + plan |
| VC-VAC-07 | FR-VAC-04 | 3 equal / 2 equal | +4.7712125472 dB, +3.01029995664 dB | 1e-12 | A | unit |
| VC-VAC-08 | FR-VAC-04 | 120/126/131/128/122 dB | 134.05940141 dB | 1e-9 dB | A | unit |
| VC-VAC-09 | FR-VAC-04 | overall p of VC-VAC-06 two ways | 328.633534503 Pa | 1e-12 rel | A | unit |
| VC-VAC-10 | FR-VAC-05; TR-VAC-13 | 130 dB third at 1 kHz / 100 Hz | 17.3334621199 / 173.334621199 Pa²/Hz | 1e-12 rel | A | unit |
| VC-VAC-11 | FR-VAC-05 | round trip | 130 dB | 1e-9 dB | A | unit |
| VC-VAC-12 | FR-VAC-06; TR-VAC-14 | thirds 128/131/127 → octave 1 kHz | 133.785922887 dB | 1e-9 dB | A | unit |
| VC-VAC-20 | FR-VAC-07 | standard acoustic levels | **TBD** (not read) | — | TBD | none |
| VC-VAC-30…33 | FR-VAC-03/02/08/09/10/11 | wrong band, no reference, unverified export, response request | `VAC_BAND_UNKNOWN`, `VAC_REFERENCE_UNSET`, flags + `VAC_SPECTRUM_UNVERIFIED`, `VAC_OUT_OF_SCOPE` | exact | A | unit + CLI |
| VC-VAC-34 | FR-VAC-12 | V1 PHY-09 pressure load | named correlation assumption (TBD) | exact | A | V1 |
| VC-VAC-35 | TR-VAC-01 | plugin validate / restore, schema snapshot | round trip deep-equal | exact | A | contract |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --json"
llull run plans/vac_flat_spectrum_handoff.plan.json $D > run.json   # report steps carry data (AF-14)
python3 -I compare.py run.json expected_results.json VC-VAC-06
```

## Re-generating

```bash
cd docs/physics/20-vibroacoustics/validation && python3 -I generate_acoustic_reference.py
```
