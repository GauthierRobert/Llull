/** check_sweep_loft: read-only report on sweeps — frame degeneracy, fold margin, laws — with named tolerances. */

import type { LoftEntity, NurbsSurfaceEntity, SweepEntity } from '../../model/types';
import type { CommandResult } from '../types';
import type { GeometryKernel } from '../../geometry/kernel';
import { defineCommand, z } from '../schema';
import { report, tableRejection } from '../noop';
import { evaluateSweep } from '../../geometry/sweepEval/evaluate';
import type { SectionTransform } from '../../geometry/sweepEval/sectionTransform';
import { sweepSamples } from '../../geometry/sweepEval/inspect';
import { sweepRealisation } from '../../geometry/sweepEval/realisation';
import { fitSweepFaces, fitToleranceOf } from '../../geometry/sweepEval/fitted';
import { helixOverlap } from '../solids/sweepOrientation';
import { REMEDIATION, sig, type Finding, type NamedTolerance } from './checkFindings';
import { checkLoft, checkSheet } from './checkLoft';
import { checkVolume, type VolumeCheck } from './checkVolume';
import { checkOverlap } from './checkOverlap';

const CHECK_SAMPLES = 256;

const refuse = tableRejection({
  SWG_ENTITY_NOT_FOUND: 'pass ids of sweeps, or omit ids to check every sweep',
  SWG_PARAM_INVALID: 'give positive tolerances',
});

/** Section transforms of a sweep along its evaluated frames (null without laws). */
function transformsOf(entity: SweepEntity): SectionTransform[] | null {
  const evaluation = evaluateSweep(entity);
  return 'frames' in evaluation ? evaluation.transforms : null;
}

/** Fits (and exact volumes) measured per call when `ids` is omitted (each costs up to a second); the rest get an info finding asking for `ids`. */
const MAX_UNLISTED_FITS = 8;

/** What the volume-consistency check reads: the kernel (absent = not measured), its limit and the collected comparisons. */
interface VolumeProbe {
  readonly kernel: GeometryKernel | null | undefined;
  readonly tolerance: number;
  readonly checks: VolumeCheck[];
  readonly budget: { left: number };
}

function checkSweep(
  entity: SweepEntity,
  margin: number,
  fitTolerance: number | undefined,
  unit: string,
  fitBudget: { left: number },
  volume: VolumeProbe,
): Finding[] {
  const findings: Finding[] = [];
  const ts = Array.from({ length: CHECK_SAMPLES }, (_, k) => k / (CHECK_SAMPLES - 1));
  const samples = sweepSamples(entity, ts);
  if (!Array.isArray(samples)) {
    const lawProblem = samples.code.startsWith('SWG_LAW');
    findings.push({
      code: lawProblem ? 'SWG_CHECK_LAW_INVALID' : 'SWG_CHECK_FRAME_DEGENERATE',
      severity: 'fail',
      entityId: entity.id,
      value: null,
      limit: null,
      unit: '',
      remediation: REMEDIATION[lawProblem ? 'SWG_CHECK_LAW_INVALID' : 'SWG_CHECK_FRAME_DEGENERATE'] as string,
      message: samples.message,
    });
    return findings;
  }
  const worst = samples.reduce<(typeof samples)[number] | null>(
    (least, sample) => (sample.margin !== null && (least === null || sample.margin < (least.margin as number)) ? sample : least),
    null,
  );
  if (worst !== null && (worst.margin as number) <= margin)
    findings.push({
      code: 'SWG_CHECK_SELF_INTERSECTION_LOCAL',
      severity: 'fail',
      entityId: entity.id,
      at: sig(worst.t),
      value: sig(worst.margin as number),
      limit: margin,
      unit: 'ratio',
      remediation: REMEDIATION.SWG_CHECK_SELF_INTERSECTION_LOCAL as string,
      message: `fold margin ${sig(worst.margin as number)} <= ${margin} at t=${sig(worst.t)} (curvature radius ${sig(worst.curvatureRadius as number)}, section extent ${sig(worst.sectionExtent as number)})`,
    });
  const overlap = helixOverlap(entity, transformsOf(entity));
  if (overlap !== null)
    findings.push({
      code: 'SWG_CHECK_SELF_INTERSECTION_GLOBAL',
      severity: 'fail',
      entityId: entity.id,
      value: null,
      limit: null,
      unit,
      remediation: REMEDIATION.SWG_CHECK_SELF_INTERSECTION_GLOBAL as string,
      message: overlap,
    });
  else {
    const crossing = checkOverlap(entity, unit);
    if (crossing !== null) findings.push(crossing);
  }
  if (volume.kernel !== undefined && volume.kernel !== null && volume.budget.left > 0) {
    volume.budget.left -= 1;
    const measured = checkVolume(entity, volume.kernel, volume.tolerance, unit);
    if (measured !== null) {
      volume.checks.push(measured.check);
      if (measured.finding !== null) findings.push(measured.finding);
    }
  }
  if (sweepRealisation(entity) === 'fitted') {
    const tolerance = fitTolerance ?? fitToleranceOf(entity);
    if (fitBudget.left <= 0) {
      findings.push({
        code: 'SWG_CHECK_FIT_APPROXIMATION',
        severity: 'info',
        entityId: entity.id,
        value: null,
        limit: tolerance,
        unit,
        remediation: 'pass ids to measure the fit of this sweep',
        message: `fitted faces: deviation not measured (more than ${MAX_UNLISTED_FITS} fitted sweeps; list ids to check them)`,
      });
      return findings;
    }
    fitBudget.left -= 1;
    const fit = fitSweepFaces(entity, tolerance);
    const fitted = 'faces' in fit;
    const railMiss = !fitted && fit.code === 'SWG_FIT_TOLERANCE' && entity.rails !== undefined;
    findings.push({
      code: railMiss ? 'SWG_CHECK_RAIL_DEVIATION' : 'SWG_CHECK_FIT_APPROXIMATION',
      severity: fitted ? 'info' : railMiss ? 'fail' : 'warn',
      entityId: entity.id,
      value: fitted ? sig(fit.deviation) : null,
      limit: tolerance,
      unit,
      remediation: REMEDIATION[railMiss ? 'SWG_CHECK_RAIL_DEVIATION' : 'SWG_CHECK_FIT_APPROXIMATION'] as string,
      message: fitted
        ? `laws or a non-default frame: the exact solid is built from ${fit.faces.length} fitted face(s) of ${fit.cells} cells, deviation ${sig(fit.deviation)} ${unit}`
        : `${fit.code}: ${fit.message}; only the mesh is available`,
    });
  }
  return findings;
}

/**
 * @affects none; data = { status, checked, findings [{ code, severity, entityId, at?, value, limit, unit, remediation, message }], volumeChecks [{ entityId, expected, measured, relativeDeviation }], tolerances, provenance }
 * @invariant kernel-optional: the volume-consistency check (SWG_CHECK_VOLUME_MISMATCH) runs only with an exact kernel that reports mass properties; `volumeChecks` lists what was measured
 * @invariant status is "fail" when any finding fails, else "warn" when any warns, else "pass"
 * @failure unknown id / not a sweep, loft or sheet -> SWG_ENTITY_NOT_FOUND; a non-positive tolerance -> SWG_PARAM_INVALID
 */
export const checkSweepLoft = defineCommand({
  name: 'check_sweep_loft',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only check of sweeps and lofts (every sweep and loft when `ids` is omitted; list the ids of swept or lofted sheets to check them too): the frame mode must be defined along the whole path (SWG_CHECK_FRAME_DEGENERATE), the laws finite and positive ' +
    '(SWG_CHECK_LAW_INVALID), and the swept surface must not fold onto itself — at 256 samples the fold margin (path curvature radius / section extent toward the centre of curvature) must stay above ' +
    '`selfIntersectionMargin` (default 1.0; SWG_CHECK_SELF_INTERSECTION_LOCAL). Fitted-face sweeps add an info finding. Returns status pass | warn | fail and findings with code, severity, ' +
    'location t, value, limit, unit and remediation; `tolerances` names every limit with `defaulted` and its `source`. Rail sweeps whose fitted faces miss the rails report SWG_CHECK_RAIL_DEVIATION. Lofts: SWG_CHECK_LOFT_TWIST (neighbouring section starts more than `endAngleRad` apart, including the closing pair of a closed loft: the rulings twist), SWG_CHECK_LOFT_CLOSURE_G1 (a closed loft kinks across its closing seam by more than `endAngleRad`), SWG_CHECK_SURFACE_DEGENERATE (a pinched or folded skin); sheets: SWG_CHECK_SURFACE_DEGENERATE. With an exact kernel, a sweep whose section stays normal to the path and centred on it must have the volume of the integral of its section area along the path within `volumeConsistencyRel` (SWG_CHECK_VOLUME_MISMATCH: a deficit means overlapping turns); `data.volumeChecks` lists the comparisons. End every sweep, loft and swept sheet with this check.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe('Entity ids to check: sweeps, lofts, nurbs_surface sheets. Default: every sweep and loft in the document.')
      .optional(),
    endAngleRad: z
      .number()
      .describe('Largest allowed seam twist between neighbouring loft sections, radians, > 0. Default 0.01 (OCCT TolAngular).')
      .optional(),
    fitTolerance: z
      .number()
      .describe(
        'Largest allowed distance of the fitted exact faces from the evaluator, document units, > 0. Default 1e-7 × the model size (at least 1e-9).',
      )
      .optional(),
    volumeConsistencyRel: z
      .number()
      .describe(
        'Largest allowed relative difference between the exact (kernel) volume of a sweep whose section stays normal to the path and centred on it and the integral of its section area along the path, dimensionless, > 0. Default 1e-4. Measured only with an exact kernel; a larger deficit means the solid overlaps itself.',
      )
      .optional(),
    selfIntersectionMargin: z
      .number()
      .describe(
        'Least allowed fold margin (curvature radius / section extent), dimensionless, > 0. Default 1.0 (the swept envelope folds at exactly 1).',
      )
      .optional(),
  }),
  run: (doc, { ids, selfIntersectionMargin, fitTolerance, endAngleRad, volumeConsistencyRel }, ctx): CommandResult => {
    if (endAngleRad !== undefined && !(endAngleRad > 0))
      return refuse(doc, 'check_sweep_loft', 'SWG_PARAM_INVALID', `endAngleRad must be > 0 (got ${endAngleRad})`, [], ['endAngleRad']);
    if (fitTolerance !== undefined && !(fitTolerance > 0))
      return refuse(doc, 'check_sweep_loft', 'SWG_PARAM_INVALID', `fitTolerance must be > 0 (got ${fitTolerance})`, [], ['fitTolerance']);
    if (volumeConsistencyRel !== undefined && !(volumeConsistencyRel > 0))
      return refuse(
        doc,
        'check_sweep_loft',
        'SWG_PARAM_INVALID',
        `volumeConsistencyRel must be > 0 (got ${volumeConsistencyRel})`,
        [],
        ['volumeConsistencyRel'],
      );
    if (selfIntersectionMargin !== undefined && !(selfIntersectionMargin > 0))
      return refuse(
        doc,
        'check_sweep_loft',
        'SWG_PARAM_INVALID',
        `selfIntersectionMargin must be > 0 (got ${selfIntersectionMargin})`,
        [],
        ['selfIntersectionMargin'],
      );
    const targets: Array<SweepEntity | LoftEntity | NurbsSurfaceEntity> = [];
    for (const id of ids ?? Object.keys(doc.entities)) {
      const entity = doc.entities[id];
      if (entity?.kind === 'sweep' || entity?.kind === 'loft' || (ids !== undefined && entity?.kind === 'nurbs_surface'))
        targets.push(entity);
      else if (ids !== undefined)
        return refuse(doc, 'check_sweep_loft', 'SWG_ENTITY_NOT_FOUND', `no sweep, loft or sheet with id "${id}"`, [id], ['ids']);
    }
    const margin = selfIntersectionMargin ?? 1;
    const fitBudget = { left: ids === undefined ? MAX_UNLISTED_FITS : Number.POSITIVE_INFINITY };
    const angle = endAngleRad ?? 0.01;
    const volume: VolumeProbe = {
      kernel: ctx?.kernel,
      tolerance: volumeConsistencyRel ?? 1e-4,
      checks: [],
      budget: { left: ids === undefined ? MAX_UNLISTED_FITS : Number.POSITIVE_INFINITY },
    };
    const findings = targets.flatMap((entity) =>
      entity.kind === 'sweep'
        ? checkSweep(entity, margin, fitTolerance, doc.units, fitBudget, volume)
        : entity.kind === 'loft'
          ? checkLoft(entity, angle, doc.units)
          : checkSheet(entity, doc.units),
    );
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
    const tolerances: Record<string, NamedTolerance> = {
      fitTolerance: {
        value: fitTolerance ?? 1e-7,
        unit: fitTolerance === undefined ? 'fraction of model size' : doc.units,
        defaulted: fitTolerance === undefined,
        source: 'llull choice: 1e-7 x model size keeps the exact volume within ~1e-6 (TECHNICAL_SPEC 5.8 names 1e-6 x model size)',
      },
      endAngleRad: { value: angle, unit: 'rad', defaulted: endAngleRad === undefined, source: 'OCCT TolAngular 1e-2 (TECHNICAL_SPEC 5.8)' },
      volumeConsistencyRel: {
        value: volume.tolerance,
        unit: 'ratio',
        defaulted: volumeConsistencyRel === undefined,
        source: 'llull choice: far above the fit error (1e-6), far below any real overlap (TECHNICAL_SPEC 5.8)',
      },
      selfIntersectionMargin: {
        value: margin,
        unit: 'ratio',
        defaulted: selfIntersectionMargin === undefined,
        source: 'envelope fold condition: curvature radius = section extent (TECHNICAL_SPEC 5.4)',
      },
    };
    const fails = findings.filter((f) => f.severity === 'fail').length;
    return report(
      doc,
      `check_sweep_loft: ${status} — ${targets.length} entit(ies) checked, ${fails} failing finding(s), ${findings.length - fails} other.`,
      {
        status,
        checked: targets.map((t) => t.id),
        findings,
        volumeChecks: volume.checks,
        tolerances,
        provenance: { method: 'frame evaluation and fold margin at 256 arc-length samples', inputs: { ids: targets.map((t) => t.id) } },
      },
    );
  },
});
