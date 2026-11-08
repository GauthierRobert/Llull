import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { analysisErrors } from '@cae/model/validate';
import { caseOf, withCase } from '@cae/shared/access';
import { hashOf, portOf } from '../deckFixtures';
import { FACTORS, SOURCE_TEXT, imperfectBar, type ImperfectBar } from './imperfectionFixtures';

const add = (
  bar: ImperfectBar,
  modes: unknown,
  extra: Record<string, unknown> = {},
  doc: CadDocument = bar.doc,
): ReturnType<typeof execute> =>
  execute(doc, 'add_imperfection', {
    analysisId: bar.analysisId,
    fromAnalysisId: bar.bucklingId,
    modes,
    amplitudeSource: SOURCE_TEXT,
    ...extra,
  });

/** `*NODE` rows of a deck text: id -> [x, y, z]. */
function nodeRows(text: string): Map<number, number[]> {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('*NODE, NSET='));
  const rows = new Map<number, number[]>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('*')) break;
    const [id, ...xyz] = line.split(',').map(Number);
    if (id !== undefined) rows.set(id, xyz);
  }
  return rows;
}

const deckOf = (
  bar: ImperfectBar,
  doc: CadDocument,
  mesh: FeMeshArtifact = bar.mesh,
  port = bar.ctx.feaArtifacts ?? null,
): ReturnType<typeof writeInp> => writeInp(doc, bar.analysisId, mesh, port);

describe('add_imperfection', () => {
  it('pins the buckling results, stores the modes with their factors, and is pure', () => {
    const bar = imperfectBar();
    const before = JSON.stringify(bar.doc);
    const result = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    expect(JSON.stringify(bar.doc)).toBe(before);
    expect(result.error).toBeUndefined();
    const id = result.affected[0] ?? '';
    expect(id).toMatch(/^imp-/);
    const nonlinear = caseOf(result.document, bar.analysisId)?.nonlinear;
    expect(nonlinear?.imperfectionOrder).toEqual([id]);
    expect(nonlinear?.imperfections?.[id]).toEqual({
      id,
      fromAnalysisId: bar.bucklingId,
      sourceResultsHash: bar.bucklingResultsHash,
      modes: [{ mode: 1, amplitude: 0.5, factor: FACTORS[0] }],
      amplitudeSource: SOURCE_TEXT,
    });
    expect(result.summary).toContain(`'${id}' on '${bar.analysisId}': mode 1 (buckling factor 4.5) x 0.5 mm`);
    expect(result.summary).toContain(bar.bucklingResultsHash.slice(0, 12));
    // the solve inputs change (results go stale), the mesh inputs do not (the same mesh is reused)
    expect(analysisInputHash(result.document, bar.analysisId, 'full')).not.toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
    expect(analysisInputHash(result.document, bar.analysisId, 'mesh')).toBe(analysisInputHash(bar.doc, bar.analysisId, 'mesh'));
    expect(analysisErrors(JSON.parse(JSON.stringify(result.document)) as Record<string, unknown>)).toEqual([]);
  });

  it('refuses without an amplitude or an amplitude source (VC-NLS-62, no default) and leaves the document unchanged', () => {
    const bar = imperfectBar();
    for (const [modes, extra, path] of [
      [[{ mode: 1 }], {}, 'modes[0].amplitude'],
      [
        [
          { mode: 1, amplitude: 0.5 },
          { mode: 2, amplitude: 0 },
        ],
        {},
        'modes[1].amplitude',
      ],
      [[{ mode: 1, amplitude: 0.5 }], { amplitudeSource: '   ' }, 'amplitudeSource'],
      [[{ mode: 1, amplitude: 0.5 }], { amplitudeSource: undefined }, 'amplitudeSource'],
    ] as const) {
      const refused = add(bar, modes, extra);
      expect(refused.error?.code).toBe('NLS_IMPERFECTION_AMPLITUDE_UNSET');
      expect(refused.error?.paths).toEqual([path]);
      expect(refused.document).toBe(bar.doc);
      expect(refused.affected).toEqual([]);
    }
  });

  it('refuses an invalid source: unknown, not buckling, other parts, not solved, too few modes; and a mode listed twice', () => {
    const bar = imperfectBar();
    const code = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;
    expect(code(add(bar, [{ mode: 1, amplitude: 1 }], { fromAnalysisId: 'an-ghost' }))).toBe('NLS_IMPERFECTION_SOURCE_INVALID');
    expect(code(add(bar, [{ mode: 1, amplitude: 1 }], { fromAnalysisId: bar.analysisId }))).toBe('NLS_IMPERFECTION_SOURCE_INVALID');
    const mode3 = add(bar, [{ mode: 3, amplitude: 1 }]);
    expect(code(mode3)).toBe('NLS_IMPERFECTION_SOURCE_INVALID');
    expect(mode3.summary).toContain('has 2 buckling mode(s); mode 3 does not exist');
    const fresh = execute(bar.doc, 'create_analysis', { name: 'bk2', analysisType: 'buckling' });
    const unsolved = execute(fresh.document, 'set_part_idealization', { analysisId: fresh.affected[0], entityId: bar.boxId });
    const notSolved = add(bar, [{ mode: 1, amplitude: 1 }], { fromAnalysisId: fresh.affected[0] }, unsolved.document);
    expect(code(notSolved)).toBe('NLS_IMPERFECTION_SOURCE_INVALID');
    expect(notSolved.summary).toContain('unmeshed, not solved');
    expect(code(add(bar, [{ mode: 1, amplitude: 1 }], { fromAnalysisId: fresh.affected[0] }, fresh.document))).toBe(
      'NLS_IMPERFECTION_SOURCE_INVALID',
    );
    expect(
      code(
        add(bar, [
          { mode: 1, amplitude: 1 },
          { mode: 1, amplitude: 2 },
        ]),
      ),
    ).toBe('NLS_CONTROL_INVALID');
    const onLinear = execute(bar.doc, 'add_imperfection', {
      analysisId: bar.bucklingId,
      fromAnalysisId: bar.bucklingId,
      modes: [{ mode: 1, amplitude: 1 }],
      amplitudeSource: SOURCE_TEXT,
    });
    expect(code(onLinear)).toBe('NLS_CASE_NOT_NONLINEAR');
  });

  it('refuses a source that turned stale after its solve', () => {
    const bar = imperfectBar();
    const moved = execute(bar.doc, 'set_mesh_controls', { analysisId: bar.bucklingId, globalSize: 0.25 });
    expect(moved.error).toBeUndefined();
    const refused = add(bar, [{ mode: 1, amplitude: 1 }], {}, moved.document);
    expect(refused.error?.code).toBe('NLS_IMPERFECTION_SOURCE_INVALID');
    expect(refused.summary).toContain('is stale, not solved');
  });
});

describe('imperfect deck nodes (TR-NLS-30)', () => {
  it('moves each node by amplitude x phi / max|phi|, summed over modes, and names the imperfection in a comment', () => {
    const bar = imperfectBar();
    const plain = deckOf(bar, bar.doc);
    const added = add(bar, [
      { mode: 1, amplitude: 0.5 },
      { mode: 2, amplitude: 0.2 },
    ]);
    const deck = deckOf(bar, added.document);
    expect('text' in plain && 'text' in deck).toBe(true);
    if (!('text' in plain) || !('text' in deck)) return;
    const base = nodeRows(plain.text);
    const moved = nodeRows(deck.text);
    // node 2 at (2, 0, 0): mode 1 uy = x -> 0.5 * 2/2; mode 2 uz = -x y = 0 there
    expect(moved.get(2)).toEqual([2, 0.5, 0]);
    // node 4 at (2, 1, 0): uy 0.5, uz 0.2 * (-2)/2
    expect(moved.get(4)).toEqual([2, 1.5, -0.2]);
    // node 1 at the origin does not move
    expect(moved.get(1)).toEqual(base.get(1));
    expect(deck.text).toContain(
      `** imperfection ${added.affected[0]}: mode 1 x 0.5 + mode 2 x 0.2 (document length units) from ${bar.bucklingId}`,
    );
    expect(plain.text).not.toContain('** imperfection');
    // byte-deterministic
    expect(deckOf(bar, added.document)).toEqual(deck);
  });

  it('converts the amplitude from document units (m document, mm analysis)', () => {
    const bar = imperfectBar();
    const added = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    const analysis = caseOf(added.document, bar.analysisId);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const metres: CadDocument = { ...added.document, units: 'm' };
    // the mesh inputs depend on the document unit: rebuild the mesh artifact for the m document
    const mesh: FeMeshArtifact = { ...bar.mesh, inputHash: analysisInputHash(metres, bar.analysisId, 'mesh') };
    const deck = writeInp(metres, bar.analysisId, mesh, portOf(mesh, bar.bucklingMesh, bar.bucklingResults));
    expect('text' in deck).toBe(true);
    if ('text' in deck) expect(nodeRows(deck.text).get(2)).toEqual([2, 500, 0]);
  });

  it('refuses when the pinned artifacts are missing or the mesh is not the buckling mesh', () => {
    const bar = imperfectBar();
    const added = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    const noArtifacts = deckOf(bar, added.document, bar.mesh, portOf(bar.mesh));
    expect(noArtifacts).toMatchObject({ code: 'NLS_IMPERFECTION_SOURCE_INVALID' });
    expect('message' in noArtifacts ? noArtifacts.message : '').toContain('pinned buckling results are not readable');
    const noMesh = deckOf(bar, added.document, bar.mesh, portOf(bar.mesh, bar.bucklingResults));
    expect('message' in noMesh ? noMesh.message : '').toContain('mesh of the pinned buckling results is not readable');
    const shifted: FeMeshArtifact = { ...bar.mesh, nodes: bar.mesh.nodes.map(([id, x, y, z]) => [id, id === 8 ? x + 1e-3 : x, y, z]) };
    const other = deckOf(bar, added.document, shifted, portOf(shifted, bar.bucklingMesh, bar.bucklingResults));
    expect(other).toMatchObject({ code: 'NLS_IMPERFECTION_SOURCE_INVALID' });
    expect('message' in other ? other.message : '').toContain('1 node(s) differ');
  });

  it('refuses a mode the pinned results do not hold, or a shape without a value at some node or with no motion at all', () => {
    const bar = imperfectBar();
    const added = add(bar, [{ mode: 2, amplitude: 0.5 }]);
    const id = added.affected[0] ?? '';
    const pinTo = (results: FeResultsArtifact): string | undefined => {
      const analysis = caseOf(added.document, bar.analysisId);
      const imperfection = analysis?.nonlinear?.imperfections?.[id];
      if (analysis?.nonlinear === undefined || imperfection === undefined) return 'fixture';
      const repinned = withCase(added.document, {
        ...analysis,
        nonlinear: { ...analysis.nonlinear, imperfections: { [id]: { ...imperfection, sourceResultsHash: hashOf(results) } } },
      });
      const deck = writeInp(repinned, bar.analysisId, bar.mesh, portOf(bar.mesh, bar.bucklingMesh, results));
      return 'message' in deck ? `${deck.code}: ${deck.message}` : undefined;
    };
    const steps = bar.bucklingResults.steps;
    expect(pinTo({ ...bar.bucklingResults, steps: steps.slice(0, 1) })).toContain('hold 1 mode shape(s), not mode 2');
    const withoutNode8 = steps.map((set) => {
      const disp = set.fields['DISP'];
      if (disp === undefined) return set;
      const values = Object.fromEntries(Object.entries(disp.values).filter(([node]) => node !== '8'));
      return { ...set, fields: { DISP: { ...disp, values } } };
    });
    expect(pinTo({ ...bar.bucklingResults, steps: withoutNode8 })).toContain('mode 2 has no finite displacement at node 8');
    const still = steps.map((set) => {
      const disp = set.fields['DISP'];
      if (disp === undefined) return set;
      return {
        ...set,
        fields: { DISP: { ...disp, values: Object.fromEntries(Object.keys(disp.values).map((node) => [node, [0, 0, 0]])) } },
      };
    });
    expect(pinTo({ ...bar.bucklingResults, steps: still })).toBe(
      `NLS_IMPERFECTION_SOURCE_INVALID: imperfection '${id}': mode 2 is zero everywhere`,
    );
    expect(pinTo(bar.bucklingResults)).toBeUndefined();
  });
});

describe('imperfection sign and peak report (review round 1)', () => {
  it('names the peak node and the signed offset of each mode in the summary (with the artifact store) and in the deck', () => {
    const bar = imperfectBar();
    const params = {
      analysisId: bar.analysisId,
      fromAnalysisId: bar.bucklingId,
      modes: [{ mode: 1, amplitude: -0.5 }],
      amplitudeSource: SOURCE_TEXT,
    };
    const withStore = execute(bar.doc, 'add_imperfection', params, bar.ctx);
    // mode 1 is uy = x: largest at node 2 (2, 0, 0); a negative amplitude moves it to -y
    expect(withStore.summary).toContain('Largest offsets: mode 1 peak node 2 offset [0, -0.5, 0] (mm, sign of the mode as solved)');
    expect(execute(bar.doc, 'add_imperfection', params).summary).not.toContain('Largest offsets');
    const deck = deckOf(bar, withStore.document);
    expect('text' in deck ? deck.text : '').toContain(`** imperfection ${withStore.affected[0]} mode 1 peak node 2 offset [0, -0.5, 0]`);
  });
});

describe('mode order with a negative buckling factor (review round 1)', () => {
  // ccx can report a load-reversal mode first: factors [-3.2, 4.5, 9.1]; mode 2 must be the 4.5 shape (uz = -x y), not the 9.1 one (ux = y)
  const reversed = (): ImperfectBar => imperfectBar(true, [-3.2, 4.5, 9.1]);

  it('refuses a mode whose factor is not positive', () => {
    const bar = reversed();
    const refused = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    expect(refused.error?.code).toBe('NLS_IMPERFECTION_SOURCE_INVALID');
    expect(refused.summary).toContain('buckling factor <= 0 (-3.2)');
  });

  it('applies the shape of the set whose factor is the pinned one', () => {
    const bar = reversed();
    const added = add(bar, [{ mode: 2, amplitude: 0.2 }]);
    expect(caseOf(added.document, bar.analysisId)?.nonlinear?.imperfections?.[added.affected[0] ?? '']?.modes).toEqual([
      { mode: 2, amplitude: 0.2, factor: 4.5 },
    ]);
    const deck = deckOf(bar, added.document);
    expect('text' in deck).toBe(true);
    // node 4 at (2, 1, 0): uz = -x y = -2 at the peak, scaled by 0.2 / 2; the 9.1 shape would have moved x instead
    if ('text' in deck) expect(nodeRows(deck.text).get(4)).toEqual([2, 1, -0.2]);
  });

  it('accepts the .frd factor that the 7-digit .dat table rounded (ccx 2.21: 4623.062281 vs 4623.062)', () => {
    const bar = reversed();
    const added = add(bar, [{ mode: 2, amplitude: 0.2 }]);
    const id = added.affected[0] ?? '';
    const precise: FeResultsArtifact = {
      ...bar.bucklingResults,
      steps: bar.bucklingResults.steps.map((set) => ({ ...set, time: set.time * (1 + 4e-7) })),
    };
    const analysis = caseOf(added.document, bar.analysisId);
    const imperfection = analysis?.nonlinear?.imperfections?.[id];
    if (analysis?.nonlinear === undefined || imperfection === undefined) throw new Error('fixture');
    const repinned = withCase(added.document, {
      ...analysis,
      nonlinear: { ...analysis.nonlinear, imperfections: { [id]: { ...imperfection, sourceResultsHash: hashOf(precise) } } },
    });
    expect('text' in writeInp(repinned, bar.analysisId, bar.mesh, portOf(bar.mesh, bar.bucklingMesh, precise))).toBe(true);
  });

  it('refuses when the set at that mode position carries another factor than the pinned one', () => {
    const bar = reversed();
    const added = add(bar, [{ mode: 2, amplitude: 0.2 }]);
    const id = added.affected[0] ?? '';
    const [first, ...rest] = bar.bucklingResults.steps;
    const shuffled: FeResultsArtifact = { ...bar.bucklingResults, steps: first === undefined ? rest : [...rest, first] };
    const analysis = caseOf(added.document, bar.analysisId);
    const imperfection = analysis?.nonlinear?.imperfections?.[id];
    if (analysis?.nonlinear === undefined || imperfection === undefined) throw new Error('fixture');
    const repinned = withCase(added.document, {
      ...analysis,
      nonlinear: { ...analysis.nonlinear, imperfections: { [id]: { ...imperfection, sourceResultsHash: hashOf(shuffled) } } },
    });
    const deck = writeInp(repinned, bar.analysisId, bar.mesh, portOf(bar.mesh, bar.bucklingMesh, shuffled));
    expect(deck).toMatchObject({ code: 'NLS_IMPERFECTION_SOURCE_INVALID' });
    expect('message' in deck ? deck.message : '').toContain('the mode order does not match');
  });
});

describe('delete_imperfection', () => {
  it('removes the imperfection and restores the input hash of a case without one; is pure', () => {
    const bar = imperfectBar();
    const added = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    const id = added.affected[0] ?? '';
    const before = JSON.stringify(added.document);
    const removed = execute(added.document, 'delete_imperfection', { analysisId: bar.analysisId, imperfectionId: id });
    expect(JSON.stringify(added.document)).toBe(before);
    expect(removed.affected).toEqual([id]);
    expect(caseOf(removed.document, bar.analysisId)?.nonlinear?.imperfections).toBeUndefined();
    expect(analysisInputHash(removed.document, bar.analysisId, 'full')).toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
    const two = add(bar, [{ mode: 2, amplitude: 0.1 }], {}, added.document);
    const left = execute(two.document, 'delete_imperfection', { analysisId: bar.analysisId, imperfectionId: id });
    expect(caseOf(left.document, bar.analysisId)?.nonlinear?.imperfectionOrder).toEqual([two.affected[0]]);
    expect(left.summary).toContain('1 imperfection(s) left');
  });

  it('refuses an unknown imperfection id with the list of ids', () => {
    const bar = imperfectBar();
    const refused = execute(bar.doc, 'delete_imperfection', { analysisId: bar.analysisId, imperfectionId: 'imp-9.9' });
    expect(refused.error?.code).toBe('NLS_IMPERFECTION_NOT_FOUND');
    expect(refused.document).toBe(bar.doc);
    expect(refused.summary).toContain('imperfections: none');
  });
});

describe('imperfection guardrail and load validation', () => {
  const codes = (doc: CadDocument, analysisId: string): string[] =>
    (
      (execute(doc, 'check_analysis', { analysisId }, defaultContext()).data as { items: { code: string; severity: string }[] }).items ?? []
    ).map((entry) => `${entry.code}:${entry.severity}`);

  it('warns NLS_IMPERFECTION_MISSING on an NLGEOM case next to a solved buckling case, not after add_imperfection or with nlgeom off', () => {
    const bar = imperfectBar(true);
    expect(codes(bar.doc, bar.analysisId)).toContain('NLS_IMPERFECTION_MISSING:warning');
    const added = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    expect(codes(added.document, bar.analysisId)).not.toContain('NLS_IMPERFECTION_MISSING:warning');
    const small = imperfectBar(false);
    expect(codes(small.doc, small.analysisId)).not.toContain('NLS_IMPERFECTION_MISSING:warning');
  });

  it('rejects a malformed imperfection bag on load, naming the path', () => {
    const bar = imperfectBar();
    const added = add(bar, [{ mode: 1, amplitude: 0.5 }]);
    const id = added.affected[0] ?? '';
    const mutate = (change: (nonlinear: Record<string, unknown>) => void): string => {
      const document = JSON.parse(JSON.stringify(added.document)) as Record<string, unknown>;
      const cases = (document['analysis'] as { cases: Record<string, { nonlinear: Record<string, unknown> }> }).cases;
      change(cases[bar.analysisId]!.nonlinear);
      return analysisErrors(document).join(' | ');
    };
    const entry = (nonlinear: Record<string, unknown>): Record<string, unknown> =>
      (nonlinear['imperfections'] as Record<string, Record<string, unknown>>)[id]!;
    expect(mutate((n) => delete n['imperfectionOrder'])).toContain('expected a record and an id list');
    expect(mutate((n) => (n['imperfectionOrder'] = [id, id]))).toContain('duplicate ids');
    expect(mutate((n) => (n['imperfectionOrder'] = []))).toContain('missing from imperfectionOrder');
    expect(mutate((n) => (n['imperfectionOrder'] = [id, 'imp-x']))).toContain("'imp-x' is listed but missing");
    expect(mutate((n) => (entry(n)['id'] = 'other'))).toContain('its id must equal its key');
    expect(mutate((n) => (entry(n)['sourceResultsHash'] = 'abc'))).toContain('sha256 hex digest');
    expect(mutate((n) => (entry(n)['amplitudeSource'] = ''))).toContain('amplitudeSource must be non-empty');
    expect(mutate((n) => (entry(n)['fromAnalysisId'] = 3))).toContain('fromAnalysisId must be text');
    expect(mutate((n) => (entry(n)['modes'] = []))).toContain('modes must be a list of 1 to 20');
    expect(mutate((n) => (entry(n)['modes'] = [{ mode: 1, amplitude: Number.POSITIVE_INFINITY, factor: 1 }]))).toContain(
      'finite non-zero length',
    );
    expect(mutate((n) => (entry(n)['modes'] = [{ mode: 0.5, amplitude: 1, factor: 1 }]))).toContain('integer 1..1000');
    expect(mutate((n) => (entry(n)['modes'] = [{ mode: 1, amplitude: 1, factor: 'x' }]))).toContain('factor must be finite');
    expect(
      mutate(
        (n) =>
          (entry(n)['modes'] = [
            { mode: 1, amplitude: 1, factor: 1 },
            { mode: 1, amplitude: 2, factor: 1 },
          ]),
      ),
    ).toContain('listed twice');
    expect(mutate((n) => (entry(n)['modes'] = [3]))).toContain('expected { mode, amplitude, factor }');
    expect(
      mutate((n) => {
        n['imperfections'] = JSON.parse('{"__proto__": {"id": "__proto__"}}') as unknown;
        n['imperfectionOrder'] = ['__proto__'];
      }),
    ).toContain('reserved id');
  });
});
