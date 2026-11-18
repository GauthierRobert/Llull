/** fea_solve solver option (PERF1): the iterative solver card on linear static decks of solid parts, refusals elsewhere, and a real solve. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { iterativeSolverDeck } from '@cae/decks/solverOption';
import { parseFrd } from '@cae/results/frdReader';
import { barDocument, solvedBar } from './deckFixtures';
import { requireTool } from '../../requireTool';

const CCX = process.env['LLULL_CCX'] ?? 'ccx';
const hasCcx = spawnSync(CCX, ['-v']).error === undefined;

function deckOf(bar: { doc: CadDocument; analysisId: string; mesh: Parameters<typeof writeInp>[2] }): string {
  const written = writeInp(bar.doc, bar.analysisId, bar.mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
}

/** `doc` with the analysis case edited (a set-up no command would refuse to write, built directly for the refusal paths). */
function withCase(doc: CadDocument, analysisId: string, edit: Record<string, unknown>): CadDocument {
  const analysis = doc.analysis;
  if (analysis === undefined) throw new Error('no analysis');
  return {
    ...doc,
    analysis: { ...analysis, cases: { ...analysis.cases, [analysisId]: { ...analysis.cases[analysisId], ...edit } } },
  } as CadDocument;
}

describe('iterativeSolverDeck', () => {
  const bar = solvedBar();
  const deck = deckOf(bar);

  it('changes the *STATIC cards and nothing else', () => {
    const iterative = iterativeSolverDeck(bar.doc, bar.analysisId, deck);
    if (!('text' in iterative)) throw new Error(iterative.message);
    const [before, after] = [deck.split('\n'), iterative.text.split('\n')];
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
    expect(changed.length).toBeGreaterThan(0);
    for (const pair of changed) expect(pair).toEqual(['*STATIC', '*STATIC, SOLVER=ITERATIVE CHOLESKY']);
    expect(before.filter((line) => line === '*STATIC')).toHaveLength(changed.length);
  });

  it('refuses what the iterative solver does not suit, naming the reason', () => {
    const boxId = bar.boxId;
    const refused = (doc: CadDocument, id = bar.analysisId): string => {
      const result = iterativeSolverDeck(doc, id, deck);
      expect(result).toMatchObject({ code: 'FEA_SOLVER_OPTION_UNSUPPORTED' });
      return 'message' in result ? result.message : '';
    };
    expect(refused(bar.doc, 'an-0.0')).toContain("no analysis 'an-0.0'");
    expect(refused(barDocument({ analysisType: 'modal' }).doc, barDocument({ analysisType: 'modal' }).analysisId)).toContain("'modal'");
    expect(refused(withCase(bar.doc, bar.analysisId, { parts: { [boxId]: { kind: 'shell', thickness: 1, offset: 'mid' } } }))).toContain(
      'shell',
    );
    expect(refused(withCase(bar.doc, bar.analysisId, { contact: { formulation: 'penalty', pairs: {}, pairOrder: ['cp-1'] } }))).toContain(
      'contact',
    );
    expect(refused(withCase(bar.doc, bar.analysisId, { pretension: { bolts: {}, order: ['bp-1'] } }))).toContain('pretension');
    expect(iterativeSolverDeck(bar.doc, bar.analysisId, '*HEADING\n*STEP\n*BUCKLE\n')).toMatchObject({
      code: 'FEA_SOLVER_OPTION_UNSUPPORTED',
    });
    expect(
      iterativeSolverDeck(
        withCase(bar.doc, bar.analysisId, { contact: { formulation: 'penalty', pairs: {}, pairOrder: [] } }),
        bar.analysisId,
        deck,
      ),
    ).toHaveProperty('text');
  });

  it.skipIf(requireTool('calculix', hasCcx))('solves the bar with CalculiX to the same stress as the direct solver within 5e-4', () => {
    const iterative = iterativeSolverDeck(bar.doc, bar.analysisId, deck);
    if (!('text' in iterative)) throw new Error(iterative.message);
    const dir = mkdtempSync(join(tmpdir(), 'llull-ccx-iterative-'));
    try {
      writeFileSync(join(dir, 'job.inp'), iterative.text);
      const ran = spawnSync(CCX, ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
      expect(ran.status, ran.stdout).toBe(0);
      const stress = parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8'))[0]?.fields['STRESS']?.values ?? {};
      expect(Object.keys(stress)).toHaveLength(8);
      for (const values of Object.values(stress)) expect(Math.abs((values[0] ?? 0) - 210) / 210).toBeLessThan(5e-4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
