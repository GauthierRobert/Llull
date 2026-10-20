/**
 * Data-exchange slice of the document (aerospace 04 XCH, TECHNICAL_SPEC §3.1): where an imported product came from, what the sender
 * claimed about it (geometric validation properties) and what llull measured. All optional: documents without imports have none of it.
 */

import type { Vec3 } from './vectors';

/** Geometric validation properties the sender embedded for one product, converted to document units (placeholder = all zero, not checkable). */
export interface EmbeddedGvp {
  readonly target: 'part' | 'assembly' | 'independent-surface';
  readonly volume?: number;
  readonly area?: number;
  readonly centroid?: Vec3;
  readonly placeholder: boolean;
}

export type GvpBand = 'green' | 'yellow' | 'red' | 'not-checkable';

export interface GvpComparison {
  readonly property: 'volume' | 'area' | 'centroid';
  readonly sender: number | Vec3;
  readonly receiver: number | Vec3;
  /** Relative for volume / area, absolute distance (document units) for the centroid. */
  readonly delta: number;
  readonly band: GvpBand;
}

/** Band limits (TECHNICAL_SPEC §5.3): the single GVP policy of llull; configurable per call. */
export interface GvpPolicy {
  readonly greenRel: number;
  readonly yellowRel: number;
  /** Fraction of the bounding-box diagonal. */
  readonly greenCentroidPerDiag: number;
  /** Millimetres. */
  readonly yellowCentroidMm: number;
}

export interface GvpCheck {
  readonly band: GvpBand;
  readonly comparisons: readonly GvpComparison[];
  readonly policy: GvpPolicy;
}

export type UnverifiedReason = 'import_gvp_red' | 'import_gvp_not_checkable' | 'verify_skipped';

/** What the sender said and what llull measured for one imported product (TR-XCH-24). */
export interface ImportProvenance {
  readonly format: 'step' | 'iges';
  readonly schemaName: string | null;
  readonly fileName: string;
  readonly sha256: string;
  readonly productName: string;
  readonly sourceUnit: 'mm' | 'cm' | 'm' | 'in' | 'ft' | 'unknown';
  readonly embeddedGvp?: readonly EmbeddedGvp[];
  readonly gvpCheck?: GvpCheck;
  readonly unverified: { readonly value: boolean; readonly reasons: readonly UnverifiedReason[] };
}

export interface ExchangeModel {
  /** Keyed by the imported entity id (a solid) or component id (an assembly node). */
  readonly provenance: Record<string, ImportProvenance>;
}
