# Design language (`.lld`) — v1.0 (as built)

A text front end for agents: one line per feature, named things, relative placement, parameters, loops and inline checks, over the
whole command registry. It lives in a **removable plugin** (`packages/design-lang`, toolset `design`). Core gains nothing from it, and
deleting the package leaves the app and the CLI intact. There is **no backward compatibility**: documents built with `.lld` need the
plugin, and the language may change.

Quick start: `llull describe_design_syntax` (the guide) · `llull describe_design_syntax command=add_hole` (one command's line) ·
`packages/design-lang/examples/<toolset>.lld` (a working example per toolset).

```
design bracket units=mm
param t = 6mm
param w = 80mm

add_box  base    size=[120, w, t]  position=[0, 0, t/2]
add_box  upright size=[120, t, 60]  on=base.top align=back
boolean  body    op=union a=base b=upright
add_hole drilled target=body face=base.bottom pointsFrame=world_xy points=[[-45, -(w/2-15)], [45, -(w/2-15)]] hole.kind=simple hole.diameter=8mm extent.kind=through_all

check bbox   of=drilled expect == [120, w, 66] ± 0.01
check volume of=drilled expect ~= 120*w*t + 120*t*60 - 2*pi*16*t ± 1%
```

```bash
llull apply_design source=@text:bracket.lld [set='{"w":100}'] [--app]   # build (failures name the line; checks report)
llull set_parameter name=w expression=100                                 # the whole design regenerates
llull check_design                                                        # gate: exit 1 when a check fails
llull export_design --save bracket.lld                                    # the source, verbatim
```

## 1. The recipe is the source

A design is ONE feature step, `design_source { source, reads }`, whose params are the `.lld` text. Every regeneration
(`set_parameter`, `edit_step_params`, `replay_history`, undo, load) re-runs the whole source through `execute`, inside that step:

- Ids are minted in the step (`box-<n>.1`, …) and stay the same across regenerations, so UI steps recorded after the design (a
  `move_entities` on its result) still apply.
- Anchors resolve against the geometry of each run. Nothing is frozen.
- `param w = 80` is a **default**. An existing parameter (`set_parameter`, `apply_design set=`) wins. `apply_design`, which is metaHistory,
  writes the defaults before recording the step, so the step only reads parameters (L8).
- `reads: { w: "=w" }` makes core's dependency tracking (`history/dependents.ts`) regenerate the step when `w` changes.
- Regeneration hygiene (`regenerate.ts`). Replay keeps the materials and components no step creates *by name*, and the joints,
  constraints and drive relations no step lists in `affected`. The design creates them through nested commands, so:
  - the step lists the keys it added to the joint / constraint / drive-relation tables in its `affected`;
  - on a regeneration of a design whose commands touch materials or components, a clean pass (own id source, so ids are unaffected)
    finds the materials and components the design creates, and those are removed from the input before the real run. A design that
    needs materials from outside itself cannot run clean, so the input is kept as is.

  A design can therefore use explicit ids (`componentId=plate_c`, `add_material_model id=elastic`) and regenerate cleanly.
- One design per document. `apply_design` on a document that has one replaces its step (`edit_step_params`). If that step is
  suppressed, `apply_design` refuses (unsuppress or delete it first) rather than adding a second design.
- A design line is a **mutating, recorded** command. Read-only commands belong in `check` lines. metaHistory / session commands
  (`set_parameter`, configurations, recipes, the view, history editing, `build_project`…) are refused: from inside a recorded step they
  would write document inputs (L8) that replay discards, or edit the history being replayed. Parameters are declared with `param`;
  configurations and recipes are created after `apply_design`.

Trade-off: the UI history shows one step per design, and a change re-runs all of it. Measured cost (§10): about 2× a `build_project`
plan, tens of milliseconds for 200 commands, so the `component` splitting planned in v0.3 was not needed.

## 2. Removability

| Rule | Enforced by |
| --- | --- |
| Only `src/app/plugins.ts` imports `@design` | dependency-cruiser `design-lang-is-removable` + `tests/unit/design/contract.test.ts` |
| The plugin sees core only through the public plugin API (`model`, `lib`, `geometry`, `plugins/plugin`, `commands/{schema,types,noop,registry}`) | dependency-cruiser `plugins-use-the-core-public-api` (design-lang added) |
| Nothing `.lld`-specific outside the package; the CLI gained only the generic `@text:` | review |

Removal:
1. Delete `packages/design-lang/`, `tests/unit/design/` and `server/tests/occtDesignAnchors.test.ts`.
2. Remove the `installPlugin(designPlugin)` line and its import (`src/app/plugins.ts`).
3. Remove the `@design` alias (`tsconfig.base.json`) and the `server/tsconfig.json` include.
4. Remove the `design` toolset getter and name (`packages/protocol/src/toolsets.ts`) and its palette label
   (`src/ui/components/commandPalette/paletteItems.ts`).
5. Remove `design-lang` from the dependency-cruiser rules and the coverage threshold (`vite.config.ts`).
6. Remove the `.lld` paragraphs of the `design-model` / `llull-cli` skills and the CLAUDE.md layer-map line.
7. Run `npm run check`.

`@text:` stays: it is generic.

## 3. Package

```
packages/design-lang/src/
  lexer.ts        lines without comments, top-level splitting (quotes, brackets)
  parse.ts        text -> statements (header, param, command, check, for); syntax errors with their line
  schemaValue.ts  value + target param schema -> template (number / expression / name / anchor / JSON)
  units.ts        unit literals; ANGLE_PARAMS (radian / degree params, contract-tested)
  run.ts          interpreter: aliases (records + geometry), loops, placement, consumption, hints
  anchors.ts      frames (AABB), exact face picking (inspect_faces, OCC), placement delta
  checks.ts       metrics + generic read-only checks, paths, tolerances
  regenerate.ts   regeneration hygiene (§1)
  commands.ts     apply_design, design_source, check_design, export_design
  syntax.ts       describe_design_syntax (guide + generated command lines)
  errors.ts       DesignError, attempt(), CommandError mapping
examples/         one .lld per toolset (tests/unit/design/examples.test.ts runs them all)
```

## 4. Grammar

```ebnf
line      = [ statement ] [ "#" comment ] ;                (* "#" starts a comment at line start or after a space *)
statement = header | param | command | check | for | "}" ;
header    = "design" NAME [ "units=" UNIT ] ;             (* first statement; sets the document unit *)
param     = "param" NAME "=" expr ;                        (* a default *)
command   = COMMAND [ ALIAS | "_" ] { key "=" value } ;    (* any mutating registered command *)
for       = "for" NAME "in" expr ".." expr "{" ;           (* inclusive; closed by a "}" line *)
check     = "check" (METRIC | READ_ONLY_COMMAND) { key "=" value } "expect" OP value [ "±" NUMBER [ "%" | UNIT ] ] ;
key       = NAME { "." NAME } ;                            (* dotted keys fill object params *)
value     = NUMBER-or-EXPR | NAME | ALIAS "." SIDE | ALIAS "[" INT "]" | "[" value { "," value } "]" | STRING | JSON-object | true | false ;
ALIAS     = NAME with optional {expr} placeholders: post{i}
OP        = "==" | "~=" | "<=" | ">=" | "<" | ">" ;
```

- A `key=value` pair has no spaces outside `( ) [ ] { } "…"`. Expected values and tolerances in a check may have spaces, and
  `[1,2,3]±1%` is accepted.
- Reserved words: `design param check expect for in`. A contract test checks none is a command name.
- `expect` on a command line is a syntax error pointing to `check`. A duplicate key is refused.

## 5. Values: read by the target param's schema

| Target param | Bare word | Number / expression | Other |
| --- | --- | --- | --- |
| enum | the member (else `DESIGN_BAD_ENUM` listing the members) | — | — |
| string | the alias's first live id when the word is an alias, else the text | — | `"quoted text"` |
| number | a parameter / loop variable | constants fold; otherwise evaluated per run | units: `6mm` `3.2m` `2in` → document unit |
| array of numbers | — | per item | `alias.side` → the anchor point `[x, y, z]` |
| array | an alias expands to all its live ids | per item | — |
| object with `near` | — | — | `alias.side` → `{ near: point }` |
| object | — | — | dotted keys (`hole.kind=simple`); free-form records accept any key; unions: JSON `{…}` |
| union | branch chosen by the value's shape | | |

- Expressions: `+ - * / ( )`, `pow mod sqrt abs min max floor ceil round trunc sign exp ln log10 hypot sin cos tan asin acos atan atan2`,
  `pi`. `^` and `%` are refused with a pointer to `pow` / `mod`.
- Angles: `45deg`, `0.5rad` only on the params listed in `ANGLE_PARAMS`, whose unit (radians / degrees, checked against the param
  description) the schema does not carry.
- SI-named params: a param ending in `M` (`throatDiameterM`) takes length literals in metres, `…Mm` in millimetres.

## 6. Aliases, anchors, placement

- An alias names what its line made. If the line made records (non-entity ids in `affected` and in `data.*Id(s)`: walls, pipes,
  surfaces, manholes, fastener stacks…), the alias names those. Otherwise it names the entities the line created. Otherwise it names
  what the line changed.
- Its **geometry** is its created entities: those derived from its records (`wall-1:body-0`) when it has both. Anchors and the
  bbox / volume metrics measure the geometry.
- `alias[i]` picks one id. A line whose command reports no id cannot take an alias (`create_material _ name="steel"` is then referred to
  by name).
- Consumption: an entity a later line deletes (boolean operands, drilled targets) is consumed. Using its alias as an entity is
  `DESIGN_ALIAS_CONSUMED`, and the hint names the live alias that finally holds it. As an anchor it still works, from the box it had when
  consumed.
- Anchors `alias.side`, with sides `top bottom front back left right center` (= +Z −Z −Y +Y −X +X):
  - on one live solid with the OCC kernel: a point inside the outermost planar face facing that side (`inspect_faces`);
  - otherwise the centre of that side of the bounding box. On a composite solid that point can miss the face, and the failure says so,
    pointing to the operand anchor, an explicit `face.near=[x,y,z]` or the OCC kernel (`server/tests/occtDesignAnchors.test.ts`).
- `on=alias.side [align=front|back|left|right|top|bottom]`: whatever the line creates is moved so that its opposite side sits on that
  face, centred or flush. This works for any kind (one `move_entities`, inside the step). A command that already owns a param named `on`
  or `align` keeps it (contract-tested: `calibrate_underlay`).

## 7. Checks

`check <metric> of=<alias> [path=…] [query params…] expect <op> <value> [± tol]`, or
`check <read-only command> <params…> path=<key.key.0> expect <op> <value>`.

| Metric | Query | Value |
| --- | --- | --- |
| `bbox` / `size`, `min`, `max` | `measure_bounding_box` | `[x, y, z]` (`path=1` picks one component) |
| `volume` | `mass_properties` | volume |
| `mass` | `mass_properties` (`massUnit` from the expected `kg` / `g` / `lb`; `density=` passes through) | mass |
| `dof` | `check_mechanism` | mobility |
| `hard_interferences` | `check_assembly` | count of `FPR_PAIR_HARD` |
| `issues` | `check_model` | count |

- `path=` is inside `data`. A leading `data.` is accepted. A key that is an alias name reads that alias's id when the literal key is
  absent (`path=bodies.wheel.massKg`).
- An unresolved path fails the check with a note naming where it stops and the keys there.
- Expected values: numbers and expressions over parameters (units allowed), `[lists]`, `true` / `false`, `"text"`.
- Tolerances: `== → 1e-6 × max(1, |expected|)`, `~= → 1 %`. `~= 0` needs an explicit `± tol`. `± 2%` is relative; `± 0.1mm` is absolute
  and converted.
- `apply_design` and regenerations **report** checks (`data.checks[]`: line, metric, of, op, expected, actual, tolerance, pass, note).
  `check_design` **gates**: `error.code = DESIGN_CHECK_FAILED`, so the CLI exits 1. It re-runs the design in a sandbox to recover the
  alias ids: a replay-like start and a first-apply start, keeping the one whose ids are the document's; outside materials are tried only if
  both fail. Then it evaluates the checks on the current document, after any later edits.

## 8. Commands (toolset `design`)

| Command | Annotations | Role |
| --- | --- | --- |
| `apply_design { source, set? }` | metaHistory | units + param defaults, then records (or replaces) the `design_source` step; `data { checks, aliases }` |
| `design_source { source, reads }` | requiresKernel | the recorded step (do not call directly); a regeneration without kernel is refused, never silently empty |
| `check_design {}` | readOnly | evaluates the design's checks on the current document; gates |
| `export_design {}` | readOnly | `data { text, fileName }` (`--save x.lld`) |
| `describe_design_syntax { command? }` | readOnly | the guide, or one command's generated line (read-only commands as `check …`) |

A design may not call these commands, nor a read-only or metaHistory command as a line (§1).

CLI: the only addition is the generic `@text:PATH` (`server/src/cli/fileParams.ts`, next to `@img:`), which reads a file as a string value.

## 9. Errors

Every error names its line (`error.paths = ["line N"]`), the offending text and one fix: `DESIGN_SYNTAX`, `DESIGN_UNKNOWN_COMMAND`
(+ close names), `DESIGN_UNKNOWN_PARAM` (+ the params), `DESIGN_BAD_VALUE`, `DESIGN_BAD_ENUM` (+ members), `DESIGN_UNKNOWN_ALIAS` /
`DESIGN_UNKNOWN_ANCHOR` / `DESIGN_UNKNOWN_PARAMETER` (+ close names), `DESIGN_ALIAS_CONSUMED` (+ live heir), `DESIGN_UNIT_NOT_SUPPORTED`,
`DESIGN_LOOP_LIMIT` (1000 iterations per loop, 5000 commands, 1000 checks), `DESIGN_STEP_FAILED` (the command's own refusal and remediation),
`DESIGN_CHECK_FAILED`, `DESIGN_NO_DESIGN`. A design that runs no command is refused (`DESIGN_SYNTAX`). Any failure leaves the document unchanged. A failure during a regeneration surfaces as
core's `HIST_STEP_FAILED`, naming the design line.

## 10. Validation

**Evaluation (go / no-go, 2026-10-19).** Fresh agents did the same 6 modelling tasks (plate with holes, bracket, flange with a bolt
circle, extruded profile, parametric posts regenerated by `set_parameter`, enclosure): one in `build_project` JSON, one in `.lld`,
and one in CadQuery imported with `import_code`. Every attempt was logged.

| | First-attempt success | Attempts | Final artifact size | Agent tokens | Editable in llull |
| --- | --- | --- | --- | --- | --- |
| JSON plan | 5 / 6 | 7 | 3 980 chars | 85 k | 6 / 6 |
| `.lld` | **6 / 6** | **6** | **2 190 chars (−45 %)** | **68 k (−20 %)** | **6 / 6** |
| CadQuery + `import_code` | 6 / 6 | 6 | ~1 600 chars of model code; 26 500 with the llull runtime task 5 needs | 79 k | 1 / 6 |

CadQuery is the most compact for one-shot shapes (agents know it well), but a plain script imports as a frozen mesh. Only task 5,
written with llull's ~25 kB CadQuery runtime, stayed editable, and because that runtime records an unrolled trace, the post count
needed 12 fixed slots clamped with `min(i, n-1)`. It also needs code execution enabled and a Python with CadQuery. Decision: `.lld` is
the default agent path; CadQuery stays an exchange format (`export_code` / `import_code`).

Go: the size criterion (≥ −40 %) is met. The JSON agent's one failure was the parametric task: aliases do not survive replay across
top-level plan steps. One `.lld` step avoids that by construction. The sample is small (6 tasks), so treat this as an indication, not a
measurement.

**Examples.** Three agents wrote one example per toolset (18) through the CLI and reported every friction point. All points were fixed,
and the hard-coded ids and `replace=true` workarounds were removed from the examples. Each example applies, passes its checks, passes
`check_design`, and regenerates (`replay_history`) with its checks still passing.

**Performance** (`tests/unit/design/performance.test.ts`, 200 commands, Manifold). Apply: about 80 ms against 36 ms for the same
`build_project` plan. Regenerate after `set_parameter`: about 58 ms against 27 ms. Source size: 10 kB against 20 kB.

**Review.** A `cad-reviewer` audit found one blocking issue (metaHistory lines, fixed: §1) and five non-blocking ones, all fixed:
a suppressed design, the check limit, an empty design, the clean pass gate and its fallback test, and the sandbox runs.

**Tests.** `tests/unit/design/*` (108 tests) and `server/tests/occtDesignAnchors.test.ts` (exact faces). Coverage of `packages/design-lang`:
98 / 90 / 99.5 / 99.

## 11. Known limits

- The bounding-box anchor fallback (Manifold) can miss the face of a composite solid (§6).
- `create_component` reports only the instance it creates, so a design that inserts more instances of it must give
  `componentId=` explicitly.
- Prose enums: params that take one of a few words but are typed as plain strings, such as `align.edge` and `mirror_entity.axis`. Their
  typos are caught by the command itself, not by the language.
- Pre-existing in core, not the language: a command that mints ids for document-level inputs (e.g. `import_dxf` creating a layer) gets
  different ids after a replay, because the layer is carried. UI steps that reference those ids by value break. Aliases inside the
  design are unaffected.

## 12. History

v0.1–v0.3 were validated by a throwaway POC (deleted).
- v1 compiled the design to `build_project`, expanding the history; anchors were symbolic expressions. It was rejected: the history
  became unreadable and anchors only worked on boxes.
- v2 (adopted, without backward compatibility) made the source itself the recipe.
