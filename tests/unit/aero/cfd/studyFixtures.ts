/** A sphere case with a recorded grid study over three bundles (second order in h) behind an in-memory result port. */

import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExecutionContext } from '@core/commands/types';
import type { CfdResultArtifact, CfdResultPort } from '@core/model/cfdResult';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { recordedSphere } from './resultFixtures';

export interface StudyLevel {
  readonly artifact: CfdResultArtifact;
  readonly hash: string;
}

export interface RecordedStudy {
  readonly doc: CadDocument;
  readonly ctx: ExecutionContext;
  readonly hashes: readonly string[];
}

/** The recorded sphere solved at cell size `cellM` with drag `dragN`; `patch` is applied before hashing. */
export function studyLevel(cellM: number, dragN: number, patch: Partial<CfdResultArtifact> = {}): StudyLevel {
  const base = recordedSphere().artifact;
  const artifact: CfdResultArtifact = {
    ...base,
    grid: { ...base.grid, cellM, cells: Math.round(1000 / cellM) },
    forces: { ...base.forces, totalN: [dragN, 0, 0.02] },
    ...patch,
  };
  return { artifact, hash: sha256Hex(canonicalJson(artifact)) };
}

export function portOf(levels: readonly StudyLevel[]): CfdResultPort {
  return { get: (key) => levels.find((entry) => entry.hash === key)?.artifact ?? null };
}

/** The case with its drag study recorded (f = 0.5 + 4 h^2 on h = 0.05, 0.1, 0.2). */
export function recordedGridStudy(kernel: GeometryKernel | null = null): RecordedStudy {
  const recorded = recordedSphere({}, kernel);
  const { geometryHash, kernel: kernelName } = recorded.artifact;
  const levels = [0.05, 0.1, 0.2].map((h) => studyLevel(h, 0.5 + 4 * h * h, { geometryHash, kernel: kernelName }));
  const ctx = { ...recorded.ctx, cfdResults: portOf(levels) };
  const hashes = levels.map((entry) => entry.hash);
  const result = execute(recorded.doc, 'record_cfd_grid_study', { caseId: 'c1', resultsHashes: hashes }, ctx);
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, ctx, hashes };
}
