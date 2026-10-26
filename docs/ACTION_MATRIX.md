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

165 designs (15 of them need the native kernel: their plan fillets or shells), 4821 actions.

| outcome       | count |
| ------------- | ----- |
| `ok`          | 2793  |
| `refused`     | 1340  |
| `unsupported` | 688   |
| `error`       | 0     |

The `native OCCT` column is empty until the binary is built on a machine that blesses it.

## Findings (quarantined in `knownErrors`)

None. The former finding (a `boolean intersect` of boxes that touch within rounding left a flat zero-volume sheet) is fixed: `boolean` refuses any result that is flat or encloses no volume (`tests/golden/golden.kernel.test.ts`).

## Lifecycle contract

`tests/action_matrix/lifecycle.test.ts` (checks in `lifecycleChecks.ts`, designs in `lifecycleCorpus.ts`) runs the state-through-lifecycle
properties on the same corpus plus the golden plan sets of the plugins (fea, composite, constraint, deform, implicit, piping, plm) and one seed
document per plugin with a document slice (`tests/helpers/pluginSliceSeeds.ts`). PR mode: the same 1-in-6 design sample as the matrix plus every
seed; `npm run action-matrix` (full) runs every design. For each design, and for the document after a few `ok` actions:

- save -> load (the real persistence path) is equal to the document, draw order included, and validates;
- `replay_history` equals the live document (ids too; only the step counter is ignored) and its id tables are sound;
- undo of the applied changes, then redo, restore the exact start and end documents (the snapshot-stack rule of `@protocol/history`);
- delete the first N entities and, through each registered `delete_* / remove_*` command that takes one id, plugin-owned definitions: the result
  loads, a second `reconcile` changes nothing, its replay equals it, and the core reference tables (groups, components, constraints, joints,
  drive relations, animations) hold no reference to the deleted id;
- `clear_document` then load: validates, no slice survives;
- id hygiene: entity / table ids unique and never `__proto__` / nested `constructor` / `prototype`; keys equal their record's `id`; every `*Order`
  list and the selection point at existing records.

Plugin slices that keep a stale record for a deleted entity on purpose (aero, composites, cfd, piping port refs, dimensions) are not enforced.
A finding that is recorded rather than fixed goes in `tests/action_matrix/lifecycleKnown.ts` (key -> reason); the full run also fails on an
entry that no longer occurs. The suite fails naming any plugin with a document extension and commands that no design exercises.

## Hostile-input harness

`tests/unit/contract/hostileInput.test.ts` (table in `tests/helpers/hostileReaders.ts`, families in `tests/helpers/hostile/`) feeds every reader of
untrusted text or bytes (XML, Part 21, IGES, DXF, meshes, OP2, PCF, JSON catalogs, `.lld`, units, expressions, ...) empty, truncated, NUL,
surrogate, CR / CRLF, non-finite-number, deeply nested and very large inputs, and checks that it never throws and reads in linear time. A new
`import_*` / `load_*` / `read_*` command or exported `read*` / `parse*` function that is in neither the table nor `exclusions.ts` fails the suite.
PR mode (default, about 18 s): the cheap structural cases and the format-specific extras (the regression cases of fixed defects) for every
reader; the 2 MB / 20k-record / 2e5-nesting cases and the linearity ratio for a seeded 1-in-6 sample of readers (name hash, like the matrix).
Full mode, nightly in the `action-matrix` workflow: `HOSTILE_FULL=1 npx vitest run tests/unit/contract/hostileInput.test.ts` (about 90 s).
