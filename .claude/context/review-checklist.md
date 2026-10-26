# Review checklist (self-review before `cad-reviewer`)

Distilled from the 141 review-fix commits of 2026-10-12..26: almost every milestone took 1–3 review rounds, and the findings fell
into the same classes again and again. Walk this list against your diff BEFORE handing it to review; the contract suites named
below catch most of it mechanically, so run them first. `cad-reviewer` checks the same list.

## 0. Run the contract suites for what you touched

- New / changed plugin document slice → `npx vitest run tests/unit/contract/pluginSliceFuzz.test.ts` (and add the plugin's seed
  if it is new: the suite fails naming a plugin without one).
- New / changed reader of external text or bytes (any import, parser, regex built from user text) → `npx vitest run
  tests/unit/contract/hostileInput.test.ts` (register the reader in `tests/helpers/hostileReaders.ts`: the suite fails naming an
  unregistered `import_*` / `load_*` / `read_*` command).
- New command or entity / slice relation → the lifecycle properties of the action matrix (`npx vitest run tests/action_matrix`)
  and a corpus design that exercises it.

## 1. Load validation (most frequent finding)

- Every field you added to a document slice is validated on load: type, enum, range, finite numbers, required vs optional.
- Record keys: reserved names (`__proto__`, `constructor`, `prototype`) refused; a record's `id` equals its key; ids unique.
- Cross references checked both ways (A lists B ⇔ B points at A), dangling ids refused, duplicates counted on the id-keyed map.
- Refusal names the path (`plant.pid.sheets.S1.number: …`). New slices: declare a zod schema through
  `packages/core/src/plugins/sliceSchema.ts` instead of hand-written checks.

## 2. Untrusted input

- Linear time at any size and nesting depth: no rescans inside loops, no `indexOf`/`slice` per character, no string `+=` building in a
  hot loop, no regex with nested quantifiers (reject user patterns that have them).
- Encodings: BOM, CRLF / CR-only (positions stay exact), lone surrogates, NUL, invalid UTF-8; numbers `1e309`, `NaN`, `-0`.
- Size and count caps with a named refusal; never throw past the command (findings or a refusal instead).

## 3. Lifecycle (replay, undo, delete, clear, load)

- The result survives history replay (ids included): slices a replay must keep go through `carry` / `replaySeed`; minted identity
  through `mintedIdentity`.
- Undo restores exactly; `clear_document` leaves no slice state behind.
- Deleting something others reference either cascades (derived runs, supports, welds, branches) or is refused by name: no orphans.
- An edit of an upstream slice re-derives downstream geometry (`reconcile`), and a second reconcile is a no-op.
- Derived entities equal what a load re-derives.

## 4. Ids, units, numbers

- Ids from `ctx.ids` / `nextId` (step-scoped, deterministic); never `Date.now()` or random.
- Lengths in mm internally; imported files keep their declared units and convert once; inch sizes stay nominal where the standard
  says so (NPS). One tolerance rule per concept, not a new literal per call site.

## 5. Outcomes the agent reads

- A refusal returns the unchanged document; multi-item operations are all-or-nothing or report exact per-item outcomes (counts over
  every requested item, failed ones named).
- `description` / `.describe()` texts are self-sufficient; `summary` carries ids, counts and sizes; failure codes are named.
- The tool-schema snapshot diff is intended and explained.

## 6. Gates and trust (PLM, review, export)

- Human gates are bound to the exact object they approve and re-verified when read; verification is a pure query.
- Export gates apply on every export path, not only the one you added.

## 7. Tests and spec

- Happy + failure + `is pure` per command; real timeouts and budgets are tested, not mocked away; no wall-clock assertions (relative
  ratios with slack when timing is the property).
- The domain spec's "as built" section and decided open questions are updated in the same change.
