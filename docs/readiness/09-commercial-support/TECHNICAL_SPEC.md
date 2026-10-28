# 09 COM — Commercial and support readiness — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Not legal advice: items marked **[counsel]** are open (functional spec §11).

## 1. Current state in llull (origin/main f1351cff)

| Area                           | What exists                                                                                                                                                                                                                                                                                                                                                                                           | Path                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------- |
| Licence                        | Nothing since LC1 step 3. The removed module verified `<base64url payload>.<base64url Ed25519 sig>` with `crypto.verify`, payload `{customer, seats, expires, features[]}`, key from `LLULL_LICENSE_PUBLIC_KEY`, fallback "evaluation, 3 users", exposed `GET /license` to the status bar. It counted **users of a shared server**; nothing bound it to a machine, it had no clock check and no grace | git `17d62c3b^:server/src/license.ts`                                                                        |
| Ed25519 + key trust (reusable) | `verifyEd25519` / `signEd25519` / `generateEd25519` over `node:crypto` (host side); key store, trust store and a desktop-only native confirmation that issues trust grants (09 PLM)                                                                                                                                                                                                                   | `server/src/plm/ed25519.ts`, `server/src/plm/{keyStore,trustStore,trustGrant}.ts`, `desktop/src/keyTrust.ts` |
| Canonical JSON                 | JCS serialisation                                                                                                                                                                                                                                                                                                                                                                                     | `packages/core/src/lib/jcs.ts`                                                                               |
| Injected ports                 | `ExecutionContext` already carries host ports read by `execute` / commands (`kernel`, `humanSignature`, `objects`, `libraries`, `raster`, `fonts` …), each `null` / absent = a named refusal or the default                                                                                                                                                                                           | `packages/core/src/commands/types.ts`                                                                        |
| Read-only classification       | `CommandAnnotations.readOnly` ("never mutates the document"); exports are `readOnly` (e.g. `export_stl`)                                                                                                                                                                                                                                                                                              | same; `packages/core/src/commands/exchange/exportStl.ts`                                                     |
| Stable refusals                | `CommandError { code, ids, paths, remediation, detail? }` (AF-11)                                                                                                                                                                                                                                                                                                                                     | `packages/core/src/commands/types.ts`                                                                        |
| Crash reports                  | `<data dir>/llull/crashes/<id>/{document.llull.json, commands.json, error.txt (home → ~), meta.json}`; local only; `llull crashes list                                                                                                                                                                                                                                                                | show                                                                                                         | dir`; Help › Crash Reports… | `server/src/crashReports.ts`, `server/src/cli/crashes.ts`, `desktop/src/crashes.ts` |
| Issue draft                    | `ReportIssueDialog`: editable title / body / reproducer plan, Copy, Save reproducer…, "Open GitHub issue draft" (`https://github.com/GauthierRobert/Llull/issues/new`), link capped at 7000 chars; document never attached                                                                                                                                                                            | `src/ui/components/ReportIssueDialog.tsx`, `src/ui/report/issueDraft.ts`, `docs/UI.md`                       |
| Licensed material redaction    | material values under `licensed-no-redistribution` never leave the machine to a non-local client (TR-MAT-32)                                                                                                                                                                                                                                                                                          | `packages/protocol/src/{licensedReferences,redactLicensed}.ts`                                               |
| Help                           | `llull help` / `help <topic>` (usage text, 149 lines), `llull guide` (conventions), `llull describe <cmd>` (description + JSON schema), `llull search`, `llull toolsets`; `ShortcutsDialog` (from `SHORTCUT_GROUPS`); Help menu: Install Command Line Tool, Use with Claude Code, Crash Reports                                                                                                       | `server/src/cli/{usage,main}.ts`, `src/ui/components/ShortcutsDialog.tsx`, `desktop/src/menu.ts`             |
| Registry size                  | **865 commands** in 33 toolsets (`llull list --json`, 2026-10-28)                                                                                                                                                                                                                                                                                                                                     | measured                                                                                                     |
| i18n                           | none. `toLocaleString()` (browser default) in `RestoredBanner.tsx`; `toLocaleString('en-US', …)` in `TimelineDock.tsx`, `PhysicsSection.tsx`; English literals across 240 `.tsx` files (regex lower bound: 175 JSX text nodes + 440 `aria-label` / `title` / `placeholder` literals)                                                                                                                  | measured                                                                                                     |
| Versions                       | `0.1.0` in root, `server/`, `desktop/` `package.json`; all `"private": true`; no `license` field; no `LICENSE` file; document format `llull-document` version 3 (reads 1, 2)                                                                                                                                                                                                                          | `packages/core/src/commands/persistence/serialization.ts`                                                    |
| Network                        | backend binds loopback only; no update check, no telemetry; the only outbound path is a link the user chooses to open                                                                                                                                                                                                                                                                                 | `docs/DEPLOYMENT.md` §3                                                                                      |

## 2. Target architecture

```
                vendor side (offline-capable)                     office machine
  ┌───────────────────────────────┐            ┌────────────────────────────────────────────────────────┐
  │ licence issuer (CLI, key on   │  .llreq →  │ desktop/ main  ── licence UI, About, support bundle UI │
  │ token)  release signer, SBOM  │  ← .llic   │ server/src/licensing/   verify · state · clock · grace  │
  │ CVD inbox, CRA runbook        │  ← .llpkg  │ server/src/diagnostics/ bundle builder + redaction      │
  └───────────────────────────────┘            │ server/src/release/     update verify (manifest + sig)  │
                                               │        │ computes                                       │
                                               │        ▼                                                │
                                               │ ExecutionContext.entitlement (port, read by execute)   │
                                               │ packages/core execute(): LIC_READ_ONLY / NOT_ENTITLED  │
                                               │ packages/protocol: help catalogue (from registry), i18n │
                                               │ src/ui: i18n runtime, Help panel, formats              │
  LAN (V1): solver/llull-licence-server (Rust) ─ leases ─▶ server/src/licensing/floatingClient.ts         │
                                               └────────────────────────────────────────────────────────┘
```

Laws respected and tensions:

- **L1 / L5 — one choke point.** Licence enforcement is not done by commands and not by a surface-specific check that a caller
  could bypass. The host computes an **`EntitlementPort`** from the licence state and injects it into `ExecutionContext`;
  `execute()` (the single choke point, like `requiresKernel`) consults it **before** running a command. Absent / `null` port =
  everything allowed (tests, golden corpus, dev builds, and an open-source build if chosen). Commands never read it. This puts a
  licence _concept_ into `packages/core` as a pure interface — the same pattern as `humanSignature` — with no side effect.
  **Tension flagged for the owner:** the alternative (gate in the host before `execute`) keeps core licence-agnostic but needs the
  same gate in three hosts (backend `POST /command`, CLI local exec, renderer `localMode`) and is easier to bypass. Recommended:
  the port (§11 D1).
- **L2.** Licence files, clocks, fingerprints, file I/O, signatures live in `server/src/licensing/` (shared by the backend, the CLI
  and the desktop main process, like `crashReports.ts`) and `desktop/`. `packages/*/src` never touches `fs`, time or crypto for
  licensing; the port is a value object.
- **L3 purity.** The port is read-only and deterministic for a run (state snapshot); a refusal returns the unchanged document.
- **L6.** The local backend stays loopback-only. The **LAN floating server** is a separate product binary
  (`solver/llull-licence-server`, Rust per C7), not the llull backend; the backend talks to it as a client. It is a LAN service,
  needs no internet, and is optional.
- **L8.** Refused commands are not appended to the feature history. Replay (`replay_history`, load) is never licence-gated:
  re-deriving an existing document is reading it (FR-COM-03).
- **AF-41.** No component of this pack opens an outbound connection unless the user configured an update source.

### 2.1 Technical requirements

| Id        | Pri    | Requirement                                                                                                                                                                                          | Section        | FR                 |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------ |
| TR-COM-01 | MUST   | `EntitlementPort` in `ExecutionContext`, read only by `execute()`; new `dataSafety` annotation; refused commands leave the document and `featureHistory` unchanged; absent port = all allowed        | §3.4           | 03, 09, 10         |
| TR-COM-02 | MUST   | Pure `evaluate()` in `server/src/licensing/`: pinned Ed25519 keys, domain-separated signature over the JCS payload, machine-hash binding, clock high-water mark, grace logic; no `alg` field trusted | §3.1–3.3, §5.1 | 01, 02, 04, 06, 07 |
| TR-COM-03 | MUST   | `release:check`: API-surface diff (`toToolSchemas`, CLI usage / flags / exit codes, stable codes, document version, `.lld` grammar) → required SemVer bump; `deprecated` annotation and window       | §5.3           | 11, 13             |
| TR-COM-04 | MUST   | Help catalogue built at runtime from the registry + new optional `examples` and structured `failures` fields on `defineCommand`, checked by contract tests; HelpPanel + `llull help <cmd>`           | §5.4           | 22, 24, 25         |
| TR-COM-05 | MUST   | i18n runtime (ICU MessageFormat), catalogues per locale, locale resolution in Electron main, `@lib/localeNumber`, `i18n:check` in `npm run check`, pseudo-locale                                     | §5.5           | 26–30              |
| TR-COM-06 | MUST   | Diagnostics bundle builder: manifest with hashes, redaction table, deterministic zip, opt-in document with licensed-material redaction                                                               | §3.6           | 17, 33             |
| TR-COM-07 | MUST   | Signed release manifest + installer verification from a file / LAN source; downgrade refusal; network source optional                                                                                | §3.5, §4       | 15, 41             |
| TR-COM-08 | MUST   | CycloneDX SBOM per workspace merged per release; third-party notices generated from it                                                                                                               | §5.6, §6       | 16                 |
| TR-COM-09 | SHOULD | `solver/llull-licence-server` (Rust): leases, TTL renewal, signed borrow files, admin CLI, LAN only                                                                                                  | §5.2           | 05                 |
| TR-COM-10 | MUST   | Legal texts under `desktop/resources/legal/<lang>/`; NSIS licence page; one disclaimer key used by every report exporter (contract test)                                                             | §5.6           | 31, 32             |
| TR-COM-11 | MUST   | CRA technical file under `docs/compliance/cra/`, root `SECURITY.md`, signed `security.txt`                                                                                                           | §5.7           | 14, 20, 21, 34, 35 |
| TR-COM-12 | MUST   | `llull reset --all` / Help › Reset all local data / uninstaller option remove every llull-written path and report them                                                                               | §4             | 36                 |
| TR-COM-13 | MUST   | CLI `license`, `version`, `diagnostics`, `update`, `help`, `reset` subcommands with stable `--json`; `GET /licence` + live `licence` event for the renderer                                          | §4             | 08, 10             |

## 3. Data model

### 3.1 Licence file (`.llic`, JSON, UTF-8)

```ts
interface LicenceFileV1 {
  readonly format: 'llull-licence';
  readonly version: 1;
  readonly keyId: string; // must be in the build's pinned key set
  readonly payload: string; // base64url of JCS(LicencePayload)
  readonly signature: string; // hex Ed25519 over 'llull-licence/v1\n' + payload (domain-separated)
}
interface LicencePayload {
  readonly licenceId: string; // vendor id, printed in support bundles
  readonly licensee: { readonly organisation: string; readonly country?: string }; // no natural-person fields by default (GDPR, §11 Q9)
  readonly kind: 'node-locked' | 'floating' | 'evaluation';
  readonly seats: number; // node-locked: 1
  readonly edition: string; // 'full' unless editions are sold (FR-09)
  readonly toolsets?: readonly string[]; // entitled toolsets when edition ≠ full
  readonly term: { readonly kind: 'perpetual' } | { readonly kind: 'term'; readonly endsOn: string /* ISO date */ };
  readonly maintenanceUntil: string; // ISO date; builds released after it run read-only
  readonly issued: string; // ISO timestamp (UTC)
  readonly notBefore: string;
  readonly binding?: { readonly machine: string /* hex SHA-256 */ } | { readonly server: string /* floating server id */ };
  readonly graceDays?: number; // overrides the default (§8) for this customer
}
```

- Pinned keys: `server/src/licensing/vendorKeys.ts` holds the public keys (hex) and their validity windows; rotation = new key id in a
  release, old ids kept for the support period. Algorithm fixed to Ed25519; the file has no `alg` field to trust (Keygen warns
  against trusting it [R5]).
- Request file (`.llreq`): `{ format: 'llull-licence-request', version: 1, product, appVersion, machine: <hash>, createdAt }` —
  no user name, no host name.

### 3.2 Local licence state

`<data dir>/llull/licence/` (same `userDataDir` as crash reports): `licence.llic` (as imported), `state.json`
`{ highWaterMark: ISO, lastVerifiedAt, mode, code, tag }` where `tag` = HMAC-SHA-256 keyed by the machine hash over the other fields
(deters casual edits only; not a security boundary). Removed by `llull reset --all`.

### 3.3 Machine fingerprint

`machine = hex(SHA-256('llull-machine/v1' ‖ productSalt ‖ osMachineId))` where `osMachineId` = Windows
`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, Linux `/etc/machine-id`, macOS `IOPlatformUUID`. Only the hash is stored or
sent. A missing id → `LIC_FINGERPRINT_UNAVAILABLE`, read-only, and the vendor can issue a server-bound or evaluation licence.

### 3.4 Entitlement port (core, pure interface)

```ts
// packages/core/src/commands/entitlementPort.ts
export type EntitlementMode = 'full' | 'read-only';
export interface EntitlementPort {
  readonly mode: EntitlementMode;
  readonly code: string; // LIC_* explaining the mode ('LIC_OK' when full)
  readonly remediation: string; // English; the UI translates by code
  readonly toolsets: readonly string[] | null; // null = all
}
// ExecutionContext gains: readonly entitlement?: EntitlementPort | null;
```

`execute()` rule (after zod validation, before `requiresKernel`): if the port is present and the command is **mutating**
(`annotations.readOnly !== true`) and not in `ALWAYS_ALLOWED` (`undo`, `redo`, `load_document`, `replay_history`, `new_document`,
selection / view / camera commands that change only view state — the list is derived from a new annotation
`annotations.dataSafety: true`, not hand-kept), then: `mode === 'read-only'` → refuse `LIC_READ_ONLY`; toolset of the command not in
`toolsets` → refuse `LIC_NOT_ENTITLED`. `toToolSchemas()` is unchanged by entitlements (FR-COM-09). The contract snapshot gains
the `dataSafety` hint only.

### 3.5 Release manifest (`releases.json`, signed)

`{ product, channel: 'stable' | 'lts-<major>', releases: [{ version, date, supportEndsOn, security: boolean, files: [{ name, sha256, size }],
sbom: { name, sha256 }, notes }] }` + detached Ed25519 signature (`releases.json.sig`) by the release key (distinct from licence keys).

### 3.6 Diagnostics bundle (`llull-support-<utc>.zip`)

```
manifest.json      { createdAt, appVersion, commit, items: [{ path, sha256, bytes, source, redactions: n, included: bool }] }
system.json        OS, arch, CPU model, RAM, GPU renderer string, locale, display scale
kernel.json        kernel_info (kind, OCCT version, fallbackReason), native binaries + versions, Python bridge probe
licence.json       { licenceId, kind, edition, mode, code, maintenanceUntil } (never payload / signature)
logs/              backend + desktop logs of the last N sessions (N = 3, spec budget)
crashes/<id>/      local crash reports, each opt-out; their document.llull.json is excluded unless the user opts in
settings.json      user settings without tokens / secrets
document/          only with explicit opt-in: the open document, licensed material values redacted (TR-MAT-32)
```

Redaction (applied to every text item): home directory → `~`, OS user name → `<user>`, host name → `<host>`, e-mail addresses →
`<email>`, bearer tokens / tickets → `<token>`; counts recorded per item. The archive is built deterministically (sorted entries,
fixed mtimes) so the preview hash equals the saved bytes.

## 4. Commands and host operations

The pack adds **no CAD command**. Everything here is host behaviour (licence, release, support, help, i18n) reached through the
CLI and the desktop menus, plus one core change (the entitlement check in `execute`). Rationale: none of it changes the
document (PRIME DIRECTIVE). `llull` CLI subcommands (not registry tools, like `crashes`, `vault`):

| Subcommand                                                       | Effect                                                               | Output (`--json`)                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `license request --out F`                                        | writes `.llreq`                                                      | `{ path, machine }`                                                                                             |
| `license import F`                                               | verify + store                                                       | status object                                                                                                   |
| `license status`                                                 | read state                                                           | `{ state, code, mode, kind, edition, seats, termEndsOn, maintenanceUntil, daysLeft, graceEndsOn, remediation }` |
| `license deactivate --out F`                                     | write release file, clear local licence                              | `{ path }`                                                                                                      |
| `license server status` (V1)                                     | floating server reachability / leases                                | `{ server, leases, borrowedUntil }`                                                                             |
| `license borrow --days N` / `license return` (V1)                | borrow / return a floating seat                                      | status                                                                                                          |
| `version`                                                        | —                                                                    | `{ version, commit, releaseDate, supportEndsOn, documentFormat, channel }`                                      |
| `diagnostics create [--include-document] [--exclude P…] --out F` | build bundle                                                         | manifest                                                                                                        |
| `diagnostics show F`                                             | list items + redactions                                              | manifest                                                                                                        |
| `update check --source DIR                                       | URL`                                                                 | read a signed manifest                                                                                          | `{ current, available[], security[] }` |
| `update verify F`                                                | check a downloaded installer                                         | `{ ok, code }`                                                                                                  |
| `help <command> [--lang L]`                                      | rendered reference page (Markdown); `describe` stays the JSON schema | `{ command, page }`                                                                                             |
| `reset --all --yes`                                              | remove local data (FR-36)                                            | `{ removed[] }`                                                                                                 |

Desktop (Electron main, `desktop/src/`): `licence.ts` (dialogs: import, request, deactivate, status), `support.ts` (bundle preview
window with checkboxes), `about.ts` (About with version, support end date, EULA, notices, security contact, data removal),
`updates.ts` (verify + run installer from a file / LAN source); menu items under Help. The renderer gets licence state through a new
`GET /licence` route (loopback + bearer token, as today's REST) and the live stream (`licence` event when the mode changes).

## 5. Algorithms

### 5.1 Licence evaluation (pure function, `server/src/licensing/evaluate.ts`)

```
evaluate(file, now, highWater, machine, buildDate, keys) → { mode, code, … }
 1 parse; keyId ∉ keys or outside its validity  → read-only, LIC_INVALID_SIGNATURE
 2 verifyEd25519(key, 'llull-licence/v1\n' + payload, signature) false → read-only, LIC_INVALID_SIGNATURE
 3 product / format version mismatch             → read-only, LIC_WRONG_PRODUCT
 4 binding.machine ≠ machine                     → read-only, LIC_MACHINE_MISMATCH
 5 now < notBefore − tol                         → read-only, LIC_NOT_YET_VALID
 6 now < max(issued, highWater) − tol            → clock anomaly: full mode for graceDays from first detection, code
                                                   LIC_CLOCK_ANOMALY; after that read-only until a fresh licence file is imported
 7 buildDate > maintenanceUntil                  → read-only, LIC_MAINTENANCE_EXPIRED_FOR_BUILD (older builds unaffected)
 8 term: now > endsOn + graceDays                → read-only, LIC_EXPIRED
         now > endsOn                            → full, LIC_GRACE
         now > endsOn − warnDays                 → full, LIC_EXPIRING
 9 otherwise                                     → full, LIC_OK
 highWater := max(highWater, now) after a successful start (never moved backwards)
```

`tol`, `warnDays`, `graceDays` are spec budgets (§8). The function is pure (inputs injected) so every VC on dates runs as a unit
test with a fake clock; the install-VM cases prove the wiring.

### 5.2 Floating licences (V1)

Rust binary `solver/llull-licence-server` (`axum` or plain TCP + JSON, decided at implementation, C7): holds a floating licence
file bound to its own machine hash; leases one seat per client machine with TTL `leaseTtl`; clients renew every `leaseTtl / 3`;
on server loss a client keeps its lease until TTL, then read-only (never mid-command); borrow = a signed (server key) lease file
with `until ≤ now + maxBorrow`, verified offline by the client; return = deletion + server update. Client ↔ server authentication by a
per-office shared secret created at server setup (LAN only; no TLS PKI required, optional). Admin CLI on the server: `status`,
`revoke-borrow`, `export-usage` (counts only, no user names unless the office enables them).

### 5.3 Release check (`npm run release:check`, `scripts/release/`)

Inputs: previous release's frozen API surface (`release/<version>/api.json`) and the candidate's: `toToolSchemas()` (command
names, JSON schemas, annotations), CLI usage table + flags + exit codes (from `server/src/cli/usage.ts` structure), the stable-code
registry (all `code` literals collected by a contract test), `CURRENT_SCHEMA_VERSION`, the `.lld` grammar version. Rules: removed /
renamed command, param, flag, code, enum value, narrowed type, new required param, document version not readable → **major**;
added command / optional param / code / enum widening → **minor**; else **patch**. Deprecations: a `deprecated: { since, replacement }`
annotation; removal of an item deprecated for < 2 minors or < 6 months fails. Output: required bump, change list, draft release
notes sections (Breaking, Deprecated, Added, Fixed, Security).

### 5.4 Help catalogue

`packages/protocol/src/help/catalogue.ts` builds pages at runtime from `listCommands()` + `toToolSchemas()` + optional
`examples` (new optional field of `defineCommand`, validated against the zod schema by a contract test) + the error codes a command
declares (`@failure` tags become a structured `failures: string[]` field, checked by a contract test against codes emitted in its
unit tests). Narrative pages: `docs/user/<lang>/{tutorials,how-to,explanation}/*.md` bundled with the app (renderer asset). Search
reuses `@protocol` tool search (`discovery.ts`, `discoveryRank.ts`) extended to narrative pages. Rendering: Markdown → sanitised
HTML in a `HelpPanel` (`src/ui/panels/help/`), offline. CLI `llull help <command>` renders the same page as text.

### 5.5 i18n

- **Renderer**: one message-catalogue runtime with **ICU MessageFormat** syntax (plurals, select, number / date skeletons). Library
  chosen at implementation (C7): candidates FormatJS (`react-intl`, ICU MF1, uses `Intl`) or `messageformat` (Unicode MF2, stable
  since CLDR 47 [R26]); decision recorded in `docs/decisions/`. Catalogues `src/ui/i18n/messages/{en,fr,nl,de}.json`; English is
  the source; ids are stable dotted keys (`panel.layers.title`), never the English text.
- **Locale**: Electron main reads `app.getPreferredSystemLanguages()` / `app.getLocale()` after `ready` [R24], maps to
  `en | fr | nl | de` (+ region for formats: `fr-BE`, `nl-BE`, `de-BE`, `en-GB`), passes it to the renderer; user override in
  settings (`~/.llull/settings.json`).
- **Formats**: a pure `@lib/localeNumber.ts` (`formatNumber(value, locale, digits)`, `parseLocaleNumber(text, locale)`) using
  `Intl.NumberFormat#formatToParts` to learn the decimal and group symbols. Parse rule: accept the locale decimal symbol and `.`;
  reject any group symbol and any string where `,` could be either (`en` locale with `,`) → `NUM_AMBIGUOUS_SEPARATOR`. Every
  `toLocaleString('en-US', …)` call is replaced; a lint rule forbids `toLocaleString` without the app locale.
- **Command output**: `summary` and `CommandError.remediation` stay English in the document log, live sync and `--json`. The UI
  maps `code` (+ `detail` values) to `errors.<CODE>` in the catalogue; missing → English text + marker. Command and parameter
  descriptions: `packages/protocol/src/help/i18n/<lang>/<toolset>.json` keyed `command.<name>.description` /
  `command.<name>.param.<path>`; coverage reported per locale.
- **CLI**: English by default; `--lang` / `LLULL_LANG` translate human-readable lines only, through the same catalogues;
  `--json` and exit codes never change (byte-identical, VC-COM-29).
- **Checks** (`npm run i18n:check`, in `npm run check`): literal JSX text / user-facing attributes outside catalogues (custom
  check script over the TS AST if oxlint has no equivalent rule), missing keys per shipped locale, placeholder / plural-category
  mismatch (ICU parse of every message), unused keys (knip-style). Pseudo-locale `en-XA` generated (accents + 40 % padding).

### 5.6 Legal texts and notices

`desktop/resources/legal/<lang>/{eula,privacy,disclaimer,security-contact}.md` + `third-party-notices.txt` (generated from the SBOM:
component, version, licence id, licence text). NSIS installer licence page shows the EULA in the installer language. The engineering
disclaimer string is one catalogue key reused by every report exporter (`sheets`, calc reports, check reports) — a contract test
asserts its presence in each exporter's output.

### 5.7 CRA technical file

`docs/compliance/cra/`: `risk-assessment.md`, `support-period.md` (rationale per Art 13(8)), `sbom/<version>.cdx.json`,
`vulnerability-handling.md` (CVD policy, triage, advisory format, update distribution), `reporting-runbook.md` (Art 14: roles,
24 h / 72 h / 14 d templates, SRP account, Belgian CSIRT coordinator), `declaration-of-conformity-<version>.md` (Annex V
contents), `annex-ii-user-information.md`. Root `SECURITY.md`; `security.txt` (RFC 9116) published on the product site, signed,
`Expires` < 1 year.

## 6. Interop and persistence

- Licence, request, release-manifest and bundle files are versioned JSON / zip; unknown future versions are refused with a code,
  never half-read.
- The document format is untouched by this pack except the compatibility promise (FR-12): a corpus of documents saved by each
  release lives in `tests/golden/compat/<version>/` from 1.0.0 on.
- SBOM: CycloneDX JSON (1.6 or later; 1.7 current [R18]), generated per workspace (npm: root, `server/`, `desktop/`; cargo:
  `solver/`; Python: bundled wheels list) and merged.

## 7. Surfaces and stable codes

| Code                                                                   | Severity           | Meaning                                         | Fix (remediation text, English)                                           |
| ---------------------------------------------------------------------- | ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `LIC_OK`                                                               | info               | licensed, full mode                             | —                                                                         |
| `LIC_MISSING`                                                          | warn               | no licence imported                             | Help › Licence… › Request, then Import                                    |
| `LIC_INVALID_SIGNATURE`                                                | error              | file altered, unknown key or not a licence      | import the original file from the vendor                                  |
| `LIC_WRONG_PRODUCT`                                                    | error              | licence for another product / format            | —                                                                         |
| `LIC_MACHINE_MISMATCH`                                                 | error              | node-locked to another machine                  | deactivate on the old PC or ask for a transfer                            |
| `LIC_FINGERPRINT_UNAVAILABLE`                                          | error              | OS machine id unreadable                        | contact support (server-bound licence)                                    |
| `LIC_NOT_YET_VALID`                                                    | error              | before `notBefore`                              | check the clock                                                           |
| `LIC_CLOCK_ANOMALY`                                                    | warn               | clock earlier than issue date / last seen       | fix the clock; import a fresh licence file before the grace ends          |
| `LIC_EXPIRING`                                                         | info               | term ends in ≤ warnDays                         | renew                                                                     |
| `LIC_GRACE`                                                            | warn               | term ended, grace running                       | renew before graceEndsOn                                                  |
| `LIC_EXPIRED`                                                          | error              | term + grace ended                              | renew; data actions still work                                            |
| `LIC_MAINTENANCE_EXPIRED_FOR_BUILD`                                    | error              | this build was released after maintenance ended | renew maintenance or reinstall a build released before `maintenanceUntil` |
| `LIC_READ_ONLY`                                                        | refusal            | a document-changing command in read-only mode   | the code of the mode above                                                |
| `LIC_NOT_ENTITLED`                                                     | refusal            | command's toolset not in the edition            | upgrade edition                                                           |
| `LIC_SEATS_EXHAUSTED` (V1)                                             | error              | floating: all seats leased                      | wait / borrow limits                                                      |
| `LIC_SERVER_UNREACHABLE` (V1)                                          | warn               | lease running on TTL                            | check the licence server                                                  |
| `LIC_BORROW_EXPIRED` (V1)                                              | error              | borrowed lease ended off-site                   | reconnect to the office LAN                                               |
| `DOC_NEWER_VERSION`                                                    | refusal            | document written by a newer release             | update llull                                                              |
| `CMD_DEPRECATED`                                                       | warning            | command / param / flag deprecated               | use `detail.replacement`                                                  |
| `REL_SIGNATURE_INVALID`                                                | error              | installer / manifest altered                    | download again from the vendor                                            |
| `REL_DOWNGRADE`                                                        | error              | package older than installed                    | `--allow-downgrade` after confirmation                                    |
| `NUM_AMBIGUOUS_SEPARATOR`                                              | refusal (UI input) | `,` / `.` cannot be decided                     | type the locale decimal symbol                                            |
| `HELP_PAGE_MISSING`                                                    | check              | a command without a complete reference page     | add description / param docs / example                                    |
| `I18N_KEY_MISSING`, `I18N_LITERAL_STRING`, `I18N_PLACEHOLDER_MISMATCH` | check              | catalogue gaps                                  | add / fix the key                                                         |

Codes, keys and `--json` fields are English and stable (FR-COM-28).

## 8. Budgets (spec values, owner may change; grade `target`)

| Budget                                         | Value                                          | Why this value                                                       |
| ---------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Clock tolerance `tol`                          | 48 h                                           | covers time-zone and DST mistakes; anything more is a set-back clock |
| Term warning `warnDays`                        | 30 days                                        | one billing cycle to renew                                           |
| Grace `graceDays` (term expiry, clock anomaly) | 14 days                                        | **owner decision** (§11 Q1); per-customer override in the file       |
| Floating lease TTL (V1)                        | 15 min, renew every 5 min                      | survives a server reboot                                             |
| Max borrow (V1)                                | 30 days                                        | comparable to SOLIDWORKS SNL's cap [R4]                              |
| Deprecation window                             | ≥ 2 minor releases and ≥ 6 months              | above SemVer's minimum of one minor [R17]                            |
| Support period                                 | ≥ 5 years per major line                       | CRA Art 13(8) minimum [R11]                                          |
| Security update availability                   | ≥ 10 years or support period, whichever longer | CRA Art 13(9) [R11]                                                  |
| Licence verification at start                  | ≤ 50 ms                                        | invisible at start-up (`TBD — measure`)                              |
| Support bundle creation                        | ≤ 10 s, ≤ 50 MB without document               | `TBD — measure` on `ref-win11`                                       |
| `security.txt` Expires                         | < 1 year ahead                                 | RFC 9116 recommendation [R20]                                        |

## 9. Test strategy (→ VC ids)

| Layer                              | Tests                                                                                                                                                                     | VC                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Unit (pure)                        | `evaluate()` table over fake clocks and files: tamper, key, machine, clock, expiry, grace, maintenance                                                                    | VC-COM-02, 03, 05, 06, 07             |
| Contract                           | `execute` + entitlement port over **every** registered command: read-only matrix, entitlement matrix, `toToolSchemas` unchanged; refused commands not appended to history | VC-COM-08, 11                         |
| Contract                           | release check fixtures; deprecation window; `DOC_NEWER_VERSION`                                                                                                           | VC-COM-12, 14, 15                     |
| Contract                           | help coverage over the registry; examples validate; failure codes declared                                                                                                | VC-COM-23                             |
| Unit                               | i18n check, number format / parse tables (`fr-BE`, `nl-BE`, `de-BE`, `en-GB`), JSON byte-identity across `LLULL_LANG`                                                     | VC-COM-26, 28, 29, 30                 |
| Unit                               | bundle builder: redaction table, determinism, manifest hashes, licensed material redaction                                                                                | VC-COM-19                             |
| Golden                             | document compatibility corpus `tests/golden/compat/`                                                                                                                      | VC-COM-13                             |
| Electron (pack 06 harness)         | licence dialog, About, Help panel offline, F1, language switch, pseudo-locale screenshots, keyboard-only path, axe on dialogs                                             | VC-COM-09, 24, 27, 35, 40             |
| install-vm (pack 05 matrix)        | air-gapped activation, machine mismatch, clock set-back, signed update from a LAN folder, zero-network capture, floating server, data removal                             | VC-COM-01, 04, 05, 10, 17, 34, 37     |
| cli                                | SBOM validation, `version --json`, exam grading                                                                                                                           | VC-COM-16, 18, 36                     |
| review (records, VALIDATION.md §5) | counsel: EULA, disclaimer, privacy, PLD, CRA checklist; support drill; CRA tabletop; ACR                                                                                  | VC-COM-20, 21, 22, 25, 31, 33, 38, 39 |

## 10. Delivery plan

| Milestone                                                                                     | Content                                                                                                                                                                                         | Depends on                                               | Effort (estimate)     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------- |
| **M0 Decisions** (now)                                                                        | §11 questions answered; ADR `docs/decisions/COM1-licensing.md`; licence of the code declared                                                                                                    | owner + counsel                                          | owner time            |
| **M1 Security & legal baseline** (before any sale; urgent if counsel says Art 14 applies now) | `SECURITY.md`, CVD policy, security.txt, SPOC in About, CRA reporting runbook + SRP registration, SBOM per build, third-party notices, EULA / disclaimer / privacy drafts                       | M0; 05 INS (installer)                                   | 1–2 weeks + counsel   |
| **M2 Licensing MVP**                                                                          | `server/src/licensing/` (evaluate, state, fingerprint), entitlement port in `execute`, `dataSafety` annotation, CLI `license`, desktop Licence dialog, `GET /licence`, issuer CLI (vendor side) | M0                                                       | 2–3 weeks             |
| **M3 Support**                                                                                | diagnostics bundle (CLI + preview UI), intake templates, ticket ids, support tiers page, support drill                                                                                          | 06 E2E harness for UI cases                              | 1–2 weeks             |
| **M4 Release 1.0 process**                                                                    | `release:check`, signed manifest + installer verification, offline update from file / LAN, compat corpus, support end date in `version`, `reset --all`                                          | 05 INS                                                   | 2 weeks               |
| **M5 Help**                                                                                   | help catalogue + `examples` + `failures` fields, HelpPanel, `llull help <cmd>`, Diátaxis EN core set per persona, coverage gate                                                                 | 02 UXD (top tasks per persona), 01 PIL (tutorial timing) | 3–4 weeks + writing   |
| **M6 i18n FR + NL**                                                                           | runtime, catalogues, extraction, locale formats + parsing, error-code messages, pseudo-locale, i18n check                                                                                       | 02 UXD (input fields)                                    | 3 weeks + translation |
| **V1**                                                                                        | DE; translated reference; F1; floating server + borrow; editions; EN 301 549 work + ACR; training curriculum + exam                                                                             | M2–M6                                                    | 6–8 weeks             |

Cross-pack: 05 INS (installer, VM matrix, update channel), 06 E2E (Electron driver), 07 VNV (disclaimer wording on reports),
04 DSF (read-only mode must not interfere with autosave and recovery), 01 PIL (pilot contract uses the EULA and the support path).

## 11. Open decisions (technical) — in addition to functional spec §11

- **D1** Entitlement port in `execute` (recommended) vs host-only gate. Touches core: needs the owner's yes (laws §W6).
- **D2** `dataSafety` annotation vs a hand list of always-allowed commands: annotation recommended (L5: registry is the contract).
- **D3** i18n library: FormatJS (MF1, mature) vs `messageformat` (MF2) — prototype both on 3 dialogs, record in `docs/decisions/`.
- **D4** Licence verifier in TS (reuses `server/src/plm/ed25519.ts`) vs Rust sidecar: TS recommended (host glue, C7 allows; no
  performance need); the floating server is Rust.
- **D5** Where the vendor issuer runs and how its private key is protected (hardware token): outside the repo; procedure in
  `docs/compliance/`.

## 12. References

As in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §12; grades in [`validation/sources.md`](validation/sources.md).
