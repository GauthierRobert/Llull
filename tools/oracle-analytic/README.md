# oracle-analytic

Closed-form expectations for the oracle suite (`tests/oracle/<nn-name>/{plan.json, expected.json}`, task SC-Q1). No llull code is
imported: volume, area, centroid and bbox come from textbook formulas (`formulas.mjs`, `revolve.mjs`: Pappus-Guldin, Steiner, Steinmetz,
spherical caps and lenses, shoelace polygons, quarter-annulus centroids).

```bash
node tools/oracle-analytic/generate.mjs   # rewrites tests/oracle/*/plan.json + expected.json (LF)
```

`generate.mjs` writes both files of each case so the plan parameters and the formula variables stay together. The vitest suites only read the
JSON. The first implementation is Node (`.mjs`) because no Python interpreter was available when it was written; a stdlib-only Python port
(`python -I tools/oracle-analytic/generate.py`) must produce byte-identical JSON. Each case file (`cases*.mjs`) covers one family.

Mesh kernels: a case with curved surfaces carries `meshTolerance` (volume/area relative) with the reason. For cylinders the bound is the
inscribed n-gon loss `k (1 - cos(pi/n))` (n from Manifold's default circle resolution), for spheres a 3 % envelope. The exact OCCT run ignores it.
