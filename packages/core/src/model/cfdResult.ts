/**
 * The result bundle of one `llull-compute flow` run (aerospace 12 CFD TECHNICAL_SPEC §3, §6; M2 as built in §13): what the host stores
 * content-addressed in the artifact store under `sha256Hex(canonicalJson(artifact))`. The document keeps only the `CfdResultSummary` the
 * plugin recomputes from this artifact (trust model of 05 §4.1: a recorded summary is a claim about an artifact). Lengths are metres in the
 * case frame (x along the free stream at α = β = 0, z up), forces newtons, pressures pascals (gauge).
 */

import type { Vec3 } from './vectors';

/** One drag sample of the steady-state monitor. */
interface CfdHistoryRow {
  readonly step: number;
  readonly timeS: number;
  readonly dragN: number;
  readonly cd: number;
  readonly forceN: Vec3;
  /** Relative change of the window mean; null before two windows exist. */
  readonly change: number | null;
  readonly phase: 'transient' | 'averaging';
}

interface CfdPeak {
  readonly field: string;
  readonly min: number;
  readonly max: number;
  readonly minAt: Vec3;
  readonly maxAt: Vec3;
  readonly unit: string;
}

interface CfdProbeValue {
  readonly pointM: Vec3;
  /** Null when the probe falls inside a body or outside the grid. */
  readonly velocityMS: Vec3 | null;
  readonly speedMS: number | null;
  readonly pressurePa: number | null;
}

export interface CfdResultArtifact {
  readonly kind: 'cfd_result';
  readonly caseId: string;
  /** Canonical hash of the case the run was built from (`update_cfd_case` makes it stale). */
  readonly caseHash: string;
  /** Hash of the exported flow surface, and the kernel that built it (the hash depends on it). */
  readonly geometryHash: string;
  readonly kernel: string;
  readonly solver: 'lbm';
  readonly solverVersion: string;
  readonly converged: boolean;
  readonly steps: number;
  readonly averagedSteps: number;
  readonly timeS: number;
  readonly elapsedS: number;
  readonly device: 'cpu' | 'gpu';
  readonly adapter?: string;
  readonly deterministic: boolean;
  readonly precision: string;
  /** A symmetry face halved the model: forces and moments are the whole body's (doubled; side force and in-plane moments zero). */
  readonly halfModel: boolean;
  /** Bytes per cell of the layout this run used and of both layouts (ties the host estimate to the real buffers). */
  readonly memory: {
    readonly bytesPerCell: number;
    readonly gpuBytesPerCell: number;
    readonly cpuBytesPerCell: number;
    readonly bytes: number;
  };
  readonly grid: {
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly cellM: number;
    readonly cells: number;
    readonly fluidCells: number;
    readonly solidCells: number;
    readonly originM: Vec3;
  };
  readonly lattice: {
    readonly tau: number;
    readonly uLattice: number;
    readonly dtS: number;
    readonly flowThroughSteps: number;
    readonly les: boolean;
    readonly smagorinsky: number;
    readonly reynolds: number;
  };
  readonly flow: { readonly speedMS: number; readonly densityKgM3: number; readonly dynamicPressurePa: number; readonly direction: Vec3 };
  /** Time-averaged forces on all bodies (case frame) and the moment about the case moment point. */
  readonly forces: {
    readonly totalN: Vec3;
    readonly momentNm: Vec3;
    readonly dragAxis: Vec3;
    readonly liftAxis: Vec3;
    readonly sideAxis: Vec3;
  };
  readonly perBody: readonly { readonly entityId: string; readonly forceN: Vec3 }[];
  readonly peaks: readonly CfdPeak[];
  readonly probes: readonly CfdProbeValue[];
  readonly history: readonly CfdHistoryRow[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly notModelled: readonly string[];
  readonly defaults: readonly { readonly path: string; readonly value: unknown; readonly source: string }[];
  /** `surface.bin` (per-triangle surface fields, `LLSF` header), base64. */
  readonly surfaceBase64: string;
  /** `slice-<k>.bin` files (`LLSL` header), base64. */
  readonly slices: readonly { readonly name: string; readonly base64: string }[];
}

/** Read-only result store injected by the host (`ExecutionContext.cfdResults`): the record command re-verifies results through it. */
export interface CfdResultPort {
  get(hash: string): CfdResultArtifact | null;
}
