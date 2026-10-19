# Action matrix (SC-Q2)

For every design of the corpus (`tests/oracle/*/plan.json`, `tests/golden/plans.ts`, `quality/drawings/plans/*.json`: 164 designs) the
matrix builds the design with `build_project`, enumerates the actions a user could try on it and runs each through `execute` with the
params the UI sends. The outcome of every `design|command|target` is compared with `tests/action_matrix/baseline.json`, a ratchet.

## Outcomes

| outcome       | meaning                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          | the document changed and the result is sound: finite numbers, a watertight mesh, positive volume, the volume relation holds                                                            |
| `refused`     | a clean no-op: unchanged document, a summary saying why                                                                                                                                |
| `unsupported` | the kernel lacks the operation (Manifold cannot fillet / chamfer / shell, has no B-rep); kept apart from `refused`                                                                     |
| `error`       | a finding: a throw (`CMD_THREW`), a non-finite number, an invalid solid (open mesh, volume <= 0, volume relation broken), a purity breach, or a refused call that changed the document |

Volume relations: `a - b <= a`; `a + b` between `max(a, b)` and `a + b`; `a & b <= min(a, b)`; a hole, fillet, chamfer or shell never
grows the part (2 % slack for tessellated curves).

## Actions

Per body (first 6 of a design): `fillet_edge` and `chamfer_edge` on each edge (`edgeIndices` from `inspect_topology`, size 10 % of the
smallest extent), `shell_solid` open on each face (`openFacesNear` from `inspect_faces`), `add_hole` through each face
(`face.near` + a `world` point, diameter 25 % of the smallest extent), `boolean` union / subtract / intersect for every body pair.
On every entity (first 8): `move_entities`, `rotate_entity`, `mirror_entity`, `array_linear`, `array_polar`. A mesh kernel has no B-rep,
so each body gets one whole-body target (`id#*`) for fillet / chamfer / shell and its six bounding-box faces for holes. There is no
draft command and no command that takes a vertex, so neither is enumerated.

Each design is capped at 120 actions (full mode) or 40 (PR mode), chosen by a stable seeded hash of the key, so a key is in or out
independent of enumeration order.

## Running

```bash
npm test                                  # PR mode: 1-in-6 designs, <= 40 actions each, checked against the baseline (a few seconds)
npm run action-matrix                     # full mode, whole corpus (~40 s on the Manifold kernel)
npm run action-matrix -- --shard 1/4 --costs node_modules/.cache/action-matrix/cost.json   # one shard, balanced by measured ms
npm run action-matrix -- --determinism --design-sample 12   # runs the sample twice: outcomes, affected ids and volumes bit for bit
npm run action-matrix -- --bless          # rewrite the baseline from this run (review the diff of baseline.json)
npm run action-matrix -- --native         # the native OCCT column (server/tests/actionMatrix.test.ts; skipped without llull-kernel)
node scripts/actionMatrixReport.mjs node_modules/.cache/action-matrix/report.json   # histogram, findings, slowest designs
```

Environment variables behind the flags are listed in `tests/action_matrix/config.ts` (`ACTION_MATRIX_BLESS=1`, `ACTION_MATRIX_MODE=full`, ...).
The nightly job `.github/workflows/action-matrix.yml` runs 4 shards (balanced by the previous run's cost file) and a determinism job.

## The ratchet

`baseline.json` has one column per kernel (`manifold`, later `occt`), each with `entries` (key -> `ok` | `refused` | `unsupported`) and
`knownErrors` (key -> reason, a quarantined finding). The test fails when

- an action that was `ok` is not `ok` any more (or, for a design run completely, is no longer produced);
- an `error` row is not in `knownErrors`; a throw can never be quarantined (`--bless` skips it, the test keeps failing).

New passes (`refused` -> `ok`, new keys that are `ok`) are logged; `--bless` records them. Bless replaces the entries of the designs that
ran completely and merges the others, and keeps the other kernel's column.

## Current counts (Manifold column, full mode)

164 designs (149 build, 15 need the native kernel: their plan fillets or shells), 4800 actions.

| outcome       | count |
| ------------- | ----- |
| `ok`          | 2772  |
| `refused`     | 1336  |
| `unsupported` | 688   |
| `error`       | 4     |

The `native OCCT` column is empty until the binary is built on a machine that blesses it.

## Findings (quarantined in `knownErrors`)

- `golden/building_shell_from_primitives`: `boolean intersect` of `box-N.1` (N = 2..5) with `box-6.1` creates a 4-triangle zero-volume mesh
  entity instead of refusing. Reproduction: a box `size [10, 0.3, 3]` at `[0, 0, 1.5]` (z 0..3) and a box `size [10.3, 8.3, 0.2]` at
  `[0, 4, 3.1]` (z 3.0000000000000004..3.2): they touch within rounding, the intersection is a flat sheet, `boolean` reports
  "merged ... into mesh" with a zero-volume result. Exactly face-touching boxes are refused correctly ("no usable mesh").
