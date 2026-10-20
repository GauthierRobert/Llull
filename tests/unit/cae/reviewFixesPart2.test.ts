/** FEA-REST part 2 review fixes: large arrays, preloaded buckling sums, input-hash binding of imported results, settings validation, RBE3 nodes, hostile OP2, VTU export gate. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactStore } from '../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../server/src/fea/caeHooks';
import { runFeaExport } from '../../../server/src/fea/feaExport';
import { runFeaImportResults } from '../../../server/src/fea/feaImportResults';
import { writeBdf } from '@cae/decks/bdfWriter';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { bindingMarker, bindingOf, frdBoundHashes } from '@cae/results/inputBinding';
import { readOp2 } from '@cae/results/op2Reader';
import { op2ToResults } from '@cae/results/op2Results';
import { meshSummary } from '@cae/results/summary';
import { analysisErrors } from '@cae/model/validate';
import { largest } from '@cae/shared/largest';
import { X0_NODES, X2_NODES, barDocument, barMesh, hashOf, mustRun, portOf, solvedBar } from './deckFixtures';
import { caseIn } from './helpers';
import { Op2Builder, displacementRow } from './op2Fixture';

const tables = (bytes: Uint8Array): Extract<ReturnType<typeof readOp2>, { producer: string }> => {
  const read = readOp2(bytes);
  if ('code' in read) throw new Error(read.message);
  return read;
};

describe('largest (no spread)', () => {
  it('handles arrays far above the argument limit of Math.max', () => {
    const values = Array.from({ length: 300_000 }, (_, index) => index);
    expect(largest(values)).toBe(299_999);
    expect(largest(new Set([3, 9, 4]))).toBe(9);
    expect(largest([])).toBe(0);
    expect(largest([-5, -2], -10)).toBe(-2);
  });
});

describe('preloaded buckling deck sums preload and reference at shared targets', () => {
  const model = (): { doc: CadDocument; analysisId: string; boxId: string; sets: Record<string, number[]> } => {
    const base = barDocument({ analysisType: 'buckling' });
    let doc = base.doc;
    const sets: Record<string, number[]> = {
      [`C_${base.constraints['x0']}`]: X0_NODES,
      [`C_${base.constraints['nodeA']}`]: [1],
      [`C_${base.constraints['nodeB']}`]: [3],
    };
    for (const [loadCase, vector] of [
      ['dead', [0, 0, -40]],
      ['LC2', [-1000, 0, -100]],
    ] as const) {
      doc = mustRun(doc, 'add_fea_load', {
        analysisId: base.analysisId,
        name: loadCase,
        kind: 'force',
        loadCase,
        vector,
        distribution: 'per_node',
        target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
      });
      sets[`L_${caseIn(doc, base.analysisId).loadOrder.at(-1)}`] = X2_NODES;
    }
    doc = mustRun(doc, 'set_buckling_preload', { analysisId: base.analysisId, preloadLoadCase: 'dead' });
    return { doc, analysisId: base.analysisId, boxId: base.boxId, sets };
  };

  it('writes the sum where both cases load a node and dof, the reference value elsewhere', () => {
    const { doc, analysisId, boxId, sets } = model();
    const written = writeInp(doc, analysisId, barMesh(doc, analysisId, boxId, sets));
    const text = 'text' in written ? written.text : JSON.stringify(written);
    const preload = text.slice(text.indexOf('** buckling preload'), text.indexOf('** buckling reference'));
    const buckle = text.slice(text.indexOf('*BUCKLE'));
    expect(preload).toContain('2, 3, -40');
    expect(buckle).toContain('2, 3, -140');
    expect(buckle).toContain('2, 1, -1000');
    expect(buckle).not.toContain('2, 3, -100\n');
    expect(buckle).not.toContain('OP=NEW');
  });
});

describe('input-hash binding', () => {
  const bar = barDocument();
  const sets = { [`C_${bar.constraints['x0']}`]: X0_NODES, [`C_${bar.constraints['nodeA']}`]: [1], [`C_${bar.constraints['nodeB']}`]: [3] };
  const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, sets);
  const inputHash = analysisInputHash(bar.doc, bar.analysisId, 'full');
  const marker = bindingMarker(inputHash);

  it('the INP carries the marker in *HEADING and the BDF in SUBTITLE', () => {
    const inp = writeInp(bar.doc, bar.analysisId, mesh);
    expect('text' in inp && inp.text).toContain(`*HEADING\n${marker}\n`);
    const bdf = writeBdf(bar.doc, bar.analysisId, mesh);
    expect('text' in bdf && bdf.text).toContain(`\nSUBTITLE = ${marker}\n`);
    expect(marker).toMatch(/^llull inputHash [0-9a-f]{16}$/);
  });

  it('finds markers in an FRD header only, case-insensitively, and classifies them', () => {
    const header = `    1C\n    1UTITLE             ${marker.toUpperCase()}\n    2C                             1                                     1\n -1 llull inputHash ${'a'.repeat(16)}\n`;
    expect(frdBoundHashes(header)).toEqual([inputHash.slice(0, 16)]);
    expect(frdBoundHashes('    1C\n    1UPGM CalculiX\n')).toEqual([]);
    expect(frdBoundHashes(`${marker}`)).toEqual([inputHash.slice(0, 16)]);
    expect(bindingOf([inputHash.slice(0, 16)], inputHash)).toEqual({ kind: 'bound' });
    expect(bindingOf([], inputHash)).toEqual({ kind: 'unbound' });
    expect(bindingOf(['0'.repeat(16)], inputHash)).toEqual({ kind: 'mismatch', found: '0'.repeat(16) });
  });

  const file = (title?: string): Uint8Array => {
    const builder = new Op2Builder();
    builder.table('OUGV1', [
      {
        approach: 11,
        tableCode: 1,
        subcase: 1,
        numWide: 8,
        data: mesh.nodes.flatMap(([id]) => displacementRow(id, [0, 0, 0, 0, 0, 0])),
        ...(title === undefined ? {} : { title }),
      },
    ]);
    return builder.build();
  };
  const imported = (title?: string): ReturnType<typeof op2ToResults> =>
    op2ToResults(bar.doc, bar.analysisId, mesh, hashOf(mesh), tables(file(title)));

  it('an OP2 with the current marker is bound, one without is imported as unbound with a warning, another set-up is refused', () => {
    expect(tables(file(`SUBTITLE = ${marker.toUpperCase()}`)).inputHashes).toEqual([inputHash.slice(0, 16)]);
    const bound = imported(marker);
    expect('artifact' in bound && bound.artifact).not.toHaveProperty('binding');
    expect('warnings' in bound && bound.warnings.join(' ')).not.toContain('FEA_RESULTS_UNBOUND');
    const unbound = imported();
    expect('artifact' in unbound && unbound.artifact.binding).toBe('imported-unbound');
    expect('warnings' in unbound && unbound.warnings.join(' ')).toContain('FEA_RESULTS_UNBOUND');
    expect(imported(`llull inputHash ${'0'.repeat(16)}`)).toMatchObject({ code: 'FEA_RESULTS_INPUT_MISMATCH' });
  });

  describe('transport and check_analysis', () => {
    let directory = '';
    let store: FeArtifactStore;
    let doc: CadDocument;
    let meshHash = '';
    const host = (): FeaHost => ({
      getDoc: () => doc,
      applyCommand: (name, params): FeaToolResult => {
        const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
        if (result.rejected !== true) doc = result.document;
        return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
      },
    });
    const deps = (): { store: FeArtifactStore; hooks: typeof caeHooks } => ({ store, hooks: caeHooks });
    const frd = (header: string): Uint8Array => {
      const lines = [
        header,
        ' 1PSTEP                         1           1           1',
        ' 100CL  101 0.10000E+01                 4                     1           1',
      ];
      lines.push(
        ' -4  DISP        4    1',
        ' -5  D1          1    2    1    0',
        ' -5  D2          1    2    2    0',
        ' -5  D3          1    2    3    0',
      );
      for (const [id] of mesh.nodes)
        lines.push(` -1${String(id).padStart(10)}${'1.00000E-03'.padStart(12)}${'0.00000E+00'.padStart(12)}${'0.00000E+00'.padStart(12)}`);
      lines.push(' -3');
      return new TextEncoder().encode(`${lines.join('\n')}\n`);
    };

    beforeAll(() => {
      directory = mkdtempSync(path.join(tmpdir(), 'llull-fea-binding-'));
      store = createFeArtifactStore(directory);
      doc = bar.doc;
      meshHash = store.put(mesh);
      const recorded = host().applyCommand('record_fe_mesh', { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) });
      if (recorded.isError) throw new Error(recorded.summary);
    });
    afterAll(() => rmSync(directory, { recursive: true, force: true }));

    it('refuses an FRD and an OP2 marked with another set-up and records nothing', () => {
      const foreign = `    1UTITLE             llull inputHash ${'1'.repeat(16)}`;
      const refusedFrd = runFeaImportResults(bar.analysisId, { format: 'frd', bytes: frd(foreign) }, host(), deps());
      expect(refusedFrd.isError).toBe(true);
      expect(refusedFrd.summary).toContain('FEA_RESULTS_INPUT_MISMATCH');
      const refusedOp2 = runFeaImportResults(
        bar.analysisId,
        { format: 'op2', bytes: file(`llull inputHash ${'1'.repeat(16)}`) },
        host(),
        deps(),
      );
      expect(refusedOp2.summary).toContain('FEA_RESULTS_INPUT_MISMATCH');
      expect(caseIn(doc, bar.analysisId).results).toBeUndefined();
    });

    it('an unmarked FRD is stored as imported-unbound and check_analysis warns; a marked one is bound', () => {
      const marked = runFeaImportResults(
        bar.analysisId,
        { format: 'frd', bytes: frd(`    1UTITLE             ${marker}`) },
        host(),
        deps(),
      );
      expect(marked.isError).toBe(false);
      expect((marked.data as { warnings: string[] }).warnings).toEqual([]);
      const unbound = runFeaImportResults(bar.analysisId, { format: 'frd', bytes: frd('    1C') }, host(), deps());
      expect(unbound.isError).toBe(false);
      expect((unbound.data as { warnings: string[] }).warnings.join(' ')).toContain('FEA_RESULTS_UNBOUND');
      const check = execute(doc, 'check_analysis', { analysisId: bar.analysisId }, { ...defaultContext(), feaArtifacts: store });
      const items = (check.data as { items: { code: string; severity: string }[] }).items;
      expect(items.find((item) => item.code === 'FEA_RESULTS_UNBOUND')?.severity).toBe('warning');
    });
  });

  it('check_analysis stays silent for results without the unbound flag', () => {
    const solved = solvedBar();
    const check = execute(
      solved.doc,
      'check_analysis',
      { analysisId: solved.analysisId },
      { ...defaultContext(), feaArtifacts: solved.port },
    );
    expect(JSON.stringify(check.data)).not.toContain('FEA_RESULTS_UNBOUND');
  });
});
describe('analysis settings validation on load', () => {
  const errorsWith = (patch: Record<string, unknown>, type = 'buckling'): string[] => {
    const base = barDocument({ analysisType: 'buckling' });
    const doc = mustRun(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'dead',
      kind: 'force',
      loadCase: 'dead',
      vector: [0, 0, -1],
      target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const raw = JSON.parse(JSON.stringify(doc)) as { analysis: { cases: Record<string, Record<string, unknown>> } };
    const target = raw.analysis.cases[base.analysisId];
    if (target === undefined) throw new Error('no case');
    Object.assign(target, patch, { type });
    return analysisErrors(raw as unknown as Record<string, unknown>);
  };

  it('accepts well formed settings', () => {
    expect(errorsWith({ preloadLoadCase: 'dead', marginalBand: 0.1, view: { field: 'mode', mode: 2, deformationScale: 0 } })).toEqual([]);
  });

  it('rejects a preload that is not text, names no load case or is on a non-buckling case', () => {
    expect(errorsWith({ preloadLoadCase: 5 }).join()).toContain('preloadLoadCase must be text');
    expect(errorsWith({ preloadLoadCase: 'ghost' }).join()).toContain("preloadLoadCase 'ghost' names no load case");
    expect(errorsWith({ preloadLoadCase: 'dead' }, 'static').join()).toContain('only buckling cases carry a preloadLoadCase');
  });

  it('rejects a negative or non-numeric marginal band', () => {
    expect(errorsWith({ marginalBand: -0.1 }).join()).toContain('marginalBand must be a finite number >= 0');
    expect(errorsWith({ marginalBand: 'wide' }).join()).toContain('marginalBand');
  });

  it('rejects a malformed result view', () => {
    expect(errorsWith({ view: 3 }).join()).toContain('view must be a record');
    expect(errorsWith({ view: { field: 'nope', deformationScale: 1 } }).join()).toContain('view.field');
    expect(errorsWith({ view: { field: 'u_mag', mode: 0, deformationScale: 1 } }).join()).toContain('view.mode');
    expect(errorsWith({ view: { field: 'u_mag', mode: 1.5, deformationScale: 1 } }).join()).toContain('view.mode');
    expect(errorsWith({ view: { field: 'u_mag', deformationScale: -1 } }).join()).toContain('view.deformationScale');
    expect(errorsWith({ view: { field: 'u_mag' } }).join()).toContain('view.deformationScale');
    expect(errorsWith({ view: { field: 'u_mag', deformationScale: 1, loadCase: 4 } }).join()).toContain('view.loadCase');
  });
});

describe('BDF moments need three nodes that can carry them', () => {
  const run = (nodes: readonly number[], vector: readonly number[]): ReturnType<typeof writeBdf> => {
    const base = barDocument();
    const doc = mustRun(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'twist',
      kind: 'moment',
      vector,
      target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const loadId = caseIn(doc, base.analysisId).loadOrder.at(-1) ?? '';
    const mesh = barMesh(doc, base.analysisId, base.boxId, {
      [`C_${base.constraints['x0']}`]: X0_NODES,
      [`C_${base.constraints['nodeA']}`]: [1],
      [`C_${base.constraints['nodeB']}`]: [3],
      [`L_${loadId}`]: nodes,
    });
    return writeBdf(doc, base.analysisId, mesh);
  };

  it('writes the RBE3 of a moment on a face', () => {
    const written = run(X2_NODES, [0, 0, 10]);
    expect('text' in written && written.text).toContain('MOMENT');
  });

  it('refuses two nodes', () => {
    const refused = run([2, 4], [0, 0, 10]);
    expect(refused).toMatchObject({ code: 'FEA_LOAD_INVALID' });
    expect('message' in refused && refused.message).toContain('3 non-collinear');
  });

  it('refuses three collinear nodes for a moment about their line', () => {
    const base = barDocument();
    const mesh: FeMeshArtifact = {
      ...barMesh(base.doc, base.analysisId, base.boxId, {}),
      nodes: [
        [1, 0, 0, 0],
        [2, 1, 0, 0],
        [3, 2, 0, 0],
        [4, 0, 1, 0],
        [5, 0, 0, 1],
        [6, 2, 1, 0],
        [7, 2, 0, 1],
        [8, 2, 1, 1],
      ],
    };
    const doc = mustRun(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'twist',
      kind: 'moment',
      vector: [10, 0, 0],
      target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const loadId = caseIn(doc, base.analysisId).loadOrder.at(-1) ?? '';
    const sets = {
      [`C_${base.constraints['x0']}`]: X0_NODES,
      [`C_${base.constraints['nodeA']}`]: [1],
      [`C_${base.constraints['nodeB']}`]: [3],
      [`L_${loadId}`]: [1, 2, 3],
    };
    const refused = writeBdf(doc, base.analysisId, { ...mesh, nodeSets: sets, inputHash: analysisInputHash(doc, base.analysisId, 'mesh') });
    expect(refused).toMatchObject({ code: 'FEA_LOAD_INVALID' });
    expect('message' in refused && refused.message).toContain('collinear');
  });
});

describe('hostile OP2 files', () => {
  it('refuses a file with more than a million records', () => {
    const records = 1_000_001;
    const bytes = new Uint8Array(records * 12);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < records; index++) {
      view.setInt32(index * 12, 4, true);
      view.setInt32(index * 12 + 4, 1, true);
      view.setInt32(index * 12 + 8, 4, true);
    }
    expect(readOp2(bytes)).toMatchObject({ code: 'FEA_OP2_INVALID' });
    expect((readOp2(bytes) as { message: string }).message).toContain('more than');
  });

  it('does not decode a producer record above 128 bytes', () => {
    const huge = new Op2Builder(true, `NX 12.0${' '.repeat(500)}`).build();
    expect(tables(huge).producer).toBe('');
    expect(tables(new Op2Builder().build()).producer).toBe('NX 12.0');
  });

  it('reads a table with thousands of logical records in one subtable', () => {
    const builder = new Op2Builder();
    const nodes = 20_000;
    builder.table('OUGV1', [
      {
        approach: 11,
        tableCode: 1,
        subcase: 1,
        numWide: 8,
        data: Array.from({ length: nodes }, (_, index) => displacementRow(index + 1, [index, 0, 0, 0, 0, 0])).flat(),
        chunks: nodes,
      },
    ]);
    const read = tables(builder.build());
    expect(read.displacements[0]?.nodes.size).toBe(nodes);
    expect(read.displacements[0]?.nodes.get(nodes)?.[0]).toBe(nodes - 1);
  });
});

describe('fea_export vtu export gate', () => {
  let directory = '';
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('refuses a VTU of a document with ITAR-marked material like the decks, and still writes an EAR99 one', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'llull-fea-vtu-gate-'));
    const store = createFeArtifactStore(directory);
    const bar = barDocument();
    const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, { [`C_${bar.constraints['x0']}`]: X0_NODES });
    const meshHash = store.put(mesh);
    const doc: CadDocument = execute(
      bar.doc,
      'record_fe_mesh',
      { analysisId: bar.analysisId, summary: meshSummary(mesh, meshHash) },
      { ...defaultContext(), feaArtifacts: portOf(mesh) },
    ).document;
    const material = Object.values(doc.materials)[0];
    if (material === undefined) throw new Error('no material');
    const marked = (regime: 'ITAR' | 'EAR99'): CadDocument => ({
      ...doc,
      materials: {
        ...doc.materials,
        [material.name]: {
          ...material,
          record: { id: material.name, designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime } },
        },
      },
    });
    const hostOf = (current: CadDocument): FeaHost => ({
      getDoc: () => current,
      applyCommand: () => ({ summary: '', affected: [], isError: false }),
    });
    const deps = { store, hooks: caeHooks };
    const refused = runFeaExport(bar.analysisId, hostOf(marked('ITAR')), deps, { format: 'vtu' });
    expect(refused.isError).toBe(true);
    expect(refused.summary).toContain('MAT_EXPORT_CONTROLLED');
    expect(refused.data).toMatchObject({ code: 'MAT_EXPORT_CONTROLLED' });
    const allowed = runFeaExport(bar.analysisId, hostOf(marked('EAR99')), deps, { format: 'vtu' });
    expect(allowed.isError).toBe(false);
  });
});
