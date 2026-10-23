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
  readonly elbowAngles?: ElbowAngles;
  readonly status: SpecStatus;
  readonly approval?: SpecApproval;
  readonly provenance?: Provenance & { readonly author?: string };
}

/** `doc.plant.spec`: every revision of every spec, oldest first. */
export interface SpecModel {
  readonly specs: Readonly<Record<string, readonly PipeSpec[]>>;
  readonly specOrder: readonly string[];
}
