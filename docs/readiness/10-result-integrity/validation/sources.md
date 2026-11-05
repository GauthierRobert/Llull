# 10 INT — Sources

Grades as in [`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md). Accessed 2026-11-05. Code references are to main
00d5326f5 and are grade A (read in llull's code).

| Id | Source | Taken | Grade |
| -- | ------ | ----- | ----- |
| S1 | EN 10025-2 grade designation (Sxxx = minimum yield strength in N/mm² at the smallest thickness band) | S235 → 235 N/mm² for t ≤ 16 mm (and ≤ 40 mm in the EN 1993-1-1 Table 3.1 simplification) | A (designation system) |
| S2 | EN 1993-1-1:2005 Table 3.1 and EN 1993-1-8:2005 Table 3.1 / 3.4 (fy bands; fub by class; αv = 0.6 for 4.6, 5.6, 8.8 and 0.5 for 6.8, 10.9; k2 = 0.9; γM2 = 1.25 recommended) | values as quoted in common secondary extracts; **standard text not read in this session** (pack 07 D7 purchase) | B |
| S3 | ISO 898-1 tensile stress area As = (π/4)·(d − 0.9382·P)², coarse pitch P | M18 (P 2.5): 192.5 → 192 mm²; M20 (P 2.5): 244.8 → 245 mm² | A (cited closed form) |
| S4 | AASHTO, A Policy on Geometric Design of Highways and Streets: minimum radius Rmin = V² / (127·(e + f)), V in km/h | closed form; the f values of llull's table stay unsourced (pack 07 VNV, D7) | A formula / f not graded |
| S5 | Euler–Bernoulli tip deflection δ = PL³ / (3EI), Timoshenko shear term PL / (κGA), κ = 5/6 | L 1000, b 20, h 50 mm, E 210 GPa, G = E/2.6: δ_EB = 7.619 mm, + 0.0149 mm shear = 7.634 mm | A (closed form) |
| C1 | llull code at 00d5326f5: `guard.ts:117-148`, `steelDesign.ts:8-34`, `roadChecks.ts:18-27`, `adequacy.ts:1-40`, `geometryKernel.ts:80-96`, `layers.ts:1-4`, `security.ts:13,131-159`, `zipRead.ts:13-26`, `feaSolve.ts:77`, `verify.ts:85-93`, `useLiveDocument.ts:63` | defects G1–G13 of FUNCTIONAL_SPEC §2 | A |
