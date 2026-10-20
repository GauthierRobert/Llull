/**
 * Data of the `cfd` document slice (aerospace 12 CFD, TECHNICAL_SPEC §3), owned by the `cfd` plugin (`CadDocument.cfd`, validated by its
 * `DocumentExtension`). Lengths in the case are metres; heavy result data (fields, streamlines, residuals) never enters the document.
 */

import type { Vec3 } from './vectors';

type CfdRegime = 'auto' | 'low_speed' | 'compressible';
export type CfdSolver = 'lbm' | 'euler';
type CfdBoundaryKind = 'wall' | 'inlet' | 'outlet' | 'symmetry' | 'ground';
export type CfdQuality = 'draft' | 'standard' | 'fine';
type CfdDomainRule = 'external_aero' | 'buildings' | 'custom';

export interface CfdFreestream {
  /** Compressible cases (exactly one of `mach` / `speedMS`). */
  readonly mach?: number;
  /** Low-speed cases. */
  readonly speedMS?: number;
  /** Geometric altitude for the 10 AER standard atmosphere (absent with `air`; default sea level). */
  readonly altitudeM?: number;
  /** Explicit air state instead of the standard atmosphere. */
  readonly air?: { readonly densityKgM3: number; readonly temperatureK: number; readonly viscosityPaS: number };
  /** Angle of attack: rotation about the case lateral axis. */
  readonly alphaDeg: number;
  readonly betaDeg: number;
}

export interface CfdBoundaryTag {
  readonly kind: CfdBoundaryKind;
  readonly entityId: string;
  /** Stable face refs (01 KRN FaceQueryPort) when available; the whole entity otherwise. */
  readonly faceRefs?: readonly string[];
}

export interface CfdSlice {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly field: string;
}

export interface CfdCase {
  readonly id: string;
  /** Bodies in the flow (unioned). */
  readonly entityIds: readonly string[];
  readonly excludedEntityIds: readonly string[];
  readonly regime: CfdRegime;
  readonly freestream: CfdFreestream;
  /** Body axis aligned with the free stream at alpha = beta = 0. */
  readonly flowAxis: Vec3;
  readonly upAxis: Vec3;
  readonly reference: { readonly areaM2: number; readonly lengthM: number; readonly momentPointM: Vec3 };
  readonly domain: {
    readonly rule: CfdDomainRule;
    /** Custom rule only, in the case frame (x along the flow axis, z along the up axis), metres. */
    readonly box?: { readonly min: Vec3; readonly max: Vec3 };
    readonly symmetryPlane?: 'xz' | null;
  };
  readonly ground: { readonly enabled: boolean; readonly moving: boolean };
  readonly boundaries: readonly CfdBoundaryTag[];
  readonly quality: CfdQuality;
  /** Overrides `quality`. */
  readonly cellsPerReferenceLength?: number;
  /** Forced solver; refused outside its range. */
  readonly solver?: CfdSolver;
  readonly outputs: { readonly surfaceFields: readonly string[]; readonly slices: readonly CfdSlice[]; readonly probes: readonly Vec3[] };
}

interface CfdProvenance {
  /** llull-compute semver + git hash. */
  readonly solverVersion: string;
  readonly device: { readonly backend: 'vulkan' | 'metal' | 'dx12' | 'cpu'; readonly name: string; readonly driver: string };
  readonly wallTimeS: number;
  readonly steps: number;
  readonly notModelled: readonly string[];
  readonly defaults: readonly { readonly path: string; readonly value: unknown; readonly source: string }[];
}

interface CfdResultSummary {
  readonly caseId: string;
  /** sha256 of the result bundle in the store. */
  readonly resultsHash: string;
  /** Canonical JSON hash of the case. */
  readonly caseHash: string;
  /** Hash of the exported flow surface. */
  readonly geometryHash: string;
  readonly solver: CfdSolver;
  readonly converged: boolean;
  readonly forces: {
    readonly totalN: Vec3;
    readonly momentNm: Vec3;
    readonly cd: number;
    readonly cl: number;
    readonly cs: number;
    readonly cm: Vec3;
    readonly cdAM2: number;
  };
  readonly perBody: readonly { readonly entityId: string; readonly forceN: Vec3 }[];
  readonly peaks: readonly {
    readonly field: string;
    readonly min: number;
    readonly max: number;
    readonly minAt: Vec3;
    readonly maxAt: Vec3;
    readonly unit: string;
  }[];
  readonly grid: { readonly cells: number; readonly finestCellM: number; readonly levels: number };
  readonly provenance: CfdProvenance;
  /** False when replayed without the artifact (05 TR-FEA-05 rule). */
  readonly verified: boolean;
}

export interface CfdDocumentSlice {
  readonly cases: Readonly<Record<string, CfdCase>>;
  readonly results: Readonly<Record<string, CfdResultSummary>>;
}
