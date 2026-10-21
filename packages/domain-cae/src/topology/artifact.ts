/**
 * The topology artifact (TR-TOP-07): encoding of the density field, assembly from a solver output and
 * the summary recomputed from an artifact (the trust model of 05 4.1: a recorded summary is a claim about an artifact).
 */

import type {
  FeTopologyArtifact,
  TopologyHistoryRow,
  TopologyResultSummary,
  TopologySolverInfo,
  TopologyStudy,
} from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { base64ToUint8Array, uint8ArrayToBase64 } from '@lib/base64';
import { caseOf } from '../shared/access';
import { HISTORY_ROW_CAP } from './defaults';
import { type TopologyJob } from './job';
import { elasticOf } from './material';

/** What the solver reports (`result.json` of `llull-compute topopt`). */
export interface TopologySolveOutput {
  readonly compliance: number;
  readonly perLoadCase: Readonly<Record<string, number>>;
  readonly iterations: number;
  readonly status: 'converged' | 'max_iterations';
  readonly history: readonly TopologyHistoryRow[];
  readonly device: 'cpu' | 'gpu';
  readonly deterministic: boolean;
  readonly version: string;
}

/** Little-endian float32 bytes of `values` (the layout of `field.bin`). */
export function fieldBytes(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i += 1) view.setFloat32(4 * i, values[i] ?? 0, true);
  return bytes;
}

/** The density field of an artifact, or null when it is not base64 float32 of `nx * ny * nz` values in [0, 1]. */
export function decodeField(artifact: FeTopologyArtifact): Float32Array | null {
  const { nx, ny, nz } = artifact.grid;
  const bytes = base64ToUint8Array(artifact.xPhys);
  if (bytes === null || bytes.length !== 4 * nx * ny * nz) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const field = new Float32Array(nx * ny * nz);
  for (let i = 0; i < field.length; i += 1) {
    const value = view.getFloat32(4 * i, true);
    if (!(value >= -1e-6 && value <= 1 + 1e-6)) return null;
    field[i] = Math.min(1, Math.max(0, value));
  }
  return field;
}

/**
 * Artifact of one run: the field bytes (`field.bin`) and the solver output (`result.json`) with the job they answer.
 * @failure field of the wrong length, or values outside [0, 1] -> an explanation instead of an artifact
 */
export function buildTopologyArtifact(
  job: TopologyJob,
  field: Uint8Array,
  output: TopologySolveOutput,
  jobKind: TopologySolverInfo['job'],
): FeTopologyArtifact | string {
  const artifact: FeTopologyArtifact = {
    kind: 'fe_topology',
    inputHash: job.inputHash,
    settingsHash: job.settingsHash,
    grid: job.grid,
    xPhys: uint8ArrayToBase64(field),
    compliance: output.compliance,
    perLoadCase: output.perLoadCase,
    iterations: output.iterations,
    status: output.status,
    history: output.history,
    solver: { job: jobKind, version: output.version, device: output.device, deterministic: output.deterministic },
  };
  return decodeField(artifact) === null
    ? `field.bin is not ${4 * job.grid.nx * job.grid.ny * job.grid.nz} bytes of float32 densities in [0, 1]`
    : artifact;
}

const FORCE_LENGTH_UNIT = { 'N-mm-t-s': 'N*mm', 'N-m-kg-s': 'N*m', 'lbf-in-slinch-s': 'lbf*in' } as const;

/** At most HISTORY_ROW_CAP rows, evenly spread, always ending with the last iteration. */
function cappedHistory(history: readonly TopologyHistoryRow[]): TopologyHistoryRow[] {
  if (history.length <= HISTORY_ROW_CAP) return [...history];
  const stride = Math.ceil(history.length / HISTORY_ROW_CAP);
  const kept = history.filter((_, index) => index % stride === 0 && index !== history.length - 1);
  return [...kept.slice(0, HISTORY_ROW_CAP - 1), history[history.length - 1] as TopologyHistoryRow];
}

/**
 * Summary of `artifact` for `study`, recomputed from the artifact alone (field statistics) and the document (units, material flags).
 * @invariant compliance, per-load-case values, iterations, status and history are the solver's report; fieldHash binds them to the artifact
 * @failure unknown analysis, or a field that does not decode -> an explanation instead of a summary
 */
export function topologySummary(
  doc: CadDocument,
  study: TopologyStudy,
  artifact: FeTopologyArtifact,
  fieldHash: string,
): TopologyResultSummary | string {
  const analysisCase = caseOf(doc, study.analysisId);
  if (analysisCase === undefined) return `no analysis '${study.analysisId}'`;
  const field = decodeField(artifact);
  if (field === null) return 'the density field of the artifact does not decode';
  const { grid } = artifact;
  let sum = 0;
  let grey = 0;
  let solid = 0;
  for (const value of field) {
    sum += value;
    grey += 4 * value * (1 - value);
    if (value >= study.settings.threshold.value) solid += 1;
  }
  const voxelVolume = grid.voxel ** 2 * (grid.dimension === 2 ? grid.thickness : grid.voxel);
  const elastic = elasticOf(doc, study);
  const reasons = typeof elastic === 'string' ? [elastic] : elastic.unverifiedReasons;
  return {
    fieldHash,
    inputHash: artifact.inputHash,
    settingsHash: artifact.settingsHash,
    grid: { nx: grid.nx, ny: grid.ny, nz: grid.nz, active: grid.active, keepIn: grid.keepIn, keepOut: grid.keepOut },
    iterations: artifact.iterations,
    status: artifact.status,
    compliance: artifact.compliance,
    complianceUnit: FORCE_LENGTH_UNIT[analysisCase.unitSystem],
    perLoadCase: artifact.perLoadCase,
    volumeFraction: sum / Math.max(1, grid.active),
    grey: grey / Math.max(1, grid.active),
    thresholdedVolume: solid * voxelVolume,
    volumeUnit: `${doc.units}^3`,
    history: cappedHistory(artifact.history),
    solver: artifact.solver,
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    concept: true,
  };
}
