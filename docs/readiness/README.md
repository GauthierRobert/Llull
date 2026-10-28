# Professional readiness — gap analysis and specifications

Status: specifications and validation packs written 2026-10-28 (owner request: "is the app usable by a professional engineer in
its day to day work? Analyse each gap, write functional and technical specs that close it completely, and the validation layer").
Nothing in this track is built yet.

Question this track answers: **can a professional engineer (civil / site, structural steel, plant, mechanical) use llull as
their daily tool, not just pass scripted scenarios?** Benchmark: the daily-use quality of AutoCAD / BricsCAD / Civil 3D,
SOLIDWORKS / Inventor / Fusion, Tekla / Revit, measured the way their users judge them (time on task, data safety, file
fidelity, install and support), not feature lists.

## Where llull stands (origin/main f1351cff)

Deep capability and a green production gate: four office jobs (extraction building, revision B, pipe rack, civil site)
pass every acceptance criterion through the CLI backend and the UI driver, graded by independent oracles
([`../PRODUCTION_GATE.md`](../PRODUCTION_GATE.md)). What blocks daily professional use is not missing commands but the
product around them:

| # | Gap | Id | Today (evidence) | Pack |
| - | --- | -- | ---------------- | ---- |
| 1 | No evidence from real users | PIL | no pilot run; [`../PILOT.md`](../PILOT.md) results table empty; gates are self-authored ([`../MARKET_READINESS.md`](../MARKET_READINESS.md)) | [01-field-validation](01-field-validation/) |
| 2 | Interaction depth for daily drafting / modelling | UXD | broad command surface, interaction quality never measured against incumbents (snaps, grips, selection, command line, keyboard flow) | [02-drafting-interaction](02-drafting-interaction/) |
| 3 | Large-model performance and robustness | PRF | 125k-triangle STEP opens in 12–21 s, 44 MB document; tessellation can kill the import process ([`../QUALITY_GATES.md`](../QUALITY_GATES.md)) | [03-large-model-performance](03-large-model-performance/) |
| 4 | Data safety: undo, autosave, recovery, integrity | DSF | history-based undo open (MG5.4, [`../ROADMAP.md`](../ROADMAP.md)); recovery behaviour not specified as a product guarantee | [04-data-safety](04-data-safety/) |
| 5 | Install, dependencies, updates | INS | exact kernel silently falls back to Manifold without OCCT on PATH; STEP export needs Python; DWG needs a third-party converter | [05-install-deploy](05-install-deploy/) |
| 6 | The real desktop app is not under test | E2E | UI driver is legacy browser Playwright (LC1: retarget to Electron) | [06-desktop-e2e](06-desktop-e2e/) |
| 7 | Engineering checks not verified and validated | VNV | checks tested against hand calcs, never against published worked examples as a V&V record; output must be signed by an engineer | [07-engineering-vnv](07-engineering-vnv/) |
| 8 | Exchange fidelity for daily files | XCH | DWG only through an external converter; STEP imports as meshes; drawings are SVG (PDF by printing) | [08-exchange-fidelity](08-exchange-fidelity/) |
| 9 | Commercial and support readiness (local-only) | COM | licence, accounts and audit removed with the cloud host (LC1); no release / support / help / localisation policy | [09-commercial-support](09-commercial-support/) |

## What the packs found and specify (2026-10-28)

| Pack | FR / TR / VC | Key current-state findings (code read, measured where stated) | Closing strategy |
| ---- | ------------ | -------------------------------------------------------------- | ---------------- |
| 01 PIL | 23 / 15 / 32 | no pilot ever run; mechanical has no production-gate scenario | 4-profile pilot programme, opt-in local session metrics (registered commands), quantitative "usable daily" exit: completion lower bound ≥ 0.78, SUS 90 % lower bound ≥ 68, real job no slower than the incumbent by week 3, 0 data loss |
| 02 UXD | 47 / 15 / 57 | no typed coordinates / dynamic input; no command line (aliases, repeat); fixed snaps, no tracking, polar unreachable; no 2D grips; fixed keymap | AutoCAD / SOLIDWORKS parity matrix; coordinate grammar; snap-track engine with latency budget; 15-task KLM benchmark (8 of 15 tasks doable precisely today) |
| 03 PRF | 20 / 23 / 33 | imported meshes stored twice as JSON text (≈ 356 B / triangle); one draw call per imported part; main-thread BVH and normals; 4 GB renderer heap cage | binary single-file container (v4), external mesh blobs, batching / LOD / worker builds; tiers T1 (500 parts / 1 M tri) and T2 (2,500 / 5 M) with open, frame, pick, save and memory budgets on `office-min` |
| 04 DSF | 22 / 25 / 23 | one global `autosave.json`, overwritten next session; no file lock (app and `--doc` overwrite each other); crashed backend not restarted; undo 100 unbounded snapshots, `--doc` undo one level; no integrity hash; save itself is sound (temp, fsync, rename, `.bak`) | per-document journal + recovery, lock files incl. network shares, bounded history-based undo, `verify_document` with codes, fault-injection suite |
| 05 INS | 23 / 28 / 30 | installed CLI gets neither the bundled kernel nor Python; desktop drops DWG converter env; build smoke test uses the build machine's PATH; `cadquery>=2.4` unpinned (pulls OCP 8.0, casadi LGPL-3) | self-contained runtime, explicit kernel status (no silent fallback), `llull doctor`, signed per-user / MSI installers, signed offline updates with rollback, SBOM, 8-image clean-VM matrix |
| 06 E2E | 18 / 17 / 31 | 30 legacy browser tests, UI driver and gate 2 never run in Electron | Playwright `_electron` on a fuse "twin" of the release (asar byte-identical), action DSL mapped to commands, `npm run e2e:vc` runner = the gate's `electron` driver |
| 07 VNV | 20 / 19 / 40 | no check has a V&V record; every Eurocode partial factor hard-coded, no national annex; a published JRC bolt example passes only through an αv error (corrected: fails) | V&V record per check, NDPs as sourced data, `calculation_report` for sign-off, 16 grade-A worked-example cases (JRC EUR 27346, FHWA HEC-22, NAFEMS LE1 / LE10) |
| 08 XCH | 34 / 21 / 40 | `import_dwg` refuses without an external converter; `import_dxf` skips 70 records of 22 types on an AutoCAD 2018 sample; STEP imports as meshes | DWG via acadrust (Rust, MPL-2.0) in a sidecar, default only after the corpus passes, ODA SDK as budgeted fallback; STEP to exact editable B-rep via XDE; vector PDF to scale; 22-file pinned corpus |
| 09 COM | 41 / 13 / 40 | no licence declared for llull; licence / accounts removed with the cloud (LC1); no i18n, release or support policy | perpetual node-locked licence + maintenance, Ed25519 licence files activated offline, read-only (never locked-out) without a licence; registry-generated help; FR / NL / DE / EN; CRA and PLD checklist |

Id offsets: VNV and XCH ids start at 101 (`docs/physics/00-vv-harness` and `docs/aerospace/04-interop-ap242-jt-iges` already use
01..30). Traceability was checked on 2026-10-28 with a scratch implementation of [`VALIDATION.md`](VALIDATION.md) §6 G-01..G-08:
299 cases, every FR proved, every MUST FR by a gating case, 0 errors.

## Decisions needed from the owner

Collected from the packs; each pack's `TECHNICAL_SPEC.md` §11 has the detail. **[counsel]** = needs a lawyer, not only the owner.

| # | Decision | Packs | Blocks |
| - | -------- | ----- | ------ |
| D1 | **llull's own licence** (none is declared): decides DWG library options (MPL / GPL), bundling, the commercial model and whether llull is "on the market" | 05, 08, 09 | PRL 1 (signing, bundling), PRL 4 |
| D2 | **Legal entity that publishes and signs**, and its country (code signing, CRA manufacturer, GDPR controller for pilots) **[counsel]** | 01, 05, 09 | PRL 1 |
| D3 | **Does the CRA already apply?** Its Art. 14 reporting duty has applied since 11 Sep 2026; full application 11 Dec 2027; the new Product Liability Directive covers products placed on the market after 9 Dec 2026 **[counsel]** | 05, 09 | PRL 4 |
| D4 | **Document compatibility policy**: the no-backward-compat rule versus a professional tool's need for migrations (a v4 container is proposed by 03; DSF needs a migration promise) | 03, 04, 09 | PRL 2 |
| D5 | **Reference hardware**: buy one fixed `office-min` machine; until then its perf cases are skipped and block PRL 2 | 03 | PRL 2 |
| D6 | **DWG**: accept acadrust as primary with an ODA Drawings SDK budget (USD 3,000 then 2,250 / yr at the lowest tier) as contingency | 08 | PRL 3 |
| D7 | **Standards purchases**: the Belgian national annexes NBN EN 1993-1-1 / 1-8; SCI P363, ECCS, AASHTO Green Book tables (civil f and K tables are unsourced today) | 07 | PRL 3 |
| D8 | **First qualified engineer** to review calculation reports, and whether signing requires a PLM-managed document | 07 | PRL 3 |
| D9 | **Interaction presets** (AutoCAD-like and SOLIDWORKS-like keymaps), 3Dconnexion SDK licence, 2D left-drag = box select | 02 | PRL 3 |
| D10 | **Licensing model**, grace periods, support response times; update check on or off by default (CRA vs offline directive) **[counsel]** | 09, 05 | PRL 4 |
| D11 | **Pilot logistics**: private defect channel (is the issue tracker public?), consent form review, "no slower than the incumbent" as the bar | 01 | PRL 5 |
| D12 | **Test infrastructure**: OSs that gate a release (macOS deferred?), GPU runners or the owner's workstation, `--remote-debugging-port` on the shipped binary for one smoke test | 06 | PRL 1 |

The cross-pack validation layer — one readiness gate that turns the nine packs' validation cases into a single verdict — is
[`VALIDATION.md`](VALIDATION.md) with its machine index [`readiness_gate.json`](readiness_gate.json).

## Authoring rules

Folder layout, sections and source grades: [`../aerospace/TEMPLATE.md`](../aerospace/TEMPLATE.md) and
[`../plant/TEMPLATE.md`](../plant/TEMPLATE.md). Each pack holds `FUNCTIONAL_SPEC.md`, `TECHNICAL_SPEC.md`,
`validation/README.md`, `validation/sources.md`, `validation/expected_results.json` and, where useful, `validation/plans/`
or `validation/data/`.

- Requirement ids `FR-<ID>-nn`, `TR-<ID>-nn`, `VC-<ID>-nn` with the ids above. Priority MUST / SHOULD / COULD. Every FR maps
  to ≥ 1 VC; every VC names the FR / TR it proves.
- Source grades A / B / C as in the plant template; only grade A values and cited closed forms gate pass / fail. Numbers are
  quoted, derived (derivation shown) or `TBD — measure with <tool>`; never invented.
- **Operator for this track.** The primary operator is a **professional engineer at the desktop app** (as pack
  [`../design/04-direct-freeform-editing`](../design/04-direct-freeform-editing/) does): this is the user the question is
  about. The agent-first requirements ([`../aerospace/AGENT_FIRST.md`](../aerospace/AGENT_FIRST.md)) still hold: every UI
  gesture is one registered command, every check has a stable code and a CLI path.
- Product directive ([`../../CLAUDE.md`](../../CLAUDE.md)): local-first, desktop + CLI only, offline, no cloud, native code
  preferred. A spec that needs a network service makes it optional and offline-safe.
- Architecture laws ([`../../.claude/rules/architecture.md`](../../.claude/rules/architecture.md)) hold; a spec that would
  break one says so in its open questions instead.
- Specs only: no change under `packages/`, `src/`, `server/`, `desktop/`, `solver/`.

## Order of delivery

Packs 05 INS and 06 E2E come first: nothing else can be validated on the shipped product without an installer that works
everywhere and a harness that drives it. Then 04 DSF and 03 PRF (trust and speed), 08 XCH and 02 UXD (daily files and
daily gestures), 07 VNV (engineering sign-off), 09 COM, and 01 PIL last as the field proof that closes the track.
Each pack's `TECHNICAL_SPEC.md` §10 holds its milestones and cross-pack dependencies.
