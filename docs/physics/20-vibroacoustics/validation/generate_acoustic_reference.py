#!/usr/bin/env python3
"""PHY-20 vibro-acoustic hand-off: reference values (Python 3 standard library only).

Run from this folder:  python3 -I generate_acoustic_reference.py   (byte-identical on re-run)

Writes:
  expected_results.json     VC-VAC-xx cases (PHY README section 6.3 schema)
  third_octave_bands.csv    base-10 exact mid-band and edge frequencies (IEC 61260-1 form), nominal labels, bandwidths
  example_spectrum.csv      a synthetic flat 1/3-octave test spectrum (test input, NOT a test level): SPL, p_rms, PSD
"""

import csv
import json
import math

P_REF = 2.0e-5              # Pa, reference sound pressure in air (S3 ISO 1683 catalogue; S4 acoustic-toolbox constant)
G_OCT = 10.0 ** (3.0 / 10.0)  # base-ten octave ratio (S2 IEC 61260-1 as implemented in S4)
F_REF = 1000.0              # Hz reference frequency

NOMINAL_THIRD = [25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0, 500.0, 630.0, 800.0,
                 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0, 6300.0, 8000.0, 10000.0]
NOMINAL_OCTAVE = [31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0]


def r12(x):
    if isinstance(x, (list, tuple)):
        return [r12(v) for v in x]
    if isinstance(x, (str, dict)) or x is None:
        return x
    if x == 0:
        return 0.0
    return float('%.12g' % x)


CASES = []


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    e = {'id': cid, 'quantity': quantity, 'value': r12(value), 'unit': unit, 'tolerance': tol, 'source': source,
         'grade': grade, 'proves': proves}
    e.update(extra)
    CASES.append(e)


def spl_to_p(spl_db):
    return P_REF * 10.0 ** (spl_db / 20.0)


def p_to_spl(p):
    return 20.0 * math.log10(p / P_REF)


def db_sum(levels):
    return 10.0 * math.log10(sum(10.0 ** (l / 10.0) for l in levels))


def exact_mid(x, b):
    """IEC 61260-1 form: odd b -> fr G^(x/b); even b -> fr G^((2x+1)/(2b))."""
    if b % 2:
        return F_REF * G_OCT ** (x / b)
    return F_REF * G_OCT ** ((2 * x + 1) / (2 * b))


def edges(fm, b):
    return fm * G_OCT ** (-1.0 / (2 * b)), fm * G_OCT ** (1.0 / (2 * b))


# --- 1. SPL <-> pressure -----------------------------------------------------------------------------------------
case('VC-VAC-01', 'rms pressure for SPL 94, 120, 140, 150 dB re 20 uPa (p = p0 10^(L/20))', [spl_to_p(l) for l in (94.0, 120.0, 140.0, 150.0)],
     'Pa', {'rel': 1e-12}, 'derived (definition L = 20 log10(p/p0), p0 S3/S4)', 'A', ['FR-VAC-02', 'TR-VAC-10'])
case('VC-VAC-02', 'SPL of 1 Pa and 1 kPa rms', [p_to_spl(1.0), p_to_spl(1000.0)], 'dB re 20 uPa', {'abs': 1e-9},
     'derived', 'A', ['FR-VAC-02', 'TR-VAC-10'])

# --- 2. band frequencies -------------------------------------------------------------------------------------------
xs = list(range(-16, 11))   # 25 Hz ... 10 kHz for b = 3
rows = []
for x, nom in zip(xs, NOMINAL_THIRD):
    fm = exact_mid(x, 3)
    f1, f2 = edges(fm, 3)
    rows.append((x, nom, fm, f1, f2, f2 - f1, (f2 - f1) / fm))
with open('third_octave_bands.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['x', 'nominal_Hz', 'exact_mid_Hz', 'lower_edge_Hz', 'upper_edge_Hz', 'bandwidth_Hz', 'relative_bandwidth'])
    for row in rows:
        w.writerow([row[0], '%g' % row[1]] + ['%.12g' % v for v in row[2:]])
fm1000 = exact_mid(0, 3)
f1_1000, f2_1000 = edges(fm1000, 3)
fm_oct_1000 = exact_mid(0, 1)
case('VC-VAC-03', '1/3-octave band at 1 kHz (x = 0, b = 3): exact mid, lower edge, upper edge, bandwidth', [fm1000, f1_1000, f2_1000, f2_1000 - f1_1000],
     'Hz', {'rel': 1e-12}, 'derived (S2 formulas via S4 implementation)', 'A', ['FR-VAC-03', 'TR-VAC-11'])
rel_bw_third = G_OCT ** (1 / 6) - G_OCT ** (-1 / 6)
rel_bw_oct = G_OCT ** (1 / 2) - G_OCT ** (-1 / 2)
case('VC-VAC-04', 'relative bandwidth (f2 - f1)/fm for 1/3-octave and octave bands (base 10)', [rel_bw_third, rel_bw_oct], '-', {'rel': 1e-12},
     'derived', 'A', ['FR-VAC-03', 'TR-VAC-11'])
case('VC-VAC-05', 'exact mid-band frequency of the 1/3-octave bands labelled 25 Hz and 10 kHz (labels are nominal, S4)', [rows[0][2], rows[-1][2]],
     'Hz', {'rel': 1e-12}, 'derived; nominal labels S4', 'A', ['FR-VAC-03'],
     note='Spectra are stored against exact mid-band frequencies; nominal labels are display only (25 Hz band is 25.1189 Hz).')

# --- 3. OASPL and band combination ---------------------------------------------------------------------------------
flat = [130.0] * len(NOMINAL_THIRD)
oaspl_flat = db_sum(flat)
case('VC-VAC-06', 'OASPL of a synthetic flat spectrum: 27 one-third-octave bands (25 Hz - 10 kHz) at 130 dB each (test input)',
     oaspl_flat, 'dB re 20 uPa', {'abs': 1e-9}, 'derived (energy sum, 130 + 10 log10 27)', 'A', ['FR-VAC-04', 'TR-VAC-12', 'FR-VAC-01'])
case('VC-VAC-07', 'three equal 1/3-octave bands combined into their octave: level increase; two equal sources: increase',
     [db_sum([0.0, 0.0, 0.0]), db_sum([0.0, 0.0])], 'dB', {'abs': 1e-12}, 'derived (10 log10 3, 10 log10 2)', 'A', ['FR-VAC-04', 'TR-VAC-12'])
uneven = [120.0, 126.0, 131.0, 128.0, 122.0]
case('VC-VAC-08', 'OASPL of five unequal bands 120, 126, 131, 128, 122 dB (test input)', db_sum(uneven), 'dB re 20 uPa', {'abs': 1e-9},
     'derived', 'A', ['FR-VAC-04'])
p_oa = spl_to_p(oaspl_flat)
case('VC-VAC-09', 'overall rms pressure of VC-VAC-06 spectrum, and the same from the root-sum-square of band pressures',
     [p_oa, math.sqrt(sum(spl_to_p(l) ** 2 for l in flat))], 'Pa', {'rel': 1e-12}, 'derived', 'A', ['FR-VAC-04', 'TR-VAC-12'])

# --- 4. band SPL -> pressure PSD (band-averaged, one-sided) ----------------------------------------------------------
with open('example_spectrum.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['nominal_Hz', 'exact_mid_Hz', 'spl_dB', 'p_rms_Pa', 'bandwidth_Hz', 'psd_Pa2_per_Hz'])
    for (x, nom, fm, f1, f2, bw, rb), l in zip(rows, flat):
        p = spl_to_p(l)
        w.writerow(['%g' % nom, '%.12g' % fm, '%g' % l, '%.12g' % p, '%.12g' % bw, '%.12g' % (p * p / bw)])
p130 = spl_to_p(130.0)
psd_1000 = p130 ** 2 / (f2_1000 - f1_1000)
psd_100 = p130 ** 2 / (edges(exact_mid(-10, 3), 3)[1] - edges(exact_mid(-10, 3), 3)[0])
case('VC-VAC-10', 'band-averaged pressure PSD of a 130 dB 1/3-octave band at 1 kHz and at 100 Hz (G = p^2 / bandwidth)', [psd_1000, psd_100],
     'Pa^2/Hz', {'rel': 1e-12}, 'derived', 'A', ['FR-VAC-05', 'TR-VAC-13'],
     note='Round trip PSD -> SPL must give 130 dB back (TR-VAC-13); the PSD is band-averaged, not a narrow-band level.')
spl_back = p_to_spl(math.sqrt(psd_1000 * (f2_1000 - f1_1000)))
case('VC-VAC-11', 'round trip SPL -> PSD -> SPL at 1 kHz', spl_back, 'dB re 20 uPa', {'abs': 1e-9}, 'derived', 'A', ['FR-VAC-05', 'TR-VAC-13'])

# --- 5. octave regrouping of third-octave data ------------------------------------------------------------------------
# octave 1 kHz (nominal) = thirds 800, 1000, 1250 (x = -1, 0, 1)
oct_1k = db_sum([128.0, 131.0, 127.0])
case('VC-VAC-12', 'octave band 1 kHz from its thirds 800 / 1000 / 1250 Hz at 128 / 131 / 127 dB (test input)', oct_1k, 'dB re 20 uPa',
     {'abs': 1e-9}, 'derived', 'A', ['FR-VAC-06', 'TR-VAC-14'],
     octaveMidHz=r12(fm_oct_1000), note='Octave edges coincide with the outer third edges (G^(+-1/2) = G^(+-1/6 +- 1/3)).')

# --- 6. Quoted / scope items -----------------------------------------------------------------------------------------
case('VC-VAC-20', 'NASA-STD-7001 / GEVS acoustic test levels (any band value)', 'TBD', 'dB re 20 uPa', {'abs': 0},
     'S5 (NASA-STD-7001B supersedes A, 2017: scope only, values not seen); S6 GSFC-STD-7000B (catalogue)', 'TBD', ['FR-VAC-07'],
     note='No level is shipped until a human reads the standard; library entries stay empty (TECHNICAL_SPEC open question 1).')
for cid, what, expect, proves in (
        ('VC-VAC-30', 'define_acoustic_spectrum with a non-standard band centre', {'exit': 1, 'code': 'VAC_BAND_UNKNOWN'}, ['FR-VAC-03', 'FR-VAC-10']),
        ('VC-VAC-31', 'spectrum without a reference statement', {'exit': 1, 'code': 'VAC_REFERENCE_UNSET'}, ['FR-VAC-02', 'FR-VAC-10']),
        ('VC-VAC-32', 'export_acoustic_load of a grade-B / user spectrum', {'unverified': True, 'reviewRequired': True,
                                                                            'warning': 'VAC_SPECTRUM_UNVERIFIED'}, ['FR-VAC-08', 'FR-VAC-09', 'TR-VAC-20', 'TR-VAC-30']),
        ('VC-VAC-34', 'V1: exposure as a PHY-09 random-pressure load with the correlation assumption named (TBD)', {'assumption': 'fully correlated'},
         ['FR-VAC-12']),
        ('VC-VAC-35', 'plugin contract: validate/restore round trip, toolSchemas snapshot', {'roundTripDeepEqual': True}, ['TR-VAC-01']),
        ('VC-VAC-33', 'request for an SEA / acoustic-FE response', {'exit': 1, 'code': 'VAC_OUT_OF_SCOPE'}, ['FR-VAC-11'])):
    case(cid, what, expect, '-', {'abs': 0}, 'TECHNICAL_SPEC section 7.1', 'A', proves, note='behaviour case')

with open('expected_results.json', 'w') as fh:
    json.dump({'pack': '20-vibroacoustics', 'generatedBy': 'generate_acoustic_reference.py', 'cases': CASES}, fh, indent=1, ensure_ascii=False)
    fh.write('\n')
