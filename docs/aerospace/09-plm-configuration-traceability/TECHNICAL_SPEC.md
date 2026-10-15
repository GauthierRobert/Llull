# Gap 09 — PLM, configuration management & quality traceability — Technical specification

Gap id: **PLM** · Status: draft spec (no implementation) · Date: 2026-10-15 ·
Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md)

Requirement ids: `TR-PLM-nn`. Every TR names the FRs it serves. Proposed command names are snake_case and do **not**
exist yet.

---

## 1. Current state in llull

| Area | File(s) | What exists | Limit for aerospace CM |
| ---- | ------- | ----------- | ---------------------- |
| Feature history (L8) | `packages/core/src/model/types.ts` (`FeatureStep`, `CadDocument.featureHistory`, `nextStepNumber`); `packages/core/src/commands/history/*` (replay, regenerate, carry) | Replayable recipe. Step-scoped ids (`<prefix>-<step>.<k>`). Suppression, labels. | No revision/iteration notion. Every edit is mutable. No approval or lock. |
| Configurations | `packages/core/src/commands/parametric/configurations.ts` (`create_configuration`, `activate_configuration`, both `metaHistory`) | Named parameter-expression sets (design table). Activation replays history. | "Configuration" here means a *variant*, not a CM configuration item. No identity, effectivity or release. |
| Drawings title block | `packages/core/src/model/sheet.ts` (`TitleBlock {title, drawnBy?, partNumber?, revision?, date?}`); `commands/drawings/createSheet.ts`, `editCommands.ts` (`update_sheet`) | Free-text PN/revision/date printed on SVG/PDF sheets. | Not linked to any managed state. Can show "REV C" on unreleased geometry. |
| BOM | `packages/core/src/commands/assembly/billOfMaterials.ts` (`bill_of_materials`, read-only) | Instance count per component plus entity-kind breakdown. | No part number, revision, state or multi-level structure. |
| Serialization | `packages/core/src/commands/persistence/serialization.ts` | `{format:'llull-document', version:2, document}` via `JSON.stringify`. `includeDerived` option "for hashing and diffing". | Key order = insertion order, so the output is **not canonical**. The same definition can hash differently after a round trip through other tools. |
| Hash helper | `packages/core/src/lib/hash.ts` (`hashText`) | 64-bit FNV-1a-style, "Not cryptographic". | Unsuitable for integrity evidence. |
| Audit trail | `server/src/audit.ts` (`AuditEntry {ts,userId,userName,source,command,paramsSha256,summary,affectedCount,epoch,seq}`; `hashJson` = SHA-256 of `JSON.stringify`) | Synchronous JSONL append before ack. Size rotation (10 MiB × 5 files). Actor from named-user auth. | Server-only (absent in pure offline web). Rotation **deletes** old history. No hash chain, so entries can be edited silently. Params hash not canonical. CLI source is self-declared. |
| Live sync | `packages/mcp/src/liveSync.ts` (`epoch`, `seq`) | Command log stream. | No durable, per-item history. |
| Plugin contract | `packages/core/src/plugins/plugin.ts` (`CadPlugin {name, toolset, commands, guards?, document?}`); `commands/derivation.ts` (`DerivationGuard.check(previous, next)`) | Guards veto results at the `execute()` choke point (L5). Document extensions validate plugin slices. | Exactly the hook a release lock needs (§2). `check` has no command name, so document-replacing commands cannot be exempted cleanly. |
| Desktop | `desktop/src/documents.ts` (`createDocumentSession`), KI6 | File > Open/New/Save through `load_document`/`clear_document` and the live snapshot. Per-launch token, loopback. | No vault, no locking, no packages, no keystore. |
| Users | `server/src/users.ts` (`sha256Hex`, named users) | Identity for audit when auth is configured. | No signing keys. |

**Conclusion.** The architecture already has the right seams: commands, metaHistory, guards, document extensions, an audit
hook, and desktop hosts. What is missing is a PLM data model, its commands, a canonical hash, signatures, and a host-side
vault.

## 2. Target architecture

```
src/ui (PLM panel, lock overlay, release dialog)      desktop/ (vault host, keystore, file locks, package writer)
        │ dispatch(name, params)                              │ CLI `llull plm|vault|release …`   server/ (audit chain, shared vault V2)
        ▼                                                     ▼
src/app installDefaultPlugins() ── installs ──► packages/plm  (@plm)  CadPlugin { name:'plm', toolset:'plm',
                                                        commands, guards:[releaseLockGuard], document: plmExtension }
                                                        │ uses only core public API
                                                        ▼
packages/core: lib/canonicalJson.ts, lib/sha256.ts (pure) · commands/{schema,types,noop,derivation,registry}
               model: CadDocument gains optional `plm?: PlmModel` slice (owned/validated by the plugin extension)
```

| TR | Requirement | Serves |
| -- | ----------- | ------ |
| TR-PLM-01 | PLM is a **plugin package** `packages/plm` (alias `@plm`, added once in `tsconfig.base.json`), installed by default in `src/app/plugins.ts`. Rationale: domain-neutral but optional data management. L10 keeps core free of PLM policy. Core changes are limited to two pure `@lib` helpers and the guard signature (TR-PLM-04). | FR-PLM-18 |
| TR-PLM-02 | All PLM commands are `metaHistory: true`. They edit document *input state* (`doc.plm`) like `create_configuration` and are never replayed by `replayHistory`. Regenerating geometry therefore never re-releases or re-signs anything. | FR-PLM-31 |
| TR-PLM-03 | `doc.plm` is **outside the release scope**. Release scope = the serialized envelope minus `selection`, `camera`, `plm` (§5.1). PLM commands therefore never trip the release lock, and the lock blocks every other change to the definition. | FR-PLM-05 |
| TR-PLM-04 | Release lock = a `DerivationGuard` (`domain: 'plm'`) in the plugin. Core change: `check(previous, next, commandName)` gets the command name (backward-compatible extra argument), so `load_document`/`clear_document` (document replacement) are exempt. Building/civil guards ignore it. | FR-PLM-05 |
| TR-PLM-05 | Commands never read a clock, a key or the filesystem. Timestamps (`at`), actor (`by`) and signatures come from params, filled by the host (UI/CLI/MCP adapter injects host time and authenticated user. Agents cannot override `by` when the server has named-user auth). | FR-PLM-31, FR-PLM-17 |
| TR-PLM-06 | Hashing is pure and synchronous in core: `@lib/canonicalJson` (RFC 8785 profile [R16]) + `@lib/sha256` (FIPS 180-4, pure TS, about 120 lines, no dependency). The browser, Node and the CLI produce identical digests. | FR-PLM-06 |
| TR-PLM-07 | Signature **verification** goes through an injected port `ctx.signatures?: SignatureVerifier` (sync). Server/desktop provide it with `node:crypto` Ed25519 (`verify(null, …)`, verified in `validation/verify_vectors.mjs`). When the port is absent (pure browser), `record_signature` refuses with "signature verification requires the desktop or server host" (open question Q2: vendoring a pure-TS verifier). **Signing** never happens in a command. | FR-PLM-20 |
| TR-PLM-08 | Vault, package writing, file locks and the keystore are **host** code (`desktop/src/vault/*`, `server/src/vault/*` in V2), per L6. They call read-only query commands (`release_manifest`, `plm_status`) and write files. The document changes only through commands (`attach_release_package` records the package hash). | FR-PLM-21, FR-PLM-22 |
| TR-PLM-09 | The kernel is used only by optional geometry fingerprints (`verify_release {regenerate:true}`, `plm_diff` mass delta), through `ctx.kernel` with `requiresKernel` on those query variants. OCC is the desktop kernel. No kernel is needed for the MVP lock/hash logic. | FR-PLM-13, FR-PLM-16 |

Laws check:

- **L1/L5.** Every capability is a registered command, so UI, CLI and MCP have parity.
- **L2.** Plugin → core public API only. Hosts do the I/O.
- **L3.** Pure: new `plm` objects, structural sharing.
- **L4.** `doc.plm` is mutated only by PLM commands.
- **L6.** The vault is host-side and no business logic lives in the server.
- **L8.** metaHistory, ids not step-scoped (PLM ids are user/business ids).
- **L9.** Kernel use is optional and goes through `ctx.kernel`.
- **L10.** Plugin.

## 3. Data model

```ts
// packages/plm/src/model.ts (type sketch). The document field is optional: absent = unmanaged document (no behaviour change).
export type LifecycleState = 'in_work' | 'in_review' | 'released' | 'superseded' | 'obsolete' | 'cancelled';
export type ItemType = 'part' | 'assembly' | 'drawing' | 'document';
export type RevisionSchemeId = 'asme-alpha' | 'numeric-2' | `custom:${string}`;
export type EffectivityKind = 'serial' | 'msn' | 'date' | 'lot';

export interface Effectivity {
  readonly kind: EffectivityKind;
  readonly from: number | string;      // serial/msn: positive integer; date: ISO-8601 calendar date 'YYYY-MM-DD'; lot: string id
  readonly to?: number | string;       // inclusive; absent = open-ended
}

export interface Approval {
  readonly role: string;               // 'design-authority' | 'checker' | 'stress' | 'cm' | custom (policy-defined)
  readonly userId: string;
  readonly at: string;                 // host-supplied ISO-8601 UTC
  readonly comment?: string;
}

export interface SignatureRecord {
  readonly alg: 'Ed25519';
  readonly keyId: string;              // vault key registry id
  readonly publicKey: string;          // 64 hex chars (32 bytes)
  readonly meaning: 'authorship' | 'review' | 'approval' | 'release';
  readonly signer: { readonly userId: string; readonly name: string };
  readonly signedAt: string;
  readonly signedSha256: string;       // SHA-256 of the exact signed bytes (canonical manifest)
  readonly signature: string;          // 128 hex chars (64 bytes)
}

export interface Iteration {
  readonly n: number;                  // 1-based
  readonly contentHash: string;        // release-scope SHA-256 at checkpoint
  readonly at: string;
  readonly by: string;
  readonly comment?: string;
}

export interface Revision {
  readonly label: string;              // 'A', 'B', '01', …
  readonly state: LifecycleState;
  readonly basedOn?: string;           // previous revision label
  readonly iterations: Iteration[];    // last = current iteration
  readonly changeOrder?: string;       // ECO id that created / released it
  readonly effectivity: Effectivity[];
  readonly approvals: Approval[];
  readonly signatures: SignatureRecord[];
  readonly releasedAt?: string;
  readonly releasedBy?: string;
  readonly contentHash?: string;       // frozen at release
  readonly snapshot?: ReleaseSnapshot; // definition at release (MVP inline; V1 externalized to vault)
  readonly geometryFingerprint?: GeometryFingerprint;
  readonly packageSha256?: string;     // manifest hash once the host wrote the package (attach_release_package)
  readonly stateHistory: { readonly from: LifecycleState | null; readonly to: LifecycleState; readonly at: string; readonly by: string; readonly reason?: string }[];
}

export type ReleaseSnapshot =
  | { readonly kind: 'inline'; readonly canonicalJson: string }   // MVP: exact bytes that were hashed
  | { readonly kind: 'vault'; readonly objectSha256: string };    // V1: content-addressed object in the vault

export interface GeometryFingerprint {
  readonly kernel: string; readonly kernelVersion: string;
  readonly perEntity: Record<string, { volume?: number; area?: number; bbox: [number, number, number, number, number, number] }>;
}

export interface ManagedItem {
  readonly partNumber: string;         // /^[A-Z0-9][A-Z0-9._\-\/]{0,63}$/i, unique in vault
  readonly name: string;
  readonly itemType: ItemType;
  readonly revisionScheme: RevisionSchemeId;
  readonly currentRevision: string;    // working or latest revision label
  readonly revisions: Record<string, Revision>;
  readonly revisionOrder: string[];
  readonly marking: ExportMarking;
  readonly componentId?: string;       // V1: sub-item bound to doc.components[componentId]
}

export interface ExportMarking {
  readonly regime: 'none' | 'undetermined' | 'ITAR' | 'EAR' | 'EU-dual-use' | 'national' | 'other';
  readonly classification?: string;    // user text, e.g. ECCN or USML category (never computed)
  readonly statement?: string;         // printed notice
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export interface ChangeRecord {
  readonly id: string;                 // 'ECR-0002', 'ECO-0002' (user or generated)
  readonly kind: 'ecr' | 'eco';
  readonly title: string;
  readonly reason?: string;
  readonly affectedItems: string[];    // part numbers
  readonly classification?: 'minor' | 'major';
  readonly classificationTags?: ('acoustical' | 'emissions')[];   // 14 CFR 21.93(b)(c) [R7]
  readonly classificationJustification?: string;
  readonly effectivity?: Effectivity[];
  readonly disposition?: { inStock?: Disposition; wip?: Disposition; fielded?: Disposition };
  readonly fromRequests?: string[];
  readonly state: 'open' | 'accepted' | 'rejected' | 'implemented' | 'cancelled';
  readonly notice?: string;            // ECN id assigned when the ECO is implemented
  readonly createdAt: string; readonly createdBy: string;
  readonly closedAt?: string;
}
export type Disposition = 'use-as-is' | 'rework' | 'scrap' | 'return-to-supplier' | 'no-action';

export interface Baseline {
  readonly id: string; readonly name: string;
  readonly kind: 'functional' | 'allocated' | 'product' | 'custom';   // MIL-HDBK-61B vocabulary [R2]
  readonly members: { partNumber: string; revision: string; contentHash: string }[];   // sorted by partNumber
  readonly hash: string;               // SHA-256(JCS(members))
  readonly at: string; readonly by: string;
}

export interface PlmPolicy {
  readonly requireChangeOrder: boolean;          // default true after first release
  readonly requireIndependentChecker: boolean;   // default true
  readonly requiredApprovalRoles: string[];      // default ['design-authority','checker']
  readonly humanSignatureRequired: boolean;      // default true (agents cannot release)
  readonly requireMarking: boolean;              // default false; true blocks submit while 'undetermined'
}

export interface PlmModel {
  readonly schema: 1;
  readonly item: ManagedItem;                    // MVP: one top item per document (assumption A-1)
  readonly subItems?: Record<string, ManagedItem>;   // V1: keyed by partNumber, bound to components
  readonly changes: Record<string, ChangeRecord>;
  readonly changeOrder: string[];
  readonly baselines: Record<string, Baseline>;
  readonly asBuilt?: Record<string, AsBuiltRecord>;  // V2, keyed by serial
  readonly characteristics?: Record<string, Characteristic>; // V1 (gap 03)
  readonly policy: PlmPolicy;
}

export interface AsBuiltRecord {
  readonly serial: string; readonly partNumber: string; readonly asDesignedBaseline: string;
  readonly deviations: { partNumber: string; installedRevision: string; authority: string }[];
  readonly at: string; readonly by: string;
}

export interface Characteristic {      // balloon; stable id independent of PMI entity id churn
  readonly charNo: number;
  readonly sourceRef: { readonly kind: 'dimension' | 'gdt' | 'note' | 'material' | 'process'; readonly id: string };
  readonly sheetId: string; readonly zone?: string; readonly designator?: string;
  readonly requirementText: string;    // rendered exactly as on the drawing
  readonly introducedIn: string;       // revision label
  readonly retiredIn?: string;
}
```

| TR | Requirement | Serves |
| -- | ----------- | ------ |
| TR-PLM-10 | `CadDocument` gains an optional `plm?: PlmModel`, declared through the plugin `DocumentExtension` (validate/restore). It is an additive optional field. What a reader without the plugin does with an unknown top-level `plm` slice (keep it, drop it, or reject the file) has not been verified: `persistence/validation.ts` shows no explicit top-level allowlist. Silently dropping CM data would be a defect. Recommendation: write **version 3** whenever `plm` is present, with a no-op migration, so older builds refuse the file instead of losing CM data. Open question Q1. | FR-PLM-01 |
| TR-PLM-11 | `ManagedItem.partNumber` regex and uniqueness are checked in `set_item_identity` (document) and by the vault host (cross-document). | FR-PLM-01 |
| TR-PLM-12 | The `stateHistory` append-only list is the in-document status-accounting record. `validate()` rejects files whose history does not satisfy the transition table (a hand-edited state jump). | FR-PLM-04, FR-PLM-15 |
| TR-PLM-13 | MVP keeps `ReleaseSnapshot.inline`, i.e. the exact canonical bytes that were hashed. Memory is cheap with structural sharing. On disk the size roughly doubles per release, which is acceptable below 10 MB. V1 moves snapshots to the vault (`kind:'vault'`) at check-in. | FR-PLM-06, FR-PLM-16 |

## 4. Commands

Toolset `plm`. Mutating = changes `doc.plm` (metaHistory). Query = `readOnly: true`, returns `data`. Every command has
happy and failure unit tests (non-negotiable 2).

| Command | Kind | Params (zod sketch) | `@affects` | `@invariant` | `@failure` (no-op + summary) | FR |
| ------- | ---- | ------------------- | ---------- | ------------ | ---------------------------- | -- |
| `set_item_identity` | mut | `{ partNumber, name, itemType: enum, revisionScheme?: string, policy?: Partial<PlmPolicy> }` | creates `plm` with rev = first(scheme), iteration 1 (hash of current scope) | refuses if `plm.item` already released (identity immutable after first release) | bad PN regex; unknown scheme; already released | 01,02,03 |
| `set_revision_scheme` | mut | `{ scheme }` | future labels only | past labels unchanged | custom list empty/duplicates | 02 |
| `checkpoint_iteration` | mut | `{ comment?, at, by }` | appends `Iteration` if dirty | no-op when clean (summary says so) | state ≠ in_work | 03 |
| `submit_for_review` | mut | `{ comment?, at, by }` | checkpoint if dirty; state → in_review | scope frozen from here | state ≠ in_work; marking undetermined with `requireMarking`; unresolved parameter errors (`doc.parameters[*].error`) | 04,25 |
| `reject_review` | mut | `{ comment, at, by }` | → in_work | — | empty comment; state ≠ in_review | 04 |
| `record_approval` | mut | `{ role, userId, comment?, at }` | appends Approval to the current revision | one approval per (role,user) | state ≠ in_review; role not in policy | 07 |
| `release_item` | mut, destructiveHint | `{ changeOrder?, effectivity?: Effectivity[], approvals?: Approval[], at, by }` | state → released; contentHash, snapshot, releasedAt/By; previous released → superseded with closed effectivity; ECO → implemented + ECN when all its items released | `contentHash == sha256(canonical(scope(doc)))` at that instant | not in_review; approvals missing/insufficient; checker == author (policy); ECO missing/closed/does not list item; effectivity overlaps another released revision; unreleased children (assembly); `humanSignatureRequired` and caller source is agent without signature (adapter flag) | 06,07,11,17 |
| `create_change_request` | mut | `{ id?, title, reason, affectedItems, proposedClassification?, at, by }` | adds ECR open | id unique | empty title; unknown item | 08 |
| `create_change_order` | mut | `{ id?, fromRequests?, affectedItems?, classification, classificationTags?, classificationJustification?, effectivity?, disposition?, at, by }` | adds ECO open; listed ECRs → accepted | classification never inferred | missing classification; unknown ECR; ECR not open | 08,09 |
| `set_change_state` | mut | `{ id, state: 'rejected'\|'cancelled', reason, at, by }` | closes ECR/ECO | implemented is terminal | illegal transition | 08 |
| `revise_item` | mut | `{ changeOrder?, at, by }` | adds revision next(scheme) in_work basedOn current, iteration 1 | previous revision object unchanged (deep-equal) | current not released; no open ECO listing item (policy); scheme exhausted | 10 |
| `set_lifecycle_state` | mut | `{ revision, state: 'obsolete'\|'cancelled', reason, changeOrder?, at, by }` | → obsolete/cancelled; open effectivity closed | per transition table | illegal transition; empty reason | 04 |
| `set_export_marking` | mut | `{ regime, classification?, statement?, decidedBy, at? }` | `item.marking`; sheets render the statement | never derived automatically | regime/statement mismatch (e.g. ITAR with empty statement) | 25 |
| `record_signature` | mut, destructiveHint | `{ target: {kind:'release'\|'iteration'\|'change', ref}, alg:'Ed25519', keyId, publicKey, signature, meaning, signer, at }` | appends SignatureRecord | signature verifies over the canonical target manifest (`release_manifest`) via `ctx.signatures` | no verifier port; verify false; key not registered (V1) | 20 |
| `attach_release_package` | mut | `{ revision, manifestSha256, location? }` | `packageSha256` | manifest's documentContentHash == revision.contentHash | mismatch | 21 |
| `create_baseline` | mut | `{ id?, name, kind, root?, at, by }` | adds Baseline | members sorted; hash = sha256(JCS(members)) | any member not released/superseded | 23 |
| `assign_characteristic_ids` | mut | `{ sheetId?, scheme:'sequential', includeNotes? }` | `plm.characteristics` | existing numbers never change; retired numbers never reused | gap 03 PMI absent → summary explains | 26 |
| `record_as_built` | mut (V2) | `{ serial, partNumber, asDesignedBaseline, deviations, at, by }` | adds AsBuiltRecord | — | unknown baseline | 28 |
| `plm_status` | query | `{}` | — | — | — | 18 |
| `resolve_effectivity` | query | `{ partNumber?, kind, unit }` | data `{revision\|null, state}` | first range containing unit among released/superseded | unit type mismatch | 12 |
| `plm_diff` | query | `{ from, to, geometry?: boolean }` | data per category (§5.4) | — | unknown labels | 13 |
| `verify_release` | query | `{ revision, regenerate?: boolean }` | data `{contentHashMatches, signaturesValid, titleBlockConsistent, geometryFingerprintMatches?}` | — | revision not released | 15,16 |
| `release_manifest` | query | `{ revision }` | data = canonical manifest body + bytes to sign | deterministic | not released | 21 |
| `view_revision` | query | `{ revision }` | data = snapshot document (read-only) for UI rendering | — | no snapshot | 13 |
| `engineering_bom` | query | `{ levels?: number\|'all' }` | data rows `{level, partNumber, revision, state, quantity}` | extends `bill_of_materials`, which is left unchanged | — | 24 |
| `compare_baselines` | query | `{ from, to: id\|'WORKING' }` | data `{added, removed, changed}` | — | unknown baseline | 23 |
| `fai_report_skeleton` | query | `{ partNumber?, revision, faiType:'full'\|'partial', baselineRevision?, reason?, format:'json'\|'csv' }` | data Forms 1–3 | results always null | partial without a reason or baseline revision | 27 |

| TR | Requirement | Serves |
| -- | ----------- | ------ |
| TR-PLM-14 | Summaries of refused edits follow the llull convention `<command> rejected: <PN> rev <R> is <state>; …` and name the remedy (`open an ECO and revise_item`). | FR-PLM-05 |
| TR-PLM-15 | MCP annotations: `release_item`, `record_signature`, `set_lifecycle_state` → `destructiveHint: true`; queries → `readOnlyHint`. The `toToolSchemas()` snapshot gains the `plm` tools (contract test). | FR-PLM-17 |
| TR-PLM-16 | Agent gate: the MCP/CLI adapter passes `ctx.caller = { kind: 'human' \| 'agent', userId }`, a new optional ctx field set only by hosts. `release_item` and `record_approval` refuse `agent` callers when `humanSignatureRequired`. The UI dispatch sets `human`. | FR-PLM-17 |

## 5. Algorithms

### 5.1 Release scope & content hash (TR-PLM-17, FR-PLM-06/15/16)

1. `scope(doc) = { format:'llull-document', version, document: omit(doc, ['selection','camera','plm']) }`, with derived
   entities included (`includeDerived: true` semantics, as the serializer comment already prescribes for hashing).
2. `canonical(x)`: RFC 8785 profile [R16]:
   - objects get keys sorted by UTF-16 code units;
   - no whitespace;
   - strings serialized with the ECMAScript `JSON.stringify` escaping;
   - numbers serialized with `Number.prototype.toString` (JCS uses the ECMAScript algorithm);
   - `-0` → `0`;
   - non-finite values refused (llull validation already rejects them);
   - `undefined` properties omitted, as in JSON.
3. `contentHash = hex(SHA-256(UTF-8(canonical(scope(doc)))))` (FIPS 180-4 [R17]).
4. Golden vectors: `validation/vectors/hash_vectors.json`:
   - sample document scope hash `7e3943fb…f3c24f` over 1551 bytes;
   - invariance under camera/selection change and key reordering;
   - sensitivity to a parameter edit `c913cadc…91017e`;
   - cross-checked in Python and Node.
5. Unicode: no NFC normalization (bytes as authored). Part numbers are restricted to ASCII by regex, which avoids the
   main normalization trap.

### 5.2 Release lock guard (TR-PLM-18, FR-PLM-05)

```
check(prev, next, commandName):
  if commandName in {'load_document','clear_document'} → null          // replacement; integrity handled on load (5.5)
  item = prev.plm?.item; if !item → null
  rev = item.revisions[item.currentRevision]; if rev.state == 'in_work' or 'cancelled' → null
  for key in RELEASE_SCOPE_KEYS (every CadDocument key except selection, camera, plm, plus plugin slices):
      if prev[key] !== next[key] → return `${item.partNumber} rev ${rev.label} is ${rev.state}; open an ECO and revise_item`
  return null
```

The check costs O(number of top-level keys), about 30 reference comparisons, so it stays well under the 1 ms budget,
thanks to structural sharing (L3). False positives would come from a command that re-creates an unchanged top-level
object. Mitigation: the contract test runs every registered mutating command on a released document and asserts either
refusal or `next[key] === prev[key]` for all scope keys (TR-PLM-30).

### 5.3 Revision schemes (FR-PLM-02)

`asme-alpha`:
- alphabet = A–Z minus {I,O,Q,S,X,Z}, 20 letters (secondary source [R26]);
- label(n) = alphabet[n-1] for n ≤ 20;
- else alphabet[(n-21) div 20] + alphabet[(n-21) mod 20];
- capacity 420.

`numeric-2`: zero-padded. `custom:<name>`: an ordered list stored in policy. Vectors: `vectors/revision_sequence.json`
(J = 9th, P = 14th, Y = 20th, AA = 21st, YY = 420th).

### 5.4 Diff (FR-PLM-13)

Both sides are canonical scope objects. The diff is computed per category:

- `parameters`: by name, comparing expression;
- `featureHistory`: LCS on `(name, canonical(params))` with step ids as anchors, giving added/removed/edited/suppressed;
- `entities`: by id, giving added/removed/changed kinds;
- `materials`, `components`, `drawings.sheets[*].titleBlock`;
- effectivity.

Optional geometry: per-entity volume/area/bbox delta via `ctx.kernel` (OCC `BRepGProp` mass properties on desktop).
Tolerance: relative 1e-9 on volume for "unchanged" (same kernel). Across kernel versions a relative 1e-6 drift is reported
as drift, not as a change.

### 5.5 Integrity on load (FR-PLM-15)

`plmExtension.validate` cannot hash (validation is structural). Instead, a post-load hook in the plugin's `restore` path
(or a dedicated `verify_on_load` invoked by `load_document` via the extension) recomputes:
- `contentHash` of the **current** scope when the current revision is released;
- the snapshot hash of every released revision.

A mismatch sets the transient `plm.integrity` (excluded from scope and serialization) and the load summary says
`release A content hash mismatch (expected 7e39…, got …)`. The revision stays locked. The fix is to revert to the snapshot
(`restore_revision_snapshot`, a mutating command allowed only in that mismatch state) or to open an ECO.

### 5.6 Effectivity (FR-PLM-11/12)

- Ranges are inclusive. Serial/MSN are integers; ISO dates are compared lexicographically (`YYYY-MM-DD`).
- On release of N+1 with cut-in `from = f`, each open range of N of the same kind closes at `f-1` (integer) or the previous
  calendar day (date, computed with pure date arithmetic and no clock).
- Overlap between released revisions of the same kind is refused.
- `resolve(kind, unit)` = the first released/superseded revision whose range contains the unit.
- Obsolete revisions keep their history but are excluded from resolution.

Vectors: `vectors/effectivity_resolution.json`.

### 5.7 Signatures (FR-PLM-20)

- Algorithm: Ed25519 PureEdDSA (RFC 8032 [R15]; approved in FIPS 186-5 [R18]).
- Signed bytes: `UTF-8(canonical(manifestBody))`, where `manifestBody` is the manifest without `manifestSha256` and
  `signatures`.
- Deterministic: the same key and bytes always give the same signature, which makes golden tests possible (the sample
  manifest is signed with the public RFC 8032 TEST 1 key: `df1953d3…20beb0f`).
- Key custody (host): private keys stay in the OS keystore or a hardware token. The desktop uses Electron's OS-backed
  secret storage to protect a locally generated key (candidate API, to verify), or PKCS#11 tokens in V2.
- Public keys are registered in `vault/keys/<userId>.json` with validity dates. Revocation is a signed vault entry.
- The trust store **must reject** the RFC 8032 test public keys (`d75a98…511a`, `3d4017…660c`, `fc51cd…8025`) outside test
  mode (TR-PLM-19).

### 5.8 Audit chain (FR-PLM-19)

`server/src/audit.ts` keeps its format and adds:
- `prevSha256`;
- `entrySha256 = sha256(canonical(entry without entrySha256))`;
- `paramsSha256` computed with `canonical`, not `JSON.stringify`.

Vault mode disables deletion on rotation: rotated segments are moved to `vault/audit/` and the chain continues across
files. On desktop, the same writer runs in the backend process (KI6 starts the server bundle, so it is already present).
Verification: `llull audit verify <dir>` recomputes the chain.

## 6. Interop & persistence

### 6.1 Release package (FR-PLM-21): sample `validation/release_package_manifest.sample.json`

```
LL-1001_A/                                  (folder or .zip with STORE; files read-only after write)
  manifest.json                             schema llull-release-manifest/0.1 (canonical JSON + signatures)
  model/LL-1001_A.llull.json                canonical release-scope bytes (hash == contentHash)
  drawings/LL-1001_A_sheet1.svg|.pdf        export_sheet_svg / PDF
  neutral/LL-1001_A.stp                     STEP AP242 (gap 04; ISO 10303-242) + validation properties (EN 9300-110 [R22])
  reports/check_model.json, mass_properties.json, fai_skeleton.json (optional)
```

Manifest fields:
- `item{partNumber,name,revision,iteration}`, `lifecycleState`, `change{eco,classification}`, `effectivity[]`,
  `baseline`, `marking`;
- `releasedAt/By`;
- `members[{path,role,mediaType,canonical,sha256,bytes}]`, `documentContentHash`;
- `tool{name,version,kernel,schemaVersion}` (FR-PLM-30);
- `manifestSha256`, `signatures[]`.

Verification needs no llull: `sha256sum` per member plus any RFC 8032 verifier on the canonical body
(`validation/verify_vectors.mjs` shows it with only `node:crypto`).

### 6.2 Local vault (FR-PLM-22): desktop host

| Option | Pros | Cons | Decision |
| ------ | ---- | ---- | -------- |
| Embedded git (SHA-256 object format [R24]) + Git-LFS locks [R23] | Mature model, familiar | Requires a git binary or a new JS dependency (stack is fixed). LFS locks need a lock server. Binary diffs useless. | Export/import only (V2) |
| **Minimal content-addressed store (git-like) owned by llull** | Zero dependency. SHA-256 everywhere. Fits signed packages. Works on a local disk or SMB share | Own code to maintain | **MVP/V1** |
| PDM server (llull `server/` shared vault, V2) | Multi-site, real locks, RBAC | Needs a server (not offline) | V2, same commands |

Layout:

```
<vault>/vault.json                {format:'llull-vault', version:1, hash:'sha256'}
<vault>/objects/<2>/<62>          immutable blobs named by SHA-256 (write tmp + fsync + rename; chmod a-w)
<vault>/items/<PN>/refs.json      { revisions: { A: { manifest: <sha>, state }, B: … }, head: <sha of working doc> }
<vault>/items/<PN>/<REV>/manifest.json   copy of the signed manifest (human-browsable)
<vault>/locks/<PN>.lock           { holder:{userId,name,host,pid}, acquiredAt, leaseUntil }  created with O_EXCL
<vault>/keys/<userId>.json        registered public keys
<vault>/audit/*.jsonl             hash-chained audit (5.8)
```

- **Check-out** = create the lock with `O_CREAT|O_EXCL`, then load the head into the app via `load_document`.
- **Check-in** = `checkpoint_iteration` (command), write the head blob, update `refs.json` atomically (write tmp + rename),
  delete the lock.
- Lease 8 h, renewed every 10 min while the app runs.
- A stale lock (lease expired and pid absent on the same host) can be broken by its holder or by the CM role. Breaking is
  audited.
- Read-only open never locks.

### 6.3 Neutral configuration exchange (V2)

Item/revision/effectivity/baseline map to STEP AP242 PDM / PDM-IF AP242 XML configuration management [R29]
(`ConfigurationItem`, effectivity entities [R38]) and to the ECSS-M-ST-40C Annex L TDP XML [R30]. The mapping table is
deferred to the V2 design.

## 7. UI / CLI / MCP surfaces

| Surface | Element | Notes |
| ------- | ------- | ----- |
| UI `src/ui/panels/PlmPanel.tsx` | Item card (PN, rev.iter, state badge, marking), revisions list, changes list, baselines, effectivity resolver | Param-gathering only; dispatches commands |
| UI viewport | Lock overlay + disabled edit tools. Tooltips quote the guard summary | Reads `doc.plm` state |
| UI release dialog | Checklist: approvals, ECO, effectivity, marking, `check_model` result, package preview | Host signs, then `record_signature` → `release_item` (or release then sign, policy) |
| UI drawings | Title block PN/revision auto-filled from `plm.item` when managed. Marking statement in the frame. Balloons rendered from `plm.characteristics` | Render-time projection: no sheet data duplication |
| Desktop menu | File > Vault > Open vault…, Check out, Check in…, Release package…, Verify package… | Host code (`desktop/src/vault/*`) |
| CLI | `llull plm status`, `llull run <plm command>`, `llull release verify <manifest>`, `llull vault init\|checkout\|checkin\|log\|verify`, `llull audit verify` | `--at/--by` auto-filled from host clock/user |
| MCP | toolset `plm` (view). Prompts: `prepare_engineering_change`, `prepare_fai` | Hidden tools still callable via `execute` |

## 8. Performance & robustness budgets

| Operation | Budget (reference desktop, document ≤ 10 MB) | How |
| --------- | -------------------------------------------- | --- |
| Lock guard per mutating command | ≤ 1 ms p95 | reference comparison (5.2) |
| `release_item` (canonicalize + SHA-256 + snapshot) | ≤ 1 s for 10 MB | pure TS SHA-256 is roughly 100–300 MB/s in V8 (TBD, measure), canonicalize O(n log k) |
| `verify_release` (no regenerate) | ≤ 1 s for 10 MB | same |
| Package verify 50 MB | ≤ 2 s | streaming SHA-256 in host (`node:crypto`) |
| `plm_diff` 2 × 5 000 feature steps | ≤ 500 ms | LCS with anchors |
| Vault check-in 10 MB | ≤ 1 s local SSD | fsync + rename |
| Robustness | crash during check-in leaves either old or new refs (atomic rename); orphan objects GC'd by `vault verify --gc` | |

## 9. Test strategy

| VC | Test (proposed path) | Level |
| -- | -------------------- | ----- |
| VC-PLM-01, 02, 03, 05, 06, 12 | `tests/unit/plm/lifecycle.test.ts` runs `validation/scenarios/S1_release_eco_revB.json` step by step (scenario runner reads the JSON) | unit |
| VC-PLM-04 | `tests/unit/plm/revisionScheme.test.ts` ← `vectors/revision_sequence.json` | unit |
| VC-PLM-07 | `tests/unit/plm/effectivity.test.ts` ← `vectors/effectivity_resolution.json` | unit |
| VC-PLM-08, 09, 13 | `tests/unit/plm/guards.test.ts` ← `scenarios/S2_lifecycle_guards.json` + `lifecycle_transitions.csv` | unit |
| VC-PLM-03 (exhaustive) | `tests/unit/contract/plmReleaseLock.test.ts`: for **every** registered mutating command with a minimal valid param fixture, on a released document, the result is refusal or no scope change (TR-PLM-30) | contract |
| VC-PLM-10, 11, 14, 15 | `tests/unit/plm/bomBaseline.test.ts`, `fai.test.ts` ← `scenarios/S3_baseline_bom_fai.json` + `as9102_field_mapping.csv` | unit |
| VC-PLM-16 | `tests/unit/lib/canonicalJson.test.ts`, `tests/unit/lib/sha256.test.ts` ← `vectors/hash_vectors.json` (incl. sample_document) | unit |
| VC-PLM-17 | `server/tests/signatures.test.ts` (node:crypto port) ← `vectors/ed25519_vectors.json` incl. negatives; `tests/unit/plm/recordSignature.test.ts` with a fake port | server + unit |
| VC-PLM-18 | `desktop/tests/releasePackage.test.ts`: write the package, verify with an independent reader, flip one byte → mismatch | desktop |
| VC-PLM-19 | `tests/perf/plm.bench.ts` (vitest bench, non-gating) | bench |
| VC-PLM-20 | `tests/unit/plm/marking.test.ts` + sheet SVG contains the statement | unit |
| VC-PLM-21 | `server/tests/auditChain.test.ts`: chain verify, tamper one line → break detected, rotation keeps the chain | server |
| VC-PLM-22 | `tests/unit/contract/toolSchemas` snapshot includes plm; `server/tests/cli-plm.test.ts` runs S1 via CLI; agent release refused | contract + server |
| VC-PLM-23 | `desktop/tests/vaultLocks.test.ts`: two sessions, O_EXCL lock, lease expiry, audited break | desktop |
| VC-PLM-24 | V2 with gap 04: AP242 export of PDM data validated by the CAx-IF/PDM-IF checker (TBD) | quality |
| Golden | `tests/golden/plans.ts` gains `plm_release_eco` (from `validation/plans/plm_release_eco_revB.plan.json`); id-normalized snapshot + replay equality (PLM state is metaHistory so replay leaves it intact) | golden |
| Production gate | `npm run production` scenario: release → ECO → B → package → verify → reopen in a fresh profile → verify | gate |

| TR | Requirement | Serves |
| -- | ----------- | ------ |
| TR-PLM-19 | Test-key rejection: the production trust store refuses RFC 8032 test public keys; tests run with `LLULL_PLM_TEST_KEYS=1`. | FR-PLM-20 |
| TR-PLM-30 | Release-lock contract test over `listCommands()`. Adding a new mutating command without passing it fails CI. | FR-PLM-05 |
| TR-PLM-31 | Coverage gate 90/85/90/90 extends to `packages/plm/src/**` (same as domain-aec). | NN-3 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (1 dev) |
| --------- | ------- | ---------- | -------------- |
| M0 | Core: `@lib/canonicalJson`, `@lib/sha256` + vectors; `DerivationGuard.check(…, commandName)`; `ctx.caller`, `ctx.signatures` ports | — | 3 d |
| M1 MVP | `packages/plm`: model, extension, guard, identity/scheme/iteration/review/release/ECR/ECO/revise/lifecycle/effectivity/diff/status/verify; title-block projection; CLI parity; S1/S2 green; golden plan | M0 | 12–15 d |
| M2 V1-integrity | Audit chain (server); signatures (record/verify, node port); release manifest + package writer (desktop); trust store; package verify CLI | M1 | 8–10 d |
| M3 V1-vault | Desktop vault (CAS, refs, locks, check-in/out, menu); snapshots externalized | M2 | 8–10 d |
| M4 V1-structure | Sub-items/components, `engineering_bom`, baselines + compare, export marking on sheets | M1; assembly maturity | 6–8 d |
| M5 V1-FAI | Characteristic numbering + `fai_report_skeleton` (JSON/CSV) | **gap 03** (GD&T/PMI entities) | 5–7 d |
| M6 V2 | As-built/MBOM, shared server vault, AP242 PDM/TDP export, LOTAR packaging, QIF results import | **gap 04** (STEP AP242/LOTAR), server multi-user | 20+ d |

## 11. Open questions / decisions needed

| # | Question | Options / recommendation |
| - | -------- | ------------------------ |
| Q1 | Document version when `plm` is present: bump to 3, or teach v2 validation to ignore unknown slices? | Recommend bump to 3 when `plm` is present (explicit; old builds refuse rather than silently drop CM data) |
| Q2 | Ed25519 verification in the pure browser: vendor a pure-TS verifier (e.g. an audited noble library, a **new dependency** that needs user approval per the stack rule) or require a host? | Recommend host-only for V1. Revisit if the web app must verify offline |
| Q3 | Should `activate_configuration` be allowed on a released item when every configuration is part of the released definition (viewing a variant)? | Option: hash the scope with parameters normalized to the default configuration, and treat activation as view state. Needs a product decision |
| Q4 | Release snapshot inline vs vault in the web (no vault) | Inline is fine to about 10 MB. Beyond that, require desktop |
| Q5 | Undo of `release_item` | Allowed until the package is persisted. After that the store blocks undo of that entry (needs a store hook in `src/ui/store`) |
| Q6 | Part-number uniqueness across documents without a vault | Warn only; enforced inside the vault |
| Q7 | AS9102C official field numbering and Form layout | Buy the standard before M5; mapping CSV columns are ready |
| Q8 | Keystore technology on desktop (OS keychain wrapper vs PKCS#11) | Start with an OS-protected local key (V1), smart cards in V2 |

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references) for [R1]–[R39] (same numbering) and
[validation/sources.md](validation/sources.md) for verification notes. Additional:

- [R17] NIST SHA-256 example "abc" (FIPS 180-x) — NIST — https://www.nist.gov/node/1078681 (accessed 2026-10)
- [R41] Node.js `crypto.verify(null, …)` for Ed25519 — verified locally on Node v22.22.0 by `validation/verify_vectors.mjs` (accessed 2026-10)
- llull internal: `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`, `.claude/rules/architecture.md`
