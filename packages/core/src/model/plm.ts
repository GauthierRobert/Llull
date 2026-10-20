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

/** The definition at release: the exact canonical bytes that were hashed. */
interface ReleaseSnapshot {
  readonly kind: 'inline';
  readonly canonicalJson: string;
}

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
  readonly policy: PlmPolicy;
}
