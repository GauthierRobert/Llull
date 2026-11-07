import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { MeshControls } from '@core/model/analysis';
import { analysisInputHash } from '@cae/hash/inputHash';
import { levelDocument, withStudy, type CaseStudy } from '@cae/vnv/studyState';
import { gradeContext, gradeScenario } from './grade';
import { physicsBenchmarks } from './scenarios/physicsBenchmarks';
import { physicsIntent } from './physics/intent';
import { buildModel } from './physics/script';

/**
 * The criteria of the physics-benchmarks scenario, graded in-process: the model is built from the validation plan, a study of a KNOWN law
 * (u(h) = U0 + C h^2, U0 = the beam-theory tip deflection, hand oracle: order 2, extrapolated U0) is recorded by hand into the document (levels bound
 * to the analysis by their input hashes), and each criterion is shown to pass on it and to fail when the thing it guards breaks. The study itself
 * is produced by the real pipeline in the scripted gate and in server/tests/feaConvergence.test.ts.
 */

const intent = physicsIntent;
const U0 = intent.tipDeflectionMm;
const C = 0.02;
const SIZES = [0.25, 0.5, 1];

function modelDocument(): { doc: CadDocument; analysisId: string } {
  const { document, analysisId } = buildModel(intent.planSteps);
  return { doc: document, analysisId };
}

function studied(values: readonly number[], extra: Partial<CaseStudy> = {}): { doc: CadDocument; analysisId: string } {
  const { doc, analysisId } = modelDocument();
  const analysisCase = doc.analysis?.cases[analysisId];
  if (analysisCase === undefined) throw new Error('no analysis');
  const probeId = Object.keys(analysisCase.probes)[0] ?? '';
  const levels = SIZES.map((size, index) => {
    const controls: MeshControls = { ...analysisCase.mesh, globalSize: size };
    const h = 0.8 * size;
    return {
      index,
      controls,
      elements: [1000, 125, 16][index] ?? 1,
      h,
      value: values[index] ?? Number.NaN,
      meshHash: 'a'.repeat(64),
      resultsHash: `${index}`.repeat(64),
      inputHash: analysisInputHash(levelDocument(doc, analysisCase, 'h', { controls, h }), analysisId, 'full'),
      solver: 'CalculiX',
      solverVersion: '2.21',
      mesher: 'netgen',
      mesherVersion: '6',
    };
  });
  const study: CaseStudy = {
    id: 'cs-1.1',
    analysisId,
    quantity: { kind: 'probe', probeId, loadCase: 'LC1' },
    unit: 'mm',
    refinement: 'h',
    ratio: 2,
    measure: { value: 8, dimension: 3 },
    levels,
    safetyFactor: { value: 1.25, source: 'Roache 1994; Celik et al. 2008', defaulted: true },
    ...extra,
  };
  return { doc: withStudy(doc, analysisCase, study), analysisId };
}

const law = SIZES.map((size) => U0 + C * (0.8 * size) ** 2);
const grade = (doc: CadDocument): ReturnType<typeof gradeScenario> => gradeScenario(physicsBenchmarks, 'scripted', gradeContext(doc));
const failing = (doc: CadDocument): string[] =>
  grade(doc)
    .checks.filter((check) => !check.pass)
    .map((check) => check.id);

describe('physics-benchmarks scenario', () => {
  it('its script names the ids the plan mints, ends with the study and the verification check, and is repeatable', () => {
    const script = physicsBenchmarks.script;
    const { doc, analysisId } = modelDocument();
    expect(script.map((call) => call.tool)).toEqual(['build_project', 'run_convergence_study', 'check_verification']);
    const study = script.find((call) => call.tool === 'run_convergence_study');
    expect(study?.args['analysisId']).toBe(analysisId);
    expect(Object.keys(doc.analysis?.cases[analysisId]?.probes ?? {})).toContain((study?.args['quantity'] as { probeId: string }).probeId);
    expect(JSON.stringify(physicsBenchmarks.script)).toBe(JSON.stringify(script));
    expect(physicsBenchmarks.hostTools).toEqual(['run_convergence_study']);
  });

  it('every criterion passes on a model with a current, converging study of the beam-theory law', () => {
    const { doc } = studied(law);
    const report = grade(doc);
    expect(report.regressions, report.checks.map((check) => `${check.id}: ${check.detail}`).join('\n')).toEqual([]);
    expect(report.passed).toBe(report.total);
    expect(report.checks.find((check) => check.id === 'order-observed')?.detail).toMatch(
      /monotone \(celik2008-gci\), observed order 2\.000/,
    );
  });

  it('the starting document (empty) fails the job: the agent gate needs criteria to earn', () => {
    expect(grade(createEmptyDocument()).checks.filter((check) => !check.pass).length).toBeGreaterThan(5);
  });

  it('a model with no study fails the study criteria but keeps the set-up', () => {
    expect(failing(modelDocument().doc)).toEqual(
      expect.arrayContaining(['study-recorded', 'study-current', 'order-observed', 'error-within-target', 'matches-beam-theory']),
    );
    expect(failing(modelDocument().doc)).not.toContain('analysis-set-up');
  });

  it('a study made stale by a later edit fails study-current', () => {
    const { doc } = studied(law);
    const id = doc.order[0] ?? '';
    const scaled = execute(doc, 'scale_entity', { id, factor: 1.5 }).document;
    expect(failing(scaled)).toContain('study-current');
  });

  it('an oscillating study fails the order and the target and reports no extrapolation (never silently extrapolated)', () => {
    const { doc } = studied([U0, U0 + 0.01, U0 - 0.01]);
    expect(failing(doc)).toEqual(expect.arrayContaining(['order-observed', 'error-within-target', 'matches-beam-theory']));
  });

  it('a study far from beam theory fails matches-beam-theory; one coarser than the owner target fails error-within-target', () => {
    expect(failing(studied(law.map((value) => value * 1.2)).doc)).toContain('matches-beam-theory');
    const coarse = [U0 * 1.02, U0 * 1.1, U0 * 1.42];
    expect(failing(studied(coarse).doc)).toContain('error-within-target');
  });

  it('a study recorded without its artifacts, or with a forged exception, fails', () => {
    expect(failing(studied(law, { verified: false }).doc)).toContain('study-recorded');
    const exception = {
      code: 'VNV_NOT_ASYMPTOTIC',
      justification: 'forged',
      signer: 'agent',
      signatureId: 'x',
      signature: { nonce: 'n' },
      levelHashes: [],
      documentUid: 'u',
    };
    expect(failing(studied(law, { exception }).doc)).toContain('no-forged-exception');
  });

  it('is pure: grading does not change the document', () => {
    const { doc } = studied(law);
    const before = JSON.stringify(doc);
    grade(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
