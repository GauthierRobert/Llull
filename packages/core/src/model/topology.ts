/**
 * Topology optimisation data (PHY-17): studies recorded on `AnalysisCase.topology`, their recorded result summary and the artifact the
 * host stores (`FeTopologyArtifact`). Everything here is JSON-serialisable data; the optimiser itself runs outside the document.
 * @invariant lengths are in DOCUMENT units; the density field lives in the artifact store, never in the document
 */

import type { Vec3 } from './vectors';

/** A setting with its provenance (AF-31): `defaulted: true` = the named default of `source`, false = given by the caller. */
export interface NamedValue {
  readonly value: number;
  readonly source: string;
  readonly defaulted: boolean;
}

export interface NamedFlag {
  readonly value: boolean;
  readonly source: string;
  readonly defaulted: boolean;
}

/** `FeaTarget` without `intersectPlane` (structural copy: `analysis.ts` imports this module). */
export interface TopologyTarget {
  readonly entityId: string;
  readonly facesNear?: readonly Vec3[];
  readonly edgesNear?: readonly Vec3[];
  readonly pointsNear?: readonly Vec3[];
}

export type TopologyObjective =
  | {
      readonly kind: 'min_compliance';
      /** Load case name -> weight; a case not listed weighs 1. */
      readonly loadCaseWeights: Readonly<Record<string, number>>;
    }
  | {
      /** Least material whose weighted compliance stays at or below `maxCompliance` (MMA only). */
      readonly kind: 'min_volume';
      readonly maxCompliance: number;
      /** Force x length unit of `maxCompliance` (the analysis unit system's, e.g. 'N*mm'). */
      readonly unit: string;
      readonly loadCaseWeights: Readonly<Record<string, number>>;
    };

export type TopologyRegion =
  | { readonly kind: 'target'; readonly target: TopologyTarget; readonly depthVoxels: number }
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3 };

export type SymmetryPlane = 'XY' | 'XZ' | 'YZ';

export type WorldAxis = 'x' | 'y' | 'z';

export interface ManufacturingConstraints {
  /** Planes through the domain AABB centre the density field is mirrored across (derived geometry only in M2). */
  readonly symmetry: readonly SymmetryPlane[];
  /** The design is uniform along this world axis (one design variable per column of voxels). */
  readonly extrusion?: { readonly axis: WorldAxis };
  /** Smallest member the layout may contain, document length units: the filter radius is raised to at least half of it. */
  readonly minMemberSize?: number;
}

/** Heaviside projection of the filtered density (density filter only): β continuation from `betaStart`, doubling every `betaEvery` iterations or on convergence, up to `beta`. */
export interface TopologyProjection {
  readonly beta: NamedValue;
  readonly eta: NamedValue;
  readonly betaStart: NamedValue;
  readonly betaEvery: NamedValue;
}

export interface TopologySettings {
  readonly penal: NamedValue;
  readonly eminRatio: NamedValue;
  readonly move: NamedValue;
  readonly changeTol: NamedValue;
  readonly maxIterations: NamedValue;
  readonly filter: { readonly kind: 'sensitivity' | 'density'; readonly radius: NamedValue };
  readonly threshold: NamedValue;
  readonly greyLimit: NamedValue;
  readonly protectLoadSupport: NamedFlag;
  readonly optimizer: 'oc' | 'mma';
  readonly projection?: TopologyProjection;
}

interface TopologyGridSummary {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly active: number;
  readonly keepIn: number;
  readonly keepOut: number;
}

export interface TopologyHistoryRow {
  readonly it: number;
  readonly compliance: number;
  readonly volume: number;
  readonly change: number;
}

export interface TopologySolverInfo {
  readonly job: 'topopt' | 'ts-reference';
  readonly version: string;
  readonly device: 'cpu' | 'gpu';
  readonly deterministic: boolean;
}

/** A constraint of the final design as the solver reports it. */
export interface TopologyConstraint {
  readonly name: 'volume' | 'compliance';
  readonly value: number;
  readonly limit: number;
  readonly satisfied: boolean;
}

export interface TopologyResultSummary {
  /** `false` = recorded WITHOUT its artifact (replay on a machine that lacks the store): state `missing`, never read as numbers. */
  readonly verified?: false;
  readonly fieldHash: string;
  readonly inputHash: string;
  readonly settingsHash: string;
  readonly grid: TopologyGridSummary;
  readonly iterations: number;
  readonly status: 'converged' | 'max_iterations';
  readonly compliance: number;
  readonly complianceUnit: string;
  readonly perLoadCase: Readonly<Record<string, number>>;
  /** Mean xPhys over the active voxels. */
  readonly volumeFraction: number;
  /** Mean 4 x (1 - x) over the active voxels. */
  readonly grey: number;
  readonly thresholdedVolume: number;
  readonly volumeUnit: string;
  readonly history: readonly TopologyHistoryRow[];
  readonly solver: TopologySolverInfo;
  readonly optimizer: 'oc' | 'mma';
  /** The objective kind of the study and its value in the final design (compliance, or the volume fraction). */
  readonly objective: { readonly kind: TopologyObjective['kind']; readonly value: number };
  readonly constraints: readonly TopologyConstraint[];
  /** Projection β / η of the final design when the study projects. */
  readonly projection?: { readonly beta: number; readonly eta: number };
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly concept: true;
}

export interface TopologyStudy {
  readonly id: string;
  readonly name: string;
  readonly analysisId: string;
  readonly dimension: 2 | 3;
  readonly plane?: SymmetryPlane;
  readonly designDomain: readonly string[];
  readonly keepIn: readonly TopologyRegion[];
  readonly keepOut: readonly TopologyRegion[];
  /** Grid spacing, document length units. */
  readonly voxel: number;
  readonly volumeFraction: number;
  readonly objective: TopologyObjective;
  readonly manufacturing: ManufacturingConstraints;
  readonly settings: TopologySettings;
  readonly result?: TopologyResultSummary;
  /** Id of the read-only iso-surface mesh derived from the recorded field. */
  readonly derivedEntityId?: string;
}

/** Grid placement carried by the artifact: `origin` is the world minimum corner, voxels are `voxel` long on the in-plane axes. */
export interface TopologyArtifactGrid extends TopologyGridSummary {
  readonly dimension: 2 | 3;
  readonly plane?: SymmetryPlane;
  readonly voxel: number;
  readonly origin: Vec3;
  /** Out-of-plane thickness of a 2D study, document units (voxel size for 3D). */
  readonly thickness: number;
}

/**
 * Artifact of one optimisation (JSON; stored by the host under `sha256Hex(canonicalJson(artifact))`).
 * @invariant `xPhys` is the base64 of the little-endian float32 field, x fastest then y then z (`nx * ny * nz` values, inactive voxels 0)
 */
export interface FeTopologyArtifact {
  readonly kind: 'fe_topology';
  readonly inputHash: string;
  readonly settingsHash: string;
  readonly grid: TopologyArtifactGrid;
  readonly xPhys: string;
  readonly compliance: number;
  readonly perLoadCase: Readonly<Record<string, number>>;
  readonly iterations: number;
  readonly status: 'converged' | 'max_iterations';
  readonly history: readonly TopologyHistoryRow[];
  readonly solver: TopologySolverInfo;
  /** Solver facts of V1 runs (absent on artifacts written before them: OC, the volume constraint alone). */
  readonly optimizer?: 'oc' | 'mma';
  readonly constraints?: readonly TopologyConstraint[];
  readonly projection?: { readonly beta: number; readonly eta: number };
}
