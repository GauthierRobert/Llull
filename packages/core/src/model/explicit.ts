/**
 * Explicit dynamics data (PHY-19, RS1 RS-8): the set-up recorded on `AnalysisCase.explicit` of an `explicit_dynamics` case, its recorded result
 * summary and the artifact the host stores (`FeExplicitArtifact`). Everything here is JSON-serialisable data; the solver (`llull-compute explicit`)
 * runs outside the document.
 * @invariant points (rigid walls) are in DOCUMENT units; times in seconds; velocities and gravity in the case unit system (mm/s, mm/s^2 for
 *   N-mm-t-s; m/s, m/s^2 for N-m-kg-s); element fields and histories live in the artifact store, the document keeps a bounded summary
 */

import type { Vec3 } from './vectors';
import type { NamedValue } from './topology';

export type ExplicitMassScaling =
  | { readonly mode: 'none' }
  | { readonly mode: 'selective'; readonly targetTimeStepS: number; readonly maxAddedMassRatio: number };

/**
 * Where the solver mesh comes from: the 05 mesh artifact of the case (`fea_mesh`, linear tets -> tet4) or a structured hexahedral grid llull
 * builds itself on axis-aligned boxes (`size` in document units, hex8).
 */
export type ExplicitMeshSource = { readonly kind: 'fea_mesh' } | { readonly kind: 'structured_hex'; readonly size: number };

interface ExplicitInitialVelocity {
  readonly entityId: string;
  readonly velocity: Vec3;
}

interface ExplicitRigidWall {
  readonly name: string;
  /** A point of the plane, document units. */
  readonly point: Vec3;
  /** Normal pointing into the half space the model lives in (need not be unit length; never zero). */
  readonly normal: Vec3;
}

/** D1–D5 of `ε_f = [D1 + D2 exp(D3 σ*)][1 + D4 ln ε̇*][1 + D5 T*]`, σ* = mean stress / von Mises (tension positive). */
export interface ExplicitFailure {
  readonly D: readonly [number, number, number, number, number];
  readonly source: string;
}

/** Penalty contact (RS-8c): two part sets checked both ways, the nodes of `a` against the surface of `b` (one way), or `a` against itself. */
export interface ExplicitContact {
  readonly name: string;
  readonly kind: 'surface_to_surface' | 'nodes_to_surface' | 'self';
  /** Entity ids (parts of the case); the slave side of nodes_to_surface. */
  readonly a: readonly string[];
  /** Entity ids of the other side (empty for self). */
  readonly b: readonly string[];
  /** Coulomb friction: static, dynamic and the exponential decay constant (s/length) of μ(v). */
  readonly friction: { readonly static: number; readonly dynamic: number; readonly decay: number };
  /** Penalty scale f_si (LS-DYNA SLSFAC). */
  readonly penaltyScale: NamedValue;
}

export interface ExplicitSpec {
  readonly endTimeS: number;
  readonly historyIntervalS: number;
  /** Stable step multiplier (dt = scale x min Le / c). */
  readonly timeStepScale: NamedValue;
  readonly minTimeStepS?: number;
  readonly massScaling: ExplicitMassScaling;
  /** Analysis units (mm/s^2 for N-mm-t-s). */
  readonly gravity?: Vec3;
  /** Flanagan-Belytschko viscous hourglass coefficient of the hex8 element (Q8 / Q10 decision). */
  readonly hourglassCoefficient: NamedValue;
  /** Linear and quadratic bulk viscosity coefficients (shock smearing). */
  readonly bulkViscosity: { readonly linear: NamedValue; readonly quadratic: NamedValue };
  readonly mesh: ExplicitMeshSource;
  readonly initialVelocities: Readonly<Record<string, ExplicitInitialVelocity>>;
  readonly rigidWalls: Readonly<Record<string, ExplicitRigidWall>>;
  readonly rigidWallOrder: readonly string[];
  /** Johnson–Cook failure constants per document material id (TR-EXP-21); never defaulted, always with their source (Q7). */
  readonly failure?: Readonly<Record<string, ExplicitFailure>>;
  /** Penalty contacts (RS-8c), by id `ct-<step>.<k>`. */
  readonly contacts?: Readonly<Record<string, ExplicitContact>>;
  readonly contactOrder?: readonly string[];
  readonly results?: ExplicitResultsSummary;
}

interface ExplicitSolverInfo {
  readonly job: 'explicit';
  readonly name: 'llull-explicit';
  readonly version: string;
  readonly device: 'cpu' | 'gpu';
  readonly deterministic: boolean;
}

type ExplicitTermination = 'normal' | 'abnormal';

/** One energy sample (analysis energy unit: mJ for N-mm-t-s, J for N-m-kg-s). */
export interface ExplicitEnergyRow {
  readonly t: number;
  readonly kinetic: number;
  readonly internal: number;
  readonly hourglass: number;
  /** Kinetic energy removed by the kinematic rigid-wall constraint (stonewall energy). */
  readonly wall: number;
  /** Energy taken by contact forces (penalty springs + friction). */
  readonly contact: number;
  readonly externalWork: number;
}

export interface ExplicitWallHistory {
  readonly name: string;
  /** Sample times, s. */
  readonly t: readonly number[];
  /** Normal force the model exerts on the wall (analysis force unit), sample-averaged over the history interval. */
  readonly force: readonly number[];
}

/**
 * Artifact of one explicit run (JSON; stored by the host under `sha256Hex(canonicalJson(artifact))`).
 * @invariant per-element arrays have one value per element (hex8 first, then tet4); `centroids` holds 3 values per element in the FINAL
 *   configuration, analysis length units
 */
export interface FeExplicitArtifact {
  readonly kind: 'fe_explicit';
  readonly inputHash: string;
  readonly unitSystem: string;
  readonly solver: ExplicitSolverInfo;
  readonly termination: ExplicitTermination;
  readonly message: string;
  readonly cycles: number;
  readonly finalTimeS: number;
  readonly minTimeStepS: number;
  readonly initialMass: number;
  readonly addedMass: number;
  readonly elements: { readonly hex8: number; readonly tet4: number };
  readonly energy: readonly ExplicitEnergyRow[];
  readonly walls: readonly ExplicitWallHistory[];
  readonly vonMises: readonly number[];
  readonly plasticStrain: readonly number[];
  readonly failed: readonly number[];
  readonly centroids: readonly number[];
}

export interface ExplicitExtreme {
  readonly value: number;
  readonly unit: string;
  /** Final-configuration element centroid, analysis length units. */
  readonly at: Vec3;
  readonly element: number;
}

export interface ExplicitResultsSummary {
  /** `false` = recorded WITHOUT its artifact (replay on a machine that lacks the store): state `missing`, never read as numbers. */
  readonly verified?: false;
  readonly artifactHash: string;
  readonly inputHash: string;
  readonly solver: ExplicitSolverInfo;
  readonly termination: ExplicitTermination;
  readonly cycles: number;
  readonly finalTimeS: number;
  readonly minTimeStepS: number;
  readonly elements: { readonly hex8: number; readonly tet4: number };
  readonly energyUnit: string;
  readonly energy: {
    readonly initialKinetic: number;
    readonly finalKinetic: number;
    readonly finalInternal: number;
    readonly finalHourglass: number;
    readonly finalWall: number;
    readonly finalContact: number;
    readonly externalWork: number;
    /** (E_kin + E_int + E_hg + E_wall + E_contact - E_kin0 - W_ext) / max(E_kin0 + W_ext, tiny), TR-EXP-40, at the last sample. */
    readonly errorFinal: number;
    readonly errorMaxAbs: number;
    readonly hourglassRatioMax: number;
    /** Max |contact energy| / internal energy over the history. */
    readonly contactRatioMax: number;
    readonly addedMassRatio: number;
  };
  readonly maxVonMises: ExplicitExtreme;
  readonly maxPlasticStrain: ExplicitExtreme;
  readonly failedElements: number;
  readonly walls: Readonly<Record<string, { readonly peakForce: number; readonly impulse: number; readonly forceUnit: string }>>;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true;
  readonly certificationEvidence: false;
}
