/**
 * PLM / configuration-management data (aerospace 09): the managed item, its revisions with lifecycle state, change records and policy.
 * Pure data; the `plm` plugin owns every rule and the only commands that write it. The slice sits OUTSIDE the release scope.
 */

export type LifecycleState = 'in_work' | 'in_review' | 'released' | 'superseded' | 'obsolete' | 'cancelled';
type ItemType = 'part' | 'assembly' | 'drawing' | 'document';
export type EffectivityKind = 'serial' | 'msn' | 'date' | 'lot';
type Disposition = 'use-as-is' | 'rework' | 'scrap' | 'return-to-supplier' | 'no-action';

/** Inclusive range of units (serial / MSN integers, ISO `YYYY-MM-DD` dates, lot ids); `to` absent = open-ended. */
export interface Effectivity {
  readonly kind: EffectivityKind;
  readonly from: number | string;
  readonly to?: number | string | undefined;
}

export interface Approval {
  readonly role: string;
  readonly userId: string;
  readonly at?: string | undefined;
  readonly comment?: string | undefined;
}

export interface SignatureRecord {
  readonly alg: 'Ed25519';
  readonly keyId: string;
  readonly publicKey: string;
  readonly meaning: 'authorship' | 'review' | 'approval' | 'release';
  readonly signer: { readonly userId: string; readonly name: string };
  readonly signedAt: string;
  readonly target: { readonly kind: 'release' | 'iteration' | 'change'; readonly ref: string };
  /** SHA-256 of the exact signed bytes (the canonical manifest of the target). */
  readonly signedSha256: string;
  readonly signature: string;
}

export interface Iteration {
  readonly n: number;
  /** Release-scope SHA-256 at the checkpoint. */
  readonly contentHash: string;
  /** Host-supplied ISO-8601 UTC time and user; absent when the caller gave none. */
  readonly at?: string;
  readonly by?: string;
  readonly comment?: string;
}

interface StateChange {
  readonly from: LifecycleState | null;
  readonly to: LifecycleState;
  readonly at?: string;
  readonly by?: string;
  readonly reason?: string;
}

/** The definition at release: the exact canonical bytes that were hashed, inline, or by reference to the local vault object of that SHA-256 (V1, M3). */
type ReleaseSnapshot =
  | { readonly kind: 'inline'; readonly canonicalJson: string }
  | { readonly kind: 'vault'; readonly objectSha256: string };

export interface Revision {
  readonly label: string;
  readonly state: LifecycleState;
  readonly basedOn?: string;
  readonly iterations: readonly Iteration[];
  readonly changeOrder?: string;
  readonly effectivity: readonly Effectivity[];
  /** Effectivity as set at release (immutable; `effectivity` closes when a later revision supersedes this one). */
  readonly releasedEffectivity?: readonly Effectivity[];
  /** Export marking as it was at release (the item's marking may change later). */
  readonly releasedMarking?: ExportMarking;
  readonly approvals: readonly Approval[];
  readonly signatures: readonly SignatureRecord[];
  readonly releasedAt?: string;
  readonly releasedBy?: string;
  /** Frozen at release. */
  readonly contentHash?: string;
  readonly snapshot?: ReleaseSnapshot;
  /** `unverified` data in the scope at release (AF-33): ids and reasons, copied into the release manifest. */
  readonly unverified?: readonly { readonly id: string; readonly reason: string }[];
  /** The structure (EBOM level 1) at release: bound sub-items with their instance counts (immutable; absent for an item without sub-items). */
  readonly releasedStructure?: readonly StructureRow[];
  /** Manifest hash once the host wrote the release package (`attach_release_package`). */
  readonly packageSha256?: string;
  readonly stateHistory: readonly StateChange[];
}

export interface ExportMarking {
  readonly regime: 'none' | 'undetermined' | 'ITAR' | 'EAR' | 'EU-dual-use' | 'national' | 'other';
  readonly classification?: string;
  readonly statement?: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export interface ManagedItem {
  readonly partNumber: string;
  readonly name: string;
  readonly itemType: ItemType;
  /** `asme-alpha`, `numeric-2` or `custom:<name>` (the ordered labels live in `policy.customLabels`). */
  readonly revisionScheme: string;
  readonly currentRevision: string;
  readonly revisions: Readonly<Record<string, Revision>>;
  readonly revisionOrder: readonly string[];
  readonly marking: ExportMarking;
}

export interface ChangeRecord {
  readonly id: string;
  readonly kind: 'ecr' | 'eco';
  readonly title: string;
  readonly reason?: string;
  readonly affectedItems: readonly string[];
  readonly purpose: 'initial-release' | 'change';
  readonly classification?: 'minor' | 'major';
  readonly classificationTags?: readonly ('acoustical' | 'emissions')[];
  readonly classificationJustification?: string;
  readonly proposedClassification?: 'minor' | 'major';
  readonly effectivity?: readonly Effectivity[];
  readonly disposition?: {
    readonly inStock?: Disposition | undefined;
    readonly wip?: Disposition | undefined;
    readonly fielded?: Disposition | undefined;
  };
  readonly fromRequests?: readonly string[];
  readonly state: 'open' | 'accepted' | 'rejected' | 'implemented' | 'cancelled';
  /** ECN id assigned when the ECO is implemented. */
  readonly notice?: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly closedAt?: string;
}

/** One EBOM row: a bound sub-item and how many instances of its component the assembly places. */
export interface StructureRow {
  readonly partNumber: string;
  readonly revision: string;
  readonly state: LifecycleState;
  readonly quantity: number;
  readonly contentHash?: string;
}

/**
 * A component of this assembly bound to a managed item of another document (V1). The binding is ATTESTED by a human signature (`bind_component_item`):
 * the child's own lifecycle lives in its own document / vault, so this record is the assembly's claim about it, never derived by an agent.
 */
export interface SubItem {
  readonly partNumber: string;
  readonly name: string;
  readonly componentId: string;
  readonly revision: string;
  readonly state: LifecycleState;
  /** Release-scope hash of that revision (64 hex); required once the child is released / superseded / obsolete. */
  readonly contentHash?: string;
  readonly boundBy: string;
  readonly boundAt?: string;
}

export interface BaselineMember {
  readonly partNumber: string;
  readonly revision: string;
  readonly contentHash: string;
}

/** A frozen product structure (MIL-HDBK-61B vocabulary): released members only; `hash` = SHA-256 of the canonical JSON of `members`. */
export interface Baseline {
  readonly id: string;
  readonly name: string;
  readonly kind: 'functional' | 'allocated' | 'product' | 'custom';
  readonly members: readonly BaselineMember[];
  readonly hash: string;
  readonly at?: string;
  readonly by?: string;
}

/** A numbered characteristic (balloon), keyed in `PlmModel.characteristics` by the id of the PMI item it numbers; stable across regeneration. */
export interface Characteristic {
  readonly charNo: number;
  readonly sourceRef: { readonly kind: 'dimension' | 'gdt' | 'note' | 'process'; readonly id: string };
  /** Sheet that places the item explicitly (`view.pmiIds`) or the sheet named at assignment; absent when none. */
  readonly sheetId?: string;
  readonly designator?: string;
  /** The requirement as rendered on the drawing at assignment. */
  readonly requirementText: string;
  readonly introducedIn: string;
  /** Revision in which the PMI item was found missing; the number is never reused. */
  readonly retiredIn?: string;
}

/** One part installed in a serial that differs from the as-designed baseline, with the authority that allowed it (a request for variance, a waiver). */
export interface AsBuiltDeviation {
  readonly partNumber: string;
  readonly installedRevision: string;
  readonly authority: string;
}

/**
 * What was built for one serial (FR-PLM-28): the baseline it was designed to and the deviations from it. Recorded by a human (the record asserts
 * what is physically installed); `sha256` covers every other field, so a hand edit of the saved file is detected on load.
 */
export interface AsBuiltRecord {
  readonly serial: string;
  readonly partNumber: string;
  readonly asDesignedBaseline: string;
  /** The manufacturing BOM this serial was built from (same baseline), when one was used. */
  readonly mbom?: string;
  readonly deviations: readonly AsBuiltDeviation[];
  readonly at?: string;
  readonly by: string;
  readonly sha256: string;
}

/** One line of a manufacturing BOM: an engineering BOM row kept as is, changed, or a manufacturing-only line. */
export interface MbomLine {
  readonly partNumber: string;
  readonly revision: string;
  readonly quantity: number;
  readonly origin: 'ebom' | 'ebom-quantity' | 'manufacturing';
  /** Manufacturing-only lines: what the line is (a consumable, tooling, a process material, a phantom assembly). */
  readonly kind?: 'consumable' | 'tooling' | 'process-material' | 'phantom';
  readonly name?: string;
  readonly reason?: string;
}

/** An engineering BOM row left out of the manufacturing BOM (design-only items) with why. */
export interface MbomOmission {
  readonly partNumber: string;
  readonly reason: string;
}

/** The manufacturing BOM of a product baseline (M6): frozen once created; `sha256` covers the other fields. */
export interface MbomRecord {
  readonly id: string;
  readonly name: string;
  readonly baseline: string;
  readonly lines: readonly MbomLine[];
  readonly omitted: readonly MbomOmission[];
  readonly at?: string;
  readonly by?: string;
  readonly sha256: string;
}

export type FaiResultStatus =
  | 'PASS'
  | 'FAIL'
  | 'REWORK'
  | 'SYSERROR'
  | 'INDETERMINATE'
  | 'NOT_ANALYZED'
  | 'BASIC_OR_TED'
  | 'UNDEFINED'
  | 'OTHER';

/** The measured result of one characteristic, as the measuring system reported it (the status is the system's verdict, not llull's). */
export interface FaiResult {
  readonly charNo: number;
  readonly status: FaiResultStatus;
  readonly value?: number;
  readonly maxValue?: number;
  readonly unit?: string;
  /** The QIF element that carried it, e.g. `DiameterCharacteristicMeasurement`, and its id. */
  readonly source: { readonly element: string; readonly qifId: string };
}

/** Measured results imported for one revision (QIF 3.0 MeasurementResults): kept with the hash of the exact file and who attested the import. */
export interface FaiResultSet {
  readonly id: string;
  readonly revision: string;
  readonly serial?: string;
  readonly source: { readonly format: 'QIF 3.0 MeasurementResults'; readonly sha256: string; readonly bytes: number };
  readonly results: readonly FaiResult[];
  /** Results of the file that match no characteristic of the register, and characteristic numbers the file has no result for. */
  readonly unmatched: readonly string[];
  readonly missing: readonly number[];
  readonly importedBy: string;
  readonly at?: string;
}

export interface PlmPolicy {
  readonly requireChangeOrder: boolean;
  readonly requireIndependentChecker: boolean;
  readonly requiredApprovalRoles: readonly string[];
  readonly humanSignatureRequired: boolean;
  readonly requireMarking: boolean;
  /** Ordered labels of a `custom:<name>` revision scheme. */
  readonly customLabels?: readonly string[];
}

export interface PlmModel {
  readonly schema: 1;
  /** One top item per document (assumption A-1). */
  readonly item: ManagedItem;
  readonly changes: Readonly<Record<string, ChangeRecord>>;
  readonly changeOrder: readonly string[];
  /** V1: components bound to managed items, keyed by part number. */
  readonly subItems?: Readonly<Record<string, SubItem>>;
  readonly baselines?: Readonly<Record<string, Baseline>>;
  /** V1-FAI: keyed by PMI item id. */
  readonly characteristics?: Readonly<Record<string, Characteristic>>;
  /** M6: as-built records keyed by serial, manufacturing BOMs keyed by id, imported FAI results keyed by id. */
  readonly asBuilt?: Readonly<Record<string, AsBuiltRecord>>;
  readonly mbom?: Readonly<Record<string, MbomRecord>>;
  readonly faiResults?: Readonly<Record<string, FaiResultSet>>;
  readonly policy: PlmPolicy;
}
