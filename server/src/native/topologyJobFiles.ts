/**
 * `llull-compute topopt` job folder of a topology study (TECHNICAL_SPEC §13.1, §15) and the resume state kept between runs.
 * Index conventions are shared with the native job: voxel `i + nx (j + ny k)`, node `i + (nx+1)(j + (ny+1) k)`, dof `node * dim + c`, y up
 * (the TypeScript `TopologyJob` documents the same). Units are not converted: E in the stress unit of the analysis unit system, lengths in its
 * length unit (the voxel size is converted from document units), forces in its force unit.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TopologyHistoryRow } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { isRecord } from '@lib/isRecord';
import { sha256Hex } from '@lib/sha256';
import { analysisLengthMetres, type TopologyJob } from '@cae/index';
import { f64Bytes, f64Values } from './computeJob';

export type TopologyDevice = 'cpu' | 'gpu' | 'auto';

/** DOF count of the grid (2D: two per node of the single layer). */
function dofCount(job: TopologyJob): number {
  const { nx, ny, nz } = job.grid;
  return job.dimension * (nx + 1) * (ny + 1) * (job.dimension === 2 ? 1 : nz + 1);
}

/** Where a continued run starts: the design, the warm start, the optimiser state (`state.json` text + `mma.f64`) and the iterations done. */
interface JobStart {
  readonly design: Float64Array;
  readonly displacements?: Float64Array;
  readonly state?: string;
  readonly mma?: Float64Array;
  readonly iterationsDone: number;
}

/** `state.json` of an earlier run with its MMA file renamed to the one written next to it. */
function startState(state: string, hasMma: boolean): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return state;
  }
  if (!isRecord(parsed)) return state;
  const mma = parsed['mma'];
  if (!hasMma) return JSON.stringify({ ...parsed, mma: null });
  return JSON.stringify({ ...parsed, mma: isRecord(mma) ? { ...mma, file: 'start_mma.f64' } : mma });
}

/**
 * The files of the job folder (`job.json` + masks, fixed dofs and one force vector per load case); `start` adds the resume files (the iteration cap
 * counts the iterations already done, `startIteration` continues the schedules), `deadlineS` the wall-clock budget after which the job checkpoints.
 */
export function topologyJobFiles(
  doc: CadDocument,
  job: TopologyJob,
  device: TopologyDevice,
  start?: JobStart,
  deadlineS?: number,
): Record<string, Buffer | string> {
  const dofs = dofCount(job);
  const fixed = new Uint8Array(dofs);
  for (const dof of job.fixedDofs) fixed[dof] = 1;
  const files: Record<string, Buffer | string> = {
    'active.u8': Buffer.from(job.active),
    'keep_in.u8': Buffer.from(job.keepIn),
    'keep_out.u8': Buffer.from(job.keepOut),
    'fixed.u8': Buffer.from(fixed),
  };
  const loadCases = job.loadCases.map((loadCase, index) => {
    const forces = new Float64Array(dofs);
    loadCase.dofs.forEach((dof, position) => {
      forces[dof] = (forces[dof] ?? 0) + (loadCase.values[position] ?? 0);
    });
    files[`lc${index}.f64`] = f64Bytes(forces);
    return {
      name: loadCase.name,
      weight: loadCase.weight,
      forces: `lc${index}.f64`,
      ...(loadCase.gravity === undefined ? {} : { gravity: loadCase.gravity }),
    };
  });
  if (start !== undefined) files['start.f64'] = f64Bytes(start.design);
  if (start?.displacements !== undefined) files['start_u.f64'] = f64Bytes(start.displacements);
  if (start?.state !== undefined) {
    files['start_state.json'] = startState(start.state, start.mma !== undefined);
    if (start.mma !== undefined) files['start_mma.f64'] = f64Bytes(start.mma);
  }
  const { settings } = job;
  files['job.json'] = JSON.stringify({
    version: 1,
    dimension: job.dimension,
    grid: {
      nx: job.grid.nx,
      ny: job.grid.ny,
      nz: job.grid.nz,
      voxel: toMetres(doc, job.grid.voxel) / analysisLengthMetres(job.unitSystem),
    },
    material: { e0: job.material.youngsModulus, nu: job.material.poisson },
    thickness: job.thickness,
    volumeFraction: job.volumeFraction,
    objective:
      job.objective.kind === 'min_volume' ? { kind: 'minVolume', maxCompliance: job.objective.maxCompliance } : { kind: 'minCompliance' },
    active: 'active.u8',
    keepIn: 'keep_in.u8',
    keepOut: 'keep_out.u8',
    fixedDofs: 'fixed.u8',
    loadCases,
    settings: {
      penal: settings.penal,
      eminRatio: settings.eminRatio,
      move: settings.move,
      changeTol: settings.changeTol,
      maxIterations: Math.max(1, settings.maxIterations - (start?.iterationsDone ?? 0)),
      filter: { kind: settings.filter.kind, radius: settings.filter.radiusVoxels },
      optimizer: settings.optimizer,
      ...(settings.projection === undefined ? {} : { projection: settings.projection }),
      ...(settings.extrusion === undefined ? {} : { extrusion: settings.extrusion }),
      ...(deadlineS === undefined ? {} : { deadlineS }),
      startIteration: start?.iterationsDone ?? 0,
      device,
    },
    ...(start !== undefined ? { startDesign: 'start.f64' } : {}),
    ...(start?.displacements !== undefined ? { startDisplacements: 'start_u.f64' } : {}),
    ...(start?.state !== undefined ? { startState: 'start_state.json' } : {}),
  });
  return files;
}

/**
 * What the last run of a study left behind: its design variables (`design.f64`), the last solve's displacements (`displacements.f64`, the warm
 * start that makes a resumed run continue bit for bit), the optimiser state (`state.json`, `mma.f64`), the problem they belong to and the
 * iterations so far.
 */
export interface ResumeState {
  readonly design: Float64Array;
  readonly displacements?: Float64Array;
  readonly state?: string;
  readonly mma?: Float64Array;
  readonly iterations: number;
  readonly history: readonly TopologyHistoryRow[];
}

interface ResumeMeta {
  readonly inputHash: string;
  readonly voxels: number;
  readonly iterations: number;
  readonly history: readonly TopologyHistoryRow[];
}

const resumeBase = (directory: string, studyId: string): string => path.join(directory, 'topology-resume', sha256Hex(studyId).slice(0, 24));

/** Writes `bytes` to `file` through a temporary name, or removes `file` when `bytes` is undefined. */
function replaceFile(file: string, bytes: Buffer | string | undefined): void {
  if (bytes === undefined) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(`${file}.${process.pid}.tmp`, bytes);
  renameSync(`${file}.${process.pid}.tmp`, file);
}

/** Keeps the state of a run (finished or checkpointed) so the next `resumeFromLast` run continues it (one state per study, overwritten). */
export function saveResume(directory: string, studyId: string, job: TopologyJob, state: ResumeState): void {
  const base = resumeBase(directory, studyId);
  mkdirSync(path.dirname(base), { recursive: true });
  const meta: ResumeMeta = { inputHash: job.inputHash, voxels: state.design.length, iterations: state.iterations, history: state.history };
  replaceFile(`${base}.f64`, f64Bytes(state.design));
  replaceFile(`${base}.u.f64`, state.displacements === undefined ? undefined : f64Bytes(state.displacements));
  replaceFile(`${base}.state.json`, state.state);
  replaceFile(`${base}.mma.f64`, state.mma === undefined ? undefined : f64Bytes(state.mma));
  writeFileSync(`${base}.json`, JSON.stringify(meta));
}

/**
 * The saved state when it belongs to the current problem (same inputHash and voxel count: settings may differ, e.g. a raised maxIterations),
 * else null.
 */
export function loadResume(directory: string, studyId: string, job: TopologyJob): ResumeState | null {
  const base = resumeBase(directory, studyId);
  if (!existsSync(`${base}.json`) || !existsSync(`${base}.f64`)) return null;
  try {
    const meta: unknown = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    const bytes = readFileSync(`${base}.f64`);
    const voxels = job.grid.nx * job.grid.ny * job.grid.nz;
    if (!isRecord(meta) || meta['inputHash'] !== job.inputHash || meta['voxels'] !== voxels || bytes.length !== 8 * voxels) return null;
    const iterations = meta['iterations'];
    const history = meta['history'];
    if (typeof iterations !== 'number' || !Array.isArray(history)) return null;
    const displacements = readDisplacements(`${base}.u.f64`, job.loadCases.length * dofCount(job));
    const state = existsSync(`${base}.state.json`) ? readFileSync(`${base}.state.json`, 'utf8') : undefined;
    const mma = existsSync(`${base}.mma.f64`) ? f64Values(readFileSync(`${base}.mma.f64`)) : undefined;
    return {
      design: f64Values(bytes),
      ...(displacements === undefined ? {} : { displacements }),
      ...(state === undefined ? {} : { state }),
      ...(mma === undefined ? {} : { mma }),
      iterations,
      history: history as TopologyHistoryRow[],
    };
  } catch {
    return null;
  }
}

/** The saved warm start when it has the expected length (load cases x DOFs); without it a resumed run matches to the PCG tolerance. */
function readDisplacements(file: string, length: number): Float64Array | undefined {
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  return bytes.length === 8 * length ? f64Values(bytes) : undefined;
}
