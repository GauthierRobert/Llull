/**
 * The `llull-compute flow-query` job of a result query (12 CFD M3a): the recorded result of the case must be trusted (bundle in the store,
 * hashing to the recorded hash, recorded summary equal to the one recomputed from it) and current (case and flow surface unchanged: a stale
 * field would be read in a frame and around a geometry that no longer exist). Pure: the host writes `job.json` + the field file and runs it.
 * Contract: `llull_flow_core::query`.
 */

import type { z } from '@core/commands/schema';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CfdResultArtifact, CfdResultPort } from '@core/model/cfdResult';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { CfdCase } from '@aero/cfd/types';
import { canonicalJson } from '@lib/canonicalJson';
import { isRecord } from '@lib/isRecord';
import { sha256Hex } from '@lib/sha256';
import { caseOf, cfdSlice } from './caseDoc';
import { caseFrame } from './frame';
import {
  CFD_QUERY_LIMITS,
  cfdProbeParams,
  cfdSliceParams,
  cfdStreamlinesParams,
  rakeSeeds,
  type CfdProbeParams,
  type CfdSliceParams,
  type CfdStreamlinesParams,
} from './queryParams';
import { resultStaleness } from './staleness';
import { cfdSummary } from './summary';

export type FlowQueryOp = 'probe' | 'slice' | 'streamlines';

export type FlowQueryRequest =
  | { readonly op: 'probe'; readonly params: CfdProbeParams }
  | { readonly op: 'slice'; readonly params: CfdSliceParams }
  | { readonly op: 'streamlines'; readonly params: CfdStreamlinesParams };

export interface FlowQueryRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

interface NamedDefault {
  readonly path: string;
  readonly value: unknown;
  readonly source: string;
}

export interface FlowQueryInput {
  readonly ok: true;
  readonly caseId: string;
  readonly resultsHash: string;
  readonly artifact: CfdResultArtifact;
  /** `job.json` (the host adds nothing: the field file is `field.bin`, bound by `fieldSha256`). */
  readonly job: Readonly<Record<string, unknown>>;
  readonly defaults: readonly NamedDefault[];
  /** Seeds of a streamline query (world metres). */
  readonly seeds: readonly Vec3[];
}

const refuse = (code: string, message: string, ids: readonly string[]): FlowQueryRefusal => ({ ok: false, code, message, ids });

const invalid = (op: FlowQueryOp, error: z.ZodError): FlowQueryRefusal =>
  refuse(
    'CFD_PARAM_INVALID',
    `cfd_${op}: ${error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ')}`,
    [],
  );

/** Validated params of `op`, or CFD_PARAM_INVALID naming every bad path. */
export function parseFlowQuery(op: FlowQueryOp, params: unknown): FlowQueryRequest | FlowQueryRefusal {
  if (op === 'probe') {
    const parsed = cfdProbeParams.safeParse(params);
    return parsed.success ? { op, params: parsed.data } : invalid(op, parsed.error);
  }
  if (op === 'slice') {
    const parsed = cfdSliceParams.safeParse(params);
    return parsed.success ? { op, params: parsed.data } : invalid(op, parsed.error);
  }
  const parsed = cfdStreamlinesParams.safeParse(params);
  return parsed.success ? { op, params: parsed.data } : invalid(op, parsed.error);
}

interface Trusted {
  readonly cfdCase: CfdCase;
  readonly artifact: CfdResultArtifact;
  readonly resultsHash: string;
}

/**
 * The trusted, current result of `caseId`.
 * @failure unknown case -> CFD_CASE_NOT_FOUND; nothing recorded -> CFD_NO_RESULT; recorded without its bundle, or the bundle is not in this
 *   machine's store -> CFD_RESULT_MISSING; bundle hash or recomputed summary differ -> CFD_RESULT_HASH_MISMATCH; case or flow surface changed
 *   since the solve -> CFD_RESULT_STALE
 */
function trustedResult(
  doc: CadDocument,
  caseId: string,
  port: CfdResultPort | null,
  kernel: GeometryKernel | null,
): Trusted | FlowQueryRefusal {
  const cfdCase = caseOf(doc, caseId);
  if (cfdCase === undefined) return refuse('CFD_CASE_NOT_FOUND', `no flow case '${caseId}': create_cfd_case first`, [caseId]);
  const recorded = cfdSlice(doc).results[caseId];
  if (recorded === undefined) return refuse('CFD_NO_RESULT', `case '${caseId}' has no recorded result: run cfd_solve`, [caseId]);
  const { resultsHash } = recorded;
  const ids = [caseId, resultsHash];
  if (!recorded.verified)
    return refuse(
      'CFD_RESULT_MISSING',
      `the result of '${caseId}' was recorded without its bundle on this machine: run cfd_solve here`,
      ids,
    );
  const artifact = port?.get(resultsHash) ?? null;
  if (artifact === null)
    return refuse(
      'CFD_RESULT_MISSING',
      `bundle ${resultsHash.slice(0, 12)} of '${caseId}' is not in this machine's result store: run cfd_solve`,
      ids,
    );
  if (sha256Hex(canonicalJson(artifact)) !== resultsHash || artifact.caseId !== caseId)
    return refuse('CFD_RESULT_HASH_MISMATCH', `the stored bundle does not hash to ${resultsHash} of case '${caseId}'`, ids);
  if (canonicalJson(cfdSummary(cfdCase, artifact, resultsHash)) !== canonicalJson(recorded))
    return refuse('CFD_RESULT_HASH_MISMATCH', `the recorded summary of '${caseId}' differs from the one recomputed from its bundle`, ids);
  // The store checks a bundle's hash, not its shape: one written before M3a has no field file to query.
  const field: unknown = artifact.field;
  if (!isRecord(field) || typeof field['sha256'] !== 'string')
    return refuse(
      'CFD_RESULT_MISSING',
      `bundle ${resultsHash.slice(0, 12)} of '${caseId}' has no field file (solved before M3a): run cfd_solve`,
      ids,
    );
  const staleness = resultStaleness(doc, cfdCase, recorded, kernel);
  if (staleness.stale)
    return refuse('CFD_RESULT_STALE', `the result of '${caseId}' is stale (${staleness.reasons.join('; ')}): solve again`, ids);
  return { cfdCase, artifact, resultsHash };
}

const cellM = (artifact: CfdResultArtifact): number => artifact.grid.cellM;
const largestExtentM = (artifact: CfdResultArtifact): number =>
  Math.max(artifact.grid.nx, artifact.grid.ny, artifact.grid.nz) * artifact.grid.cellM;

interface Section {
  readonly section: Readonly<Record<string, unknown>>;
  readonly defaults: readonly NamedDefault[];
  readonly seeds: readonly Vec3[];
}

function sectionOf(request: FlowQueryRequest, artifact: CfdResultArtifact): Section | string {
  const h = cellM(artifact);
  if (request.op === 'probe') return { section: { probe: { pointsM: request.params.points } }, defaults: [], seeds: [] };
  if (request.op === 'slice') {
    const { params } = request;
    if (!(Math.hypot(...params.normal) > 1e-12)) return `normal [${params.normal.join(', ')}] is not a direction (length below 1e-12)`;
    const defaults: NamedDefault[] = [
      ...(params.field === undefined ? [{ path: 'field', value: 'speed', source: 'llull default' }] : []),
      ...(params.spacingM === undefined ? [{ path: 'spacingM', value: h, source: 'the solver cell size (TECHNICAL_SPEC §5.5)' }] : []),
      ...(params.extentM === undefined ? [{ path: 'extentM', value: largestExtentM(artifact), source: 'the largest grid extent' }] : []),
    ];
    return {
      section: {
        slice: {
          originM: params.origin,
          normal: params.normal,
          field: params.field ?? 'speed',
          spacingM: params.spacingM ?? h,
          extentM: params.extentM ?? largestExtentM(artifact),
          dynamicPressurePa: artifact.flow.dynamicPressurePa,
        },
      },
      defaults,
      seeds: [],
    };
  }
  const { params } = request;
  const seeds = rakeSeeds(params.rake);
  if (typeof seeds === 'string') return seeds;
  if (params.stepM !== undefined && params.stepM > h)
    return `stepM ${params.stepM} m exceeds the solver cell ${h} m (TECHNICAL_SPEC §5.5: step <= h)`;
  const stepM = params.stepM ?? h / 2;
  const maxLengthM = params.maxLengthM ?? 3 * artifact.grid.nx * h;
  const maxSteps = params.maxSteps ?? Math.min(CFD_QUERY_LIMITS.maxSteps, Math.max(1, Math.ceil(maxLengthM / stepM)));
  const minSpeedMS = 1e-4 * artifact.flow.speedMS;
  const toleranceM = h / 4;
  const defaults: NamedDefault[] = [
    ...(params.stepM === undefined ? [{ path: 'stepM', value: stepM, source: 'half the solver cell' }] : []),
    ...(params.maxLengthM === undefined
      ? [{ path: 'maxLengthM', value: maxLengthM, source: '3 domain lengths (TECHNICAL_SPEC §5.5)' }]
      : []),
    ...(params.maxSteps === undefined ? [{ path: 'maxSteps', value: maxSteps, source: 'maxLengthM / stepM, capped at 20000' }] : []),
    ...(params.direction === undefined ? [{ path: 'direction', value: 'both', source: 'TECHNICAL_SPEC §5.5 (both directions)' }] : []),
    ...(params.device === undefined ? [{ path: 'device', value: 'auto', source: 'llull default (GPU when present)' }] : []),
    { path: 'minSpeedMS', value: minSpeedMS, source: 'stagnation below 1e-4 of the free-stream speed (TECHNICAL_SPEC §5.5)' },
    { path: 'toleranceM', value: toleranceM, source: 'chordal decimation at a quarter cell (TECHNICAL_SPEC §5.5)' },
  ];
  return {
    section: {
      streamlines: {
        seedsM: seeds,
        stepM,
        maxLengthM,
        maxSteps,
        minSpeedMS,
        direction: params.direction ?? 'both',
        toleranceM,
        device: params.device ?? 'auto',
      },
    },
    defaults,
    seeds,
  };
}

/**
 * The query job of `request` on the recorded result of its case.
 * @failure see `trustedResult`; a zero slice normal, a plane rake over 4096 seeds or a step above the cell -> CFD_PARAM_INVALID
 */
export function flowQueryInput(
  doc: CadDocument,
  request: FlowQueryRequest,
  port: CfdResultPort | null,
  kernel: GeometryKernel | null,
): FlowQueryInput | FlowQueryRefusal {
  const { caseId } = request.params;
  const trusted = trustedResult(doc, caseId, port, kernel);
  if ('ok' in trusted) return trusted;
  const { cfdCase, artifact, resultsHash } = trusted;
  const built = sectionOf(request, artifact);
  if (typeof built === 'string') return refuse('CFD_PARAM_INVALID', `cfd_${request.op}: ${built}`, [caseId]);
  const frame = caseFrame(cfdCase.flowAxis, cfdCase.upAxis);
  const job = {
    version: 1,
    field: 'field.bin',
    fieldSha256: artifact.field.sha256,
    frame: { x: frame.x, y: frame.y, z: frame.z },
    op: request.op,
    ...built.section,
  };

  return { ok: true, caseId, resultsHash, artifact, job, defaults: built.defaults, seeds: built.seeds };
}
