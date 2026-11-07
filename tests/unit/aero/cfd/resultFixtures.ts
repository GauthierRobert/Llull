/** A sphere case with a recorded, trusted flow result (bundle in an in-memory port), as the M3a result queries need it. */

import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CfdResultArtifact, CfdResultPort } from '@core/model/cfdResult';
import type { CadDocument } from '@core/model/types';
import type { CfdCase } from '@aero/cfd/types';
import { buildFlowJob } from '@aero/cfd/flowJob';
import { flowResultArtifact, parseFlowResult } from '@aero/cfd/flowResult';
import { cfdSummary } from '@aero/cfd/summary';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { addBody, metreDocument, withCase } from './fixtures';

export interface Recorded {
  readonly doc: CadDocument;
  readonly ballId: string;
  readonly artifact: CfdResultArtifact;
  readonly hash: string;
  readonly port: CfdResultPort;
  readonly ctx: ExecutionContext;
}

export const FIELD_SHA = 'a'.repeat(64);

/** `artifactPatch` is applied to the artifact before it is hashed (e.g. a symmetry case). `caseOverrides` reach `withCase`. */
export function recordedSphere(caseOverrides: Record<string, unknown> = {}): Recorded {
  const ball = addBody(metreDocument(), 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
  const doc = withCase(ball.doc, [ball.id], {
    freestream: { speedMS: 2, air: { densityKgM3: 1, temperatureK: 288.15, viscosityPaS: 0.01 } },
    reference: { areaM2: 0.7853981634, lengthM: 1 },
    cellsPerReferenceLength: 8,
    ...caseOverrides,
  });
  const cfdCase = doc.cfd?.cases['c1'] as CfdCase;
  const built = buildFlowJob(doc, cfdCase, null, { maxSteps: 100 });
  if (!built.ok) throw new Error(built.message);
  const { job } = built;
  const q = 0.5 * job.caseJson.flow.densityKgM3 * job.caseJson.flow.speedMS ** 2;
  const qa = q * job.caseJson.reference.areaM2;
  const totalN = [0.5, 0, 0.02];
  const result = {
    version: 1,
    caseId: 'c1',
    solver: 'lbm',
    converged: true,
    steps: 1200,
    averagedSteps: 400,
    timeS: 3.2,
    elapsedS: 1.5,
    device: 'cpu',
    deterministic: true,
    precision: 'f64',
    halfModel: false,
    memory: { bytesPerCell: 395, gpuBytesPerCell: 204, cpuBytesPerCell: 395, bytes: 2880 * 395 },
    grid: { nx: 20, ny: 12, nz: 12, cellM: 0.125, cells: 2880, fluidCells: 2800, solidCells: 33, originM: [-1, -0.75, -0.75] },
    lattice: { tau: 0.6, uLattice: 0.0577, dtS: 0.0072, flowThroughSteps: 400, les: true, smagorinsky: 0.1, reynolds: 200 },
    forces: {
      totalN,
      momentNm: [0, 0, 0],
      dragN: 0.5,
      liftN: 0.02,
      sideN: 0,
      cd: 0.5 / qa,
      cl: 0.02 / qa,
      cs: 0,
      cm: [0, 0, 0],
      cdAM2: 0.5 / q,
      dynamicPressurePa: q,
      dragAxis: [1, 0, 0],
      liftAxis: [0, 0, 1],
      sideAxis: [0, 1, 0],
    },
    perBody: [{ entityId: ball.id, forceN: totalN }],
    peaks: [],
    probes: [],
    history: [],
    warnings: [],
    notModelled: [],
    slices: [],
    field: 'field.bin',
  };
  const parsed = parseFlowResult(JSON.stringify(result));
  if (typeof parsed === 'string') throw new Error(parsed);
  const artifact = flowResultArtifact(
    parsed,
    job,
    { surface: new Uint8Array(4), slices: [], field: { sha256: FIELD_SHA, bytes: 56 } },
    '9.9.9',
  );
  if (typeof artifact === 'string') throw new Error(artifact);
  const hash = sha256Hex(canonicalJson(artifact));
  const port: CfdResultPort = { get: (key) => (key === hash ? artifact : null) };
  const ctx = { ...defaultContext(), cfdResults: port };
  const recorded = execute(
    doc,
    'record_cfd_results',
    { caseId: 'c1', resultsHash: hash, summary: cfdSummary(cfdCase, artifact, hash) },
    ctx,
  );
  if (recorded.rejected === true) throw new Error(recorded.summary);
  return { doc: recorded.document, ballId: ball.id, artifact, hash, port, ctx };
}
