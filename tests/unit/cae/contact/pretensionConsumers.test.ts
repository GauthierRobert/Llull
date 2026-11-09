/**
 * PHY-06 M3b (b): the readers of a pretensioned case's results that look nodes up by mesh id (VTU export, FE fatigue, margins). The solver writes the cut
 * nodes twice (low-side mesh node + high-side duplicate): each consumer either maps the copy or is shown not to need it.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { copiesOf, pretensionResultMap } from '@cae/contact/pretensionDeck';
import { analysisInputHash } from '@cae/hash/inputHash';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import { fatigueFieldInput } from '@cae/fatigue/feField';
import { caseOf, withCase } from '@cae/shared/access';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { writeVtu } from '@cae/results/vtuWriter';
import { hashOf } from '../deckFixtures';
import { feFatigue } from '../fatigue/feFixtures';
import { must } from './support';
import { bolted, boltedMesh, frdBlock, frdSet, sectionParams, solveBolted } from './boltSupport';

/** Pretensioned bolted case solved with a DISP field: z-displacement 0.001 z at every mesh node, +0.0005 on the copies of the cut (z = 2) in the high side. */
function solvedWithCopies(): ReturnType<typeof solveBolted> & { b: ReturnType<typeof bolted> } {
  const b = bolted();
  const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
  const mesh = boltedMesh(b, added.doc);
  const values: Record<number, number[]> = {};
  for (const [id, , , z] of mesh.nodes) values[id] = [0, 0, 0.001 * z];
  for (const copy of [29, 30, 31, 32]) values[copy] = [0, 0, 0.001 * 2 + 0.0005];
  const frd = frdSet(1, 1, [frdBlock('DISP', ['D1', 'D2', 'D3'], values)]);
  return { ...solveBolted(b, added.doc, frd), b };
}

const arrayOf = (text: string, name: string): number[] =>
  (new RegExp(`Name="${name}"[^>]*>([^<]*)<`).exec(text)?.[1] ?? '').trim().split(/\s+/).map(Number);

describe('VTU export of a pretensioned case', () => {
  it('writes the duplicates as extra points, gives the high-side cells the copies and each point its own displacement', () => {
    const { doc, mesh, results, b } = solvedWithCopies();
    const cut = pretensionResultMap(doc, b.analysisId, mesh);
    expect(cut?.duplicateNodes.map(([id]) => id)).toEqual([29, 30, 31, 32]);
    const written = writeVtu(mesh, results, 'ascii', cut);
    expect(written.dropped).toBe(0);
    expect(written.cells).toBe(30);
    expect(written.text).toContain('NumberOfPoints="32"');
    const connectivity = arrayOf(written.text, 'connectivity');
    // cells of the bolt above the cut (elements 13..24) hold the copies (points 28..31), cells below none
    expect(connectivity.slice(0, 12 * 4).some((point) => point >= 28)).toBe(false);
    expect(connectivity.slice(12 * 4, 24 * 4).some((point) => point >= 28)).toBe(true);
    const displacement = arrayOf(written.text, 'U_1');
    const zAt = (point: number): number => displacement[point * 3 + 2] ?? Number.NaN;
    expect(zAt(8)).toBeCloseTo(0.002, 12);
    expect(zAt(28)).toBeCloseTo(0.0025, 12);
    expect(arrayOf(written.text, 'Points').slice(28 * 3, 28 * 3 + 3)).toEqual([0, 0, 2]);
  });

  it('without the cut (mesh nodes only) the high side is not drawn: 28 points and the low-side value at the cut', () => {
    const { mesh, results } = solvedWithCopies();
    const written = writeVtu(mesh, results, 'ascii');
    expect(written.text).toContain('NumberOfPoints="28"');
    expect(arrayOf(written.text, 'U_1')[8 * 3 + 2]).toBeCloseTo(0.002, 12);
  });

  it('the cut map is absent for a case without bolts', () => {
    const b = bolted();
    expect(pretensionResultMap(b.doc, b.analysisId, boltedMesh(b, b.doc))).toBeNull();
  });
});

describe('copies of the cut', () => {
  it('maps each low-side mesh node to its duplicate, ascending, with the deck numbering', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const plan = pretensionResultMap(added.doc, b.analysisId, boltedMesh(b, added.doc));
    expect([...(plan === null ? [] : copiesOf(plan))]).toEqual([
      [9, [29]],
      [10, [30]],
      [11, [31]],
      [12, [32]],
    ]);
  });
});

describe('compute_margins of a pretensioned case', () => {
  it('refuses the stress margins of a nonlinear_static case, so no margin row can read the low-side copy of a cut node', () => {
    const { doc, ctx, b } = solvedWithCopies();
    const result = execute(
      doc,
      'compute_margins',
      { analysisId: b.analysisId, allowable: { value: 100, unit: 'MPa', source: 'test' } },
      ctx,
    );
    expect(result.error?.code).toBe('FEA_ANALYSIS_TYPE_UNSUPPORTED');
  });
});

describe('FE fatigue of a pretensioned case', () => {
  /** The fatigue fixture with a bolt cut at x = 1 and, on the copies, the node's own stress + 100 in SXX. */
  function pretensioned(): {
    f: ReturnType<typeof feFatigue>;
    doc: ReturnType<typeof feFatigue>['doc'];
    copies: ReadonlyMap<number, readonly number[]>;
    results: FeResultsArtifact;
  } {
    const f = feFatigue();
    const entityId = f.mesh.blocks[0]?.entityId ?? '';
    const analysis = caseOf(f.doc, f.analysisId);
    if (analysis === undefined) throw new Error('no analysis');
    const bolt = {
      id: 'bp-1.1',
      name: 't',
      entityId,
      section: { point: [1, 0.5, 0.5], normal: [1, 0, 0] },
      preload: { kind: 'force', value: 1 },
      preloadStepId: 's',
      lockAfter: true,
    } as const;
    const doc = withCase(f.doc, { ...analysis, pretension: { bolts: { [bolt.id]: bolt }, order: [bolt.id] } });
    const plan = pretensionResultMap(doc, f.analysisId, f.mesh);
    if (plan === null) throw new Error('the cut does not hold on the fatigue grid');
    const copies = copiesOf(plan);
    const steps = f.results.steps.map((step) => {
      const field = step.fields['STRESS'];
      const values: Record<string, readonly number[]> = { ...field?.values };
      for (const [node, list] of copies)
        for (const copy of list) values[String(copy)] = (values[String(node)] ?? []).map((value, c) => (c === 0 ? value + 100 : value));
      return { ...step, fields: { ...step.fields, STRESS: { components: field?.components ?? [], values } } };
    });
    const results: FeResultsArtifact = { ...f.results, inputHash: analysisInputHash(doc, f.analysisId, 'full'), steps };
    return { f, doc, copies, results };
  }

  it('takes the mean of the low and high copies at a cut node and the node itself elsewhere', () => {
    const { f, doc, copies, results } = pretensioned();
    const meshHash = f.store.put(f.mesh);
    const resultsHash = f.store.put(results);
    const recordedMesh = must(doc, 'record_fe_mesh', { analysisId: f.analysisId, summary: meshSummary(f.mesh, meshHash) }, f.ctx);
    const recorded = must(
      recordedMesh.doc,
      'record_fea_results',
      { analysisId: f.analysisId, summary: resultsSummary(recordedMesh.doc, f.analysisId, f.mesh, results, resultsHash) },
      f.ctx,
    );
    const input = fatigueFieldInput(recorded.doc, f.caseId, f.store);
    if (isEvaluationFailure(input)) throw new Error(input.message);
    expect(hashOf(f.mesh)).toBe(meshHash);
    const own = fatigueFieldInput(f.doc, f.caseId, f.store);
    if (isEvaluationFailure(own)) throw new Error(own.message);
    const perNode = input.job.loadCases * 6;
    const at = (field: typeof input, node: number): number => field.tensors[field.nodeIds.indexOf(node) * perNode] ?? Number.NaN;
    const [cutNode = 0] = [...copies.keys()];
    // load case 1 is the first mapped one: the copy is own + 100, the mean own + 50
    expect(at(input, cutNode) - at(own, cutNode)).toBeCloseTo(50, 9);
    const other = input.nodeIds.find((node) => !copies.has(node)) ?? 0;
    expect(at(input, other)).toBe(at(own, other));
  });
});
