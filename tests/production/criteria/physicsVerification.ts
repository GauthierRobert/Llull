import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { staleReasons, studiesOf, analyseStudy, type CaseStudy } from '@cae/vnv/studyState';
import type { AnalysisCase } from '@core/model/analysis';
import type { CheckOutcome, Criterion, GradeContext } from '../contract';
import type { PhysicsIntent } from '../physics/intent';

/**
 * Solution-verification criteria of the physics-office job. They read the final document only: a study is recorded by the host transport against the
 * stored artifacts (record_convergence_study re-derives every level there), so the document holds the measured levels, and the report (observed order,
 * extrapolation, GCI or least-squares uncertainty) is the same pure recomputation check_verification does. Staleness is hash-only.
 */

const analysisOf = ({ document }: GradeContext): AnalysisCase | undefined => Object.values(document.analysis?.cases ?? {})[0];
const studiesIn = (context: GradeContext): CaseStudy[] => {
  const analysisCase = analysisOf(context);
  return analysisCase === undefined ? [] : studiesOf(analysisCase);
};

const none = (what: string): CheckOutcome => ({ pass: false, detail: `no ${what}` });
const percent = (fraction: number, digits = 3): string => `${(fraction * 100).toPrecision(digits)} %`;

function setUpCheck(context: GradeContext): CheckOutcome {
  const analysisCase = analysisOf(context);
  if (analysisCase === undefined) return none('analysis');
  const solid = Object.values(analysisCase.parts).some((part) => part.kind === 'solid');
  const probes = Object.values(analysisCase.probes).filter((probe) => probe.quantity === 'u_y');
  const loads = Object.keys(analysisCase.loads ?? {}).length;
  const constraints = Object.keys(analysisCase.constraints ?? {}).length;
  const pass =
    analysisCase.type === 'static' && solid && probes.length > 0 && loads > 0 && constraints > 0 && analysisCase.mesh.order === 2;
  return {
    pass,
    detail: `${analysisCase.type} analysis, ${solid ? 'solid part' : 'no solid part'}, ${constraints} support(s), ${loads} load(s), ${probes.length} u_y probe(s), order ${analysisCase.mesh.order}`,
  };
}

function studyCheck(context: GradeContext, intent: PhysicsIntent): CheckOutcome {
  const studies = studiesIn(context);
  const study = studies[0];
  if (study === undefined) return none('convergence study recorded');
  const pass =
    study.refinement === 'h' && study.levels.length >= intent.levels && study.verified !== false && study.quantity.kind === 'probe';
  return {
    pass,
    detail: `${studies.length} study(ies); ${study.id}: ${study.refinement} study of ${study.quantity.kind}, ${study.levels.length} levels${study.verified === false ? ', recorded WITHOUT its artifacts' : ''}`,
  };
}

function currentCheck(context: GradeContext): CheckOutcome {
  const analysisCase = analysisOf(context);
  const studies = studiesIn(context);
  if (analysisCase === undefined || studies.length === 0) return none('study to be current');
  const stale = studies.flatMap((study) => staleReasons(context.document, analysisCase, study).map((reason) => `${study.id}: ${reason}`));
  return { pass: stale.length === 0, detail: stale.length === 0 ? `${studies.length} study(ies) current` : stale.join('; ') };
}

function orderCheck(context: GradeContext): CheckOutcome {
  const study = studiesIn(context)[0];
  if (study === undefined) return none('study');
  const outcome = analyseStudy(study);
  if (!outcome.ok) return { pass: false, detail: `the study cannot be analysed: ${outcome.code} ${outcome.message}` };
  const { summaryReport: report, method } = outcome.analysis;
  const pass = report.status === 'monotone' && report.p !== undefined && report.p > 0 && report.extrapolated !== undefined;
  return { pass, detail: `${report.status} (${method})${report.p === undefined ? '' : `, observed order ${report.p.toPrecision(4)}`}` };
}

function targetCheck(context: GradeContext, intent: PhysicsIntent): CheckOutcome {
  const study = studiesIn(context)[0];
  if (study === undefined) return none('study');
  const outcome = analyseStudy(study, intent.gciTarget);
  if (!outcome.ok) return { pass: false, detail: `${outcome.code}: ${outcome.message}` };
  const { summaryReport: report, lsq } = outcome.analysis;
  const estimate = lsq?.uncertainty.relative ?? report.gci21Fine;
  return {
    pass: estimate !== undefined && estimate <= intent.gciTarget,
    detail:
      estimate === undefined
        ? 'no error estimate (the study does not converge)'
        : `estimated discretisation error ${percent(estimate)} against the owner's ${percent(intent.gciTarget, 2)}`,
  };
}

function theoryCheck(context: GradeContext, intent: PhysicsIntent): CheckOutcome {
  const study = studiesIn(context)[0];
  if (study === undefined) return none('study');
  const outcome = analyseStudy(study);
  const extrapolated = outcome.ok ? outcome.analysis.summaryReport.extrapolated : undefined;
  if (extrapolated === undefined) return { pass: false, detail: 'no extrapolated value to compare' };
  const error = Math.abs(Math.abs(extrapolated) / intent.tipDeflectionMm - 1);
  return {
    pass: error <= intent.theoryTolerance,
    detail: `extrapolated tip ${Math.abs(extrapolated).toPrecision(5)} mm vs beam theory ${intent.tipDeflectionMm} mm (${percent(error, 3)}, limit ${percent(intent.theoryTolerance, 2)})`,
  };
}

function noExceptionCheck(context: GradeContext): CheckOutcome {
  const accepted = studiesIn(context).filter((study) => study.exception !== undefined);
  return {
    pass: accepted.length === 0 && (context.document.analysis?.exceptionLedger ?? []).length === 0,
    detail:
      accepted.length === 0
        ? 'no verification exception recorded (only a human may sign one)'
        : `exception on ${accepted.map((study) => study.id).join(', ')}`,
  };
}

function reportedCheck(context: GradeContext, intent: PhysicsIntent): CheckOutcome {
  const analysisCase = analysisOf(context);
  if (analysisCase === undefined) return none('analysis');
  const checked = execute(context.document, 'check_verification', { analysisId: analysisCase.id, gciTarget: intent.gciTarget });
  const refused = checked.rejected === true;
  return { pass: !refused, detail: refused ? `check_verification refused: ${checked.summary}` : checked.summary };
}

function reopenCheck({ document }: GradeContext): CheckOutcome {
  const reopened = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(document) });
  const same = JSON.stringify(reopened.document.analysis?.cases) === JSON.stringify(document.analysis?.cases);
  return {
    pass: same,
    detail: same ? 'the saved project reopens with the identical analysis and studies' : `reopened project differs: ${reopened.summary}`,
  };
}

export function physicsVerificationCriteria(intent: PhysicsIntent): Criterion[] {
  const criterion = (id: string, requirement: string, check: (context: GradeContext) => CheckOutcome): Criterion => ({
    id,
    area: 'verification',
    requirement,
    check,
  });
  return [
    criterion('analysis-set-up', 'A static solid analysis with its supports, load, a tip u_y probe and quadratic tetrahedra.', setUpCheck),
    criterion(
      'study-recorded',
      `A mesh-convergence study of the probe with at least ${intent.levels} levels, recorded against the stored artifacts.`,
      (context) => studyCheck(context, intent),
    ),
    criterion('study-current', 'Every recorded study is current: the analysis did not change after it was run.', currentCheck),
    criterion(
      'order-observed',
      'The study converges monotonically: a finite positive observed order and an extrapolated value.',
      orderCheck,
    ),
    criterion(
      'error-within-target',
      `The estimated discretisation error of the finest level is within the owner's ${percent(intent.gciTarget, 2)} target.`,
      (context) => targetCheck(context, intent),
    ),
    criterion(
      'matches-beam-theory',
      `The extrapolated tip deflection is within ${percent(intent.theoryTolerance, 2)} of Euler-Bernoulli + Timoshenko.`,
      (context) => theoryCheck(context, intent),
    ),
    criterion('no-forged-exception', 'No verification exception is recorded: accepting one is a signed human act.', noExceptionCheck),
    criterion('verification-check-runs', 'check_verification answers for the analysis with the owner target.', (context) =>
      reportedCheck(context, intent),
    ),
    criterion('save-load', 'The saved project reopens with the identical analysis and studies.', reopenCheck),
  ];
}
