/** Phases of compute_registration: target stage, ICP stage, quality gates and the record. */

import type { CloudReference, RegistrationRecord } from '@aec/scan/types';
import type { CloudOpSuccess, Mat4 } from '@core/model/pointCloud';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { PointCloudPort } from '@core/model/pointCloud';
import { report } from '@core/commands/noop';
import { refuseScan } from './codes';
import { isSuccess, numberAt, runOp } from './compute';
import { invertAffine, multiply, rotationAngleDeg, translationOf } from './mat4';
import { fromM, toM, vecToM } from './model';
import type { MetricRegion } from './region';

/** Named quality gates (AF-31): target RMS ≤ 3 mm; ICP RMS ≤ 2 × the fixed cloud's median spacing. Above them: warn + unverified. */
const TARGET_RMS_GATE_M = 0.003;
const ICP_RMS_SPACING_FACTOR = 2;
/** Below this overlap an ICP result is SCN_REG_NOT_CONVERGED (§5.8). */
const MIN_OVERLAP = 0.1;

const COMMAND = 'compute_registration';

type Result = Readonly<Record<string, unknown>>;
type Provenance = { device: 'cpu' | 'gpu'; deterministic: boolean; binary: string };

export interface Registration {
  readonly delta: Mat4 | null;
  readonly targetResult: Result | null;
  readonly icpResult: Result | null;
  readonly provenance: Provenance;
}

export interface TargetPair {
  readonly name: string;
  readonly kind: 'sphere' | 'point';
  readonly fixedPoint: readonly number[];
  readonly movingPoint: readonly number[];
  readonly radius?: number | undefined;
}

export const isRefusal = (value: object): value is CommandResult => 'document' in value;

/** The registration record of a document-frame correction `delta` (moving document → fixed document). */
function recordOf(fixed: CloudReference, moving: CloudReference, delta: Mat4): Mat4 {
  const inverse = invertAffine(fixed.transform);
  return inverse === null ? delta : multiply(inverse, multiply(delta, moving.transform));
}

function provenanceOf(ran: CloudOpSuccess): Provenance {
  return { ...ran.provenance };
}

/** Stage 1: Horn closed form over the target pairs. */
export function targetStage(
  doc: CadDocument,
  port: PointCloudPort,
  clouds: readonly CloudReference[],
  targets: readonly TargetPair[],
): Registration | CommandResult {
  if (targets.some((t) => t.kind === 'sphere' && !(t.radius !== undefined && t.radius > 0)))
    return refuseScan(doc, COMMAND, 'SCN_PARAM_INVALID', 'a sphere target needs radius > 0', [], ['targets']);
  const ran = runOp(doc, COMMAND, port, 'register_targets', clouds, {
    targets: targets.map((t) => ({
      name: t.name,
      kind: t.kind,
      fixed: vecToM(doc, t.fixedPoint),
      moving: vecToM(doc, t.movingPoint),
      ...(t.radius !== undefined ? { radius: toM(doc, t.radius) } : {}),
    })),
  });
  if (!isSuccess(ran)) return ran;
  return { delta: ran.result['transform'] as Mat4, targetResult: ran.result, icpResult: null, provenance: provenanceOf(ran) };
}

export interface IcpRequest {
  readonly method: string;
  readonly initial: Mat4 | undefined;
  readonly maxIterations: number;
  readonly trimRatio: number;
  readonly region: MetricRegion;
}

/** Stage 2: trimmed ICP, started from the target stage (when run), else from `initial`, else from the current placement. */
export function icpStage(
  doc: CadDocument,
  port: PointCloudPort,
  fixed: CloudReference,
  moving: CloudReference,
  request: IcpRequest,
  previous: Registration,
): Registration | CommandResult {
  const { initial } = request;
  const movingInverse = invertAffine(moving.transform);
  const start: Mat4 | null =
    previous.delta ??
    (initial !== undefined && movingInverse !== null ? multiply(fixed.transform, multiply(initial, movingInverse)) : null);
  const ran = runOp(doc, COMMAND, port, 'icp', [fixed, moving], {
    method: request.method === 'icp_point_to_plane' ? 'point_to_plane' : 'point_to_point',
    maxIterations: request.maxIterations,
    trimRatio: request.trimRatio,
    region: request.region,
    ...(start !== null ? { initial: start } : {}),
  });
  if (!isSuccess(ran)) return ran;
  return { ...previous, delta: ran.result['transform'] as Mat4, icpResult: ran.result, provenance: provenanceOf(ran) };
}

/** The quality gates, record, data payload and answer (a refusal carrying the record when ICP did not converge). */
export function registrationReport(
  doc: CadDocument,
  ids: { readonly fixedId: string; readonly movingId: string },
  method: RegistrationRecord['method'],
  fixed: CloudReference,
  moving: CloudReference,
  delta: Mat4,
  registered: Registration,
): CommandResult {
  const { fixedId, movingId } = ids;
  const { targetResult, icpResult, provenance } = registered;
  const transform = recordOf(fixed, moving, delta);
  const targetRms = targetResult === null ? null : numberAt(targetResult, 'rms');
  const icpRms = icpResult === null ? null : numberAt(icpResult, 'rms');
  const spacing = icpResult === null ? null : numberAt(icpResult, 'fixedSpacing');
  const overlap = icpResult === null ? undefined : numberAt(icpResult, 'overlap');
  const converged = icpResult === null ? true : icpResult['converged'] === true && (overlap ?? 1) >= MIN_OVERLAP;
  const gates = {
    targetRmsM: { value: TARGET_RMS_GATE_M, source: 'TECHNICAL_SPEC §5.8 named default (AF-31)', defaulted: true },
    icpRmsSpacingFactor: { value: ICP_RMS_SPACING_FACTOR, source: 'TECHNICAL_SPEC §5.8 named default (AF-31)', defaulted: true },
  };
  const exceeded = [
    ...(targetRms !== null && targetRms > TARGET_RMS_GATE_M
      ? [`target RMS ${fromM(doc, targetRms).toPrecision(4)} ${doc.units} above 3 mm`]
      : []),
    ...(icpRms !== null && spacing !== null && icpRms > ICP_RMS_SPACING_FACTOR * spacing ? ['ICP RMS above 2 x the point spacing'] : []),
  ];
  const residuals = ((targetResult?.['targets'] as { name: string; residual: number }[] | undefined) ?? []).map((t) => ({
    name: t.name,
    residual: t.residual,
  }));
  const record: Omit<RegistrationRecord, 'id'> = {
    fixed: fixedId,
    moving: movingId,
    method,
    transform,
    quality: {
      ...(residuals.length > 0 ? { targetResiduals: residuals } : {}),
      rms: icpRms ?? targetRms ?? 0,
      ...(overlap !== undefined ? { overlap } : {}),
      ...(icpResult !== null ? { iterations: numberAt(icpResult, 'iterations') } : {}),
      converged,
    },
    status: exceeded.length > 0 ? 'unverified' : 'computed',
    provenance: {
      method,
      algorithmVersion: `${provenance.binary || 'llull-compute'}/register-1`,
      device: provenance.device,
      deterministic: provenance.deterministic,
    },
  };
  const data = {
    record,
    quality: record.quality,
    rotationDeg: rotationAngleDeg(transform),
    translation: translationOf(transform).map((v) => fromM(doc, v)),
    unit: doc.units,
    gates,
    warnings: exceeded.map((message) => ({ code: 'SCN_REGISTRATION_UNVERIFIED', message })),
    ...(targetResult !== null ? { targets: targetResult['targets'] } : {}),
  };
  if (!converged)
    return {
      ...refuseScan(
        doc,
        COMMAND,
        'SCN_REG_NOT_CONVERGED',
        `ICP did not converge or the overlap is below ${MIN_OVERLAP * 100} % (overlap ${((overlap ?? 0) * 100).toFixed(1)} %)`,
        [fixedId, movingId],
      ),
      data,
    };
  const rmsText = `${fromM(doc, record.quality?.rms ?? 0).toPrecision(4)} ${doc.units}`;
  return report(
    doc,
    `Registration ${movingId} -> ${fixedId} (${method}): rotation ${data.rotationDeg.toFixed(4)} deg, RMS ${rmsText}, status ${record.status}${exceeded.length > 0 ? ` (${exceeded.join('; ')})` : ''}. Apply with apply_registration record=<data.record>.`,
    data,
  );
}
