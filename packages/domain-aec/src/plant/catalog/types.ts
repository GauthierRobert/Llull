/**
 * Piping catalogue model (plant 01 PSC TECHNICAL_SPEC §3, M0): nominal sizes, component families, dimension values with trust and
 * provenance, rating tables, and the `SpecBinding` a pipe carries. Plugin-side types (plant README D2): core declares no domain data.
 * Lengths are millimetres, pressures bar gauge, temperatures °C.
 */

import type { LicenceFlag } from '@core/model/materialLibrary';

export type DimensionalStandard = 'ASME' | 'EN' | 'ISO' | 'company';
export type NominalSystem = 'NPS' | 'DN';

/** NPS as a canonical designation (`"2-1/2"`) plus its numeric value; DN as an integer string (`"65"`). */
export interface NominalSize {
  readonly system: NominalSystem;
  readonly key: string;
  readonly value: number;
}

export type EndType = 'BW' | 'SW' | 'THD' | 'FL' | 'PE' | 'BE' | 'LUG' | 'WAF';
export type Facing = 'RF' | 'FF' | 'RTJ' | 'TG' | 'MF';
export type BendRadius = 'LR' | 'SR' | '3D' | '5D';

export const COMPONENT_TYPES = [
  'pipe',
  'elbow90',
  'elbow45',
  'tee',
  'reducingTee',
  'reducerConcentric',
  'reducerEccentric',
  'cap',
  'flangeWeldNeck',
  'flangeSlipOn',
  'flangeBlind',
  'flangeSocketWeld',
  'flangeThreaded',
  'flangeLapJoint',
  'gasketSpiralWound',
  'gasketSheet',
  'gasketRing',
  'boltSet',
  'weldolet',
  'sockolet',
  'threadolet',
  'coupling',
  'union',
  'swage',
  'valveGate',
  'valveGlobe',
  'valveCheck',
  'valveBall',
  'valveButterfly',
  'valvePlug',
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const END_TYPES = ['BW', 'SW', 'THD', 'FL', 'PE', 'BE', 'LUG', 'WAF'] as const satisfies readonly EndType[];
export const FACINGS = ['RF', 'FF', 'RTJ', 'TG', 'MF'] as const satisfies readonly Facing[];
export const BEND_RADII = ['LR', 'SR', '3D', '5D'] as const satisfies readonly BendRadius[];

export interface Provenance {
  readonly sourceId?: string;
  readonly citation?: string;
  readonly url?: string;
  readonly accessed?: string;
}

/** One dimension value: millimetres, a count, or bar. `verified` = grade A (two sources agree, or a primary source). */
export interface Dim {
  readonly value: number;
  readonly unit: 'mm' | 'count' | 'bar';
  readonly verified: boolean;
  readonly provenance: Provenance;
}

export interface ComponentSize {
  readonly size: NominalSize;
  /** Reducers, reducing tees, olets (branch). */
  readonly smallSize?: NominalSize;
  /** Pipe rows: `"40"`, `"STD"`, `"10S"` … */
  readonly schedule?: string;
  /** ASME class (150 … 2500) or 3000 / 6000 (B16.11). */
  readonly class?: number;
  readonly pn?: number;
  readonly facing?: Facing;
  /** outsideDiameter, wall, centreToEnd, boltCircle, boltCount, boltDiameter, … */
  readonly dims: Readonly<Record<string, Dim>>;
}

export interface ComponentFamily {
  /** `"asme-b16.9-lr90"`. */
  readonly id: string;
  readonly type: ComponentType;
  /** `"ASME B16.9"`. */
  readonly standard: string;
  readonly dimensionalStandard: DimensionalStandard;
  readonly radius?: BendRadius;
  readonly ends: readonly EndType[];
  readonly sizes: readonly ComponentSize[];
}

export interface PipingCatalog {
  readonly format: 'llull-piping-catalog';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly title?: string;
  readonly licence: LicenceFlag;
  readonly families: readonly ComponentFamily[];
}

export interface RatingRow {
  readonly ratingClass: number;
  readonly temperatureC: number;
  readonly bar: Dim;
}

/** Imperial tabulated rating (B16.5 psig table, separately rounded from the bar table). */
export interface ImperialRatingRow {
  readonly ratingClass: number;
  readonly temperatureF: number;
  readonly psi: number;
  readonly verified: boolean;
}

export interface RatingTable {
  /** `"asme-b16.5-group-1.1"`. */
  readonly id: string;
  readonly standard: 'ASME B16.5' | 'ASME B16.34' | 'EN 1092-1' | 'company';
  /** `"1.1"` or an EN material number. */
  readonly materialGroup: string;
  readonly rows: readonly RatingRow[];
  readonly imperialRows?: readonly ImperialRatingRow[];
  readonly minTemperatureC: number;
}

/** Stored on `PipeElement.spec` (M3 fills it): the spec revision a pipe was resolved against and the size it got. */
export interface SpecBinding {
  readonly specId: string;
  readonly revision: number;
  readonly nps: string;
  readonly schedule?: string;
  readonly odMm: number;
  readonly wallMm: number;
  readonly dimensionalStandard: DimensionalStandard;
  readonly verified: boolean;
}

/** `doc.plant.catalog`: user-imported catalogues (the bundled `llull-open-piping` lives in code, not in the document). */
export interface CatalogModel {
  readonly catalogs: Readonly<Record<string, PipingCatalog>>;
  readonly catalogOrder: readonly string[];
}
