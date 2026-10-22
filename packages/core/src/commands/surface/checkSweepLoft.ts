/** check_sweep_loft: read-only report on sweeps — frame degeneracy, fold margin, laws — with named tolerances. */

import type { SweepEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report, tableRejection } from '../noop';
import { roundSignificant } from '../../lib/significant';
import { evaluateSweep } from '../../geometry/sweepEval/evaluate';
import type { SectionTransform } from '../../geometry/sweepEval/laws';
import { sweepSamples } from '../../geometry/sweepEval/inspect';
import { sweepRealisation } from '../../geometry/sweepEval/realisation';
import { fitSweepFaces, fitToleranceOf } from '../../geometry/sweepEval/fitted';
import { helixOverlap } from '../solids/sweepOrientation';

const sig = (value: number): number => roundSignificant(value, 10);
const CHECK_SAMPLES = 256;

type Severity = 'fail' | 'warn' | 'info';

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly entityId: string;
  readonly at?: number;
  readonly value: number | null;
  readonly limit: number | null;
  readonly unit: string;
  readonly remediation: string;
  readonly message: string;
}

const REMEDIATION: Readonly<Record<string, string>> = {
  SWG_CHECK_SELF_INTERSECTION_LOCAL:
    'use a smaller section or scale, or a larger bend radius, so that the fold margin stays above the limit',
  SWG_CHECK_FRAME_DEGENERATE: 'rebuild the sweep with orientation minimal, or another direction',
  SWG_CHECK_LAW_INVALID: 'fix the twist / scale / area laws so that they are finite, and scale / area positive',
  SWG_CHECK_SELF_INTERSECTION_GLOBAL: 'use a larger pitch or a smaller section so neighbouring turns do not touch',
  SWG_CHECK_FIT_APPROXIMATION:
    'none for an info finding; a warning means the exact solid is not built (mesh only): loosen fitTolerance or simplify the sweep',
};

const refuse = tableRejection({
  SWG_ENTITY_NOT_FOUND: 'pass ids of sweeps, or omit ids to check every sweep',
  SWG_PARAM_INVALID: 'give positive tolerances',
});

interface NamedTolerance {
  readonly value: number;
  readonly unit: string;
  readonly defaulted: boolean;
  readonly source: string;
}

/** Section transforms of a sweep along its evaluated frames (null without laws). */
function transformsOf(entity: SweepEntity): SectionTransform[] | null {
  const evaluation = evaluateSweep(entity);
  return 'frames' in evaluation ? evaluation.transforms : null;
}

/** Fits measured per call when `ids` is omitted (each fit costs up to a second); the rest get an info finding asking for `ids`. */
const MAX_UNLISTED_FITS = 8;

function checkSweep(
  entity: SweepEntity,
  margin: number,
  fitTolerance: number | undefined,
  unit: string,
  fitBudget: { left: number },
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
    findings.push({
      code: 'SWG_CHECK_FIT_APPROXIMATION',
      severity: fitted ? 'info' : 'warn',
      entityId: entity.id,
      value: fitted ? sig(fit.deviation) : null,
      limit: tolerance,
      unit,
      remediation: REMEDIATION.SWG_CHECK_FIT_APPROXIMATION as string,
      message: fitted
        ? `laws or a non-default frame: the exact solid is built from ${fit.faces.length} fitted face(s) of ${fit.cells} cells, deviation ${sig(fit.deviation)} ${unit}`
        : `${fit.code}: ${fit.message}; only the mesh is available`,
    });
  }
  return findings;
}

/**
 * @affects none; data = { status, checked, findings [{ code, severity, entityId, at?, value, limit, unit, remediation, message }], tolerances, provenance }
 * @invariant status is "fail" when any finding fails, else "warn" when any warns, else "pass"
 * @failure unknown id / not a sweep -> SWG_ENTITY_NOT_FOUND; a non-positive tolerance -> SWG_PARAM_INVALID
 */
export const checkSweepLoft = defineCommand({
  name: 'check_sweep_loft',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only check of sweeps (every sweep when `ids` is omitted): the frame mode must be defined along the whole path (SWG_CHECK_FRAME_DEGENERATE), the laws finite and positive ' +
    '(SWG_CHECK_LAW_INVALID), and the swept surface must not fold onto itself — at 256 samples the fold margin (path curvature radius / section extent toward the centre of curvature) must stay above ' +
    '`selfIntersectionMargin` (default 1.0; SWG_CHECK_SELF_INTERSECTION_LOCAL). Fitted-face sweeps add an info finding. Returns status pass | warn | fail and findings with code, severity, ' +
    'location t, value, limit, unit and remediation; `tolerances` names every limit with `defaulted` and its `source`. End every twist / scale / orientation sweep with this check. Lofts are not checked yet.',
  params: z.object({
    ids: z.array(z.string()).describe('Sweep entity ids to check. Default: every sweep in the document.').optional(),
    fitTolerance: z
      .number()
      .describe(
        'Largest allowed distance of the fitted exact faces from the evaluator, document units, > 0. Default 1e-7 × the model size (at least 1e-9).',
      )
      .optional(),
    selfIntersectionMargin: z
      .number()
      .describe(
        'Least allowed fold margin (curvature radius / section extent), dimensionless, > 0. Default 1.0 (the swept envelope folds at exactly 1).',
      )
      .optional(),
  }),
  run: (doc, { ids, selfIntersectionMargin, fitTolerance }): CommandResult => {
    if (fitTolerance !== undefined && !(fitTolerance > 0))
      return refuse(doc, 'check_sweep_loft', 'SWG_PARAM_INVALID', `fitTolerance must be > 0 (got ${fitTolerance})`, [], ['fitTolerance']);
    if (selfIntersectionMargin !== undefined && !(selfIntersectionMargin > 0))
      return refuse(
        doc,
        'check_sweep_loft',
        'SWG_PARAM_INVALID',
        `selfIntersectionMargin must be > 0 (got ${selfIntersectionMargin})`,
        [],
        ['selfIntersectionMargin'],
      );
    const targets: SweepEntity[] = [];
    for (const id of ids ?? Object.keys(doc.entities)) {
      const entity = doc.entities[id];
      if (entity?.kind === 'sweep') targets.push(entity);
      else if (ids !== undefined) return refuse(doc, 'check_sweep_loft', 'SWG_ENTITY_NOT_FOUND', `no sweep with id "${id}"`, [id], ['ids']);
    }
    const margin = selfIntersectionMargin ?? 1;
    const fitBudget = { left: ids === undefined ? MAX_UNLISTED_FITS : Number.POSITIVE_INFINITY };
    const findings = targets.flatMap((entity) => checkSweep(entity, margin, fitTolerance, doc.units, fitBudget));
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
    const tolerances: Record<string, NamedTolerance> = {
      fitTolerance: {
        value: fitTolerance ?? 1e-7,
        unit: fitTolerance === undefined ? 'fraction of model size' : doc.units,
        defaulted: fitTolerance === undefined,
        source: 'llull choice: 1e-7 x model size keeps the exact volume within ~1e-6 (TECHNICAL_SPEC 5.8 names 1e-6 x model size)',
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
      `check_sweep_loft: ${status} — ${targets.length} sweep(s) checked, ${fails} failing finding(s), ${findings.length - fails} other.`,
      {
        status,
        checked: targets.map((t) => t.id),
        findings,
        tolerances,
        provenance: { method: 'frame evaluation and fold margin at 256 arc-length samples', inputs: { ids: targets.map((t) => t.id) } },
      },
    );
  },
});
