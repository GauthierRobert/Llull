/**
 * Pipe-spec model (plant 01 PSC TECHNICAL_SPEC §3, M2): a spec selects, per component type and nominal-size range, the catalogue family a piping
 * engineer allows; the branch table maps header x branch sizes to a fitting kind. Plugin-side types (plant README D2). Lengths are millimetres.
 */

import type {
  BendRadius,
  ComponentType,
  DimensionalStandard,
  EndType,
  Facing,
  NominalSize,
  NominalSystem,
  Provenance,
} from '../catalog/types';

/** Branch fitting kinds: equal tee, reducing tee, weldolet, sockolet, threadolet, stub-in, reinforced stub-in. */
export const BRANCH_FITTINGS = ['T', 'RT', 'W', 'S', 'TH', 'SI', 'SIR'] as const;
export type BranchFitting = (typeof BRANCH_FITTINGS)[number];

export const SPEC_STATUSES = ['draft', 'approved', 'superseded'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** Default priority of a component (lower wins; equal priorities that both match are ambiguous). */
export const DEFAULT_PRIORITY = 100;

export type ExtraValue = string | number | boolean;

export interface SpecComponent {
  /** Short code, unique in the spec (`"E90-LR"`). */
  readonly id: string;
  readonly type: ComponentType;
  readonly from: NominalSize;
  readonly to: NominalSize;
  readonly branchFrom?: NominalSize;
  readonly branchTo?: NominalSize;
  /** Catalogue family id or standard alias (`"asme-b16.9"`), matched against the families of the spec's catalogues. */
  readonly catalogRef: string;
  readonly ends?: EndType;
  readonly facing?: Facing;
  readonly class?: number;
  readonly pn?: number;
  readonly radius?: BendRadius;
  /** Explicit schedule of a pipe row. */
  readonly schedule?: string;
  /** Take the schedule (and wall) of the spec's pipe at the same size. */
  readonly scheduleFromPipe?: boolean;
  /** Explicit wall in mm (EN pipe ranges). */
  readonly wallMm?: number;
  readonly priority?: number;
  /** Pipe standard when the catalogue has no family for it (`"EN 10220"`). */
  readonly standard?: string;
  readonly commodityCode?: string;
  readonly description?: string;
  readonly material?: string;
  /** Unmapped scalar columns of the file, kept for round trips. */
  readonly extra?: Readonly<Record<string, ExtraValue>>;
}

/** One row of the insulation thickness table (02 RTE §5.10): the thickness for lines of this code up to `dnMax` and `tempMaxC`. */
export interface InsulationRow {
  /** Insulation code written in the line number (`H` hot, `C` cold ...). */
  readonly code: string;
  /** The row applies to lines of nominal size DN up to this. */
  readonly dnMax: number;
  /** ... and design temperature up to this, degC. */
  readonly tempMaxC: number;
  readonly thicknessMm: number;
  readonly material: string;
  readonly conductivityWmK?: number | undefined;
}

export interface BranchTable {
  /** Size system of the cell keys (the system of the spec's size range). */
  readonly system: NominalSystem;
  /** `cells[headerKey][branchKey]`; keys are `NominalSize.key`. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, BranchFitting>>>>;
}

export interface SpecRating {
  readonly system: string;
  readonly class?: number | undefined;
  readonly pn?: number | undefined;
  readonly materialGroup?: string | undefined;
  readonly ratingTableId?: string | undefined;
}

export interface ElbowAngles {
  readonly anglesDeg: readonly number[];
  readonly toleranceDeg: number;
  readonly trimmedAllowed: boolean;
  /** Pipe bends for turns no angle fits: centreline radius in pipe outside diameters (absent = no bends). */
  readonly bendRadiusD?: number | undefined;
}

/** End types a connection rule names (routing end types: BW butt weld, FL flanged, SW socket weld, SC screwed, PL plain end, WAF wafer, LUG lug). */
export const CONNECTION_ENDS = ['BW', 'FL', 'SW', 'SC', 'PL', 'WAF', 'LUG'] as const;
export const CONNECTION_JOINTS = ['buttWeld', 'socketWeld', 'threaded', 'flanged'] as const;

/** One connection rule of the spec: how a fitting end `end` meets a pipe whose end is `pipeEnd` (either order). Overrides the built-in table for that pair. */
export interface SpecConnectionRule {
  readonly end: (typeof CONNECTION_ENDS)[number];
  readonly pipeEnd: (typeof CONNECTION_ENDS)[number];
  readonly joint: (typeof CONNECTION_JOINTS)[number];
  /** Weld root gap (butt weld) or socket gap (socket weld), mm; absent = the built-in value (0, or the spec's socketGapMm for a socket weld). */
  readonly gapMm?: number | undefined;
  /** Component types the joint needs besides its two ends; absent = by joint (flanged: spiral-wound gasket and bolt set). */
  readonly requires?: readonly ComponentType[] | undefined;
}

export interface SpecApproval {
  readonly signer: string;
  readonly signatureId: string;
  readonly at: string;
}

export interface PipeSpec {
  readonly format: 'llull-pipe-spec';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly title?: string;
  readonly service?: string;
  /** Named explicitly by every spec: there is no default (AF-31). */
  readonly dimensionalStandard: DimensionalStandard;
  readonly rating: SpecRating;
  readonly materials?: Readonly<Record<string, string>>;
  /** Millimetres. */
  readonly corrosionAllowance: { readonly value: number; readonly unit: 'mm' };
  readonly millTolerance?: number;
  readonly designLimits?: { readonly minTemperatureC?: number | undefined; readonly maxTemperatureC?: number | undefined };
  readonly sizeRange: { readonly from: NominalSize; readonly to: NominalSize };
  /** Catalogue ids (or `id@version`) searched in order. */
  readonly catalogs: readonly string[];
  readonly components: readonly SpecComponent[];
  readonly branchTable?: BranchTable;
  /** Insulation thickness table: a line asks for its thickness by code, size and design temperature (`create_pipeline` insulation "fromSpec"). */
  readonly insulation?: readonly InsulationRow[];
  readonly elbowAngles?: ElbowAngles;
  /** Socket gap of a socket-weld joint, mm (B31.3 328.5.2); absent = the named default 1.6 mm. */
  readonly socketGapMm?: number;
  /** Connection rules that override the built-in table (BW-BW, FL-FL, SW-PL, SC-SC) for their pair of ends. */
  readonly connections?: readonly SpecConnectionRule[];
  readonly status: SpecStatus;
  readonly approval?: SpecApproval;
  readonly provenance?: Provenance & { readonly author?: string };
}

/** `doc.plant.spec`: every revision of every spec, oldest first. */
/** A human approval kept beside the revisions so replaying the history re-applies it to the same content without a signature (the ledger is the proof). */
export interface SpecApprovalRecord extends SpecApproval {
  readonly specId: string;
  readonly revision: number;
  /** sha256 of the canonical spec text approved. */
  readonly contentSha256: string;
}

export interface SpecModel {
  readonly specs: Readonly<Record<string, readonly PipeSpec[]>>;
  readonly specOrder: readonly string[];
  readonly approvals?: readonly SpecApprovalRecord[];
}
