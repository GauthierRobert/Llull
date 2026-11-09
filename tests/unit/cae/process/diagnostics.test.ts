/** PHY-16 findings that need the mesh / results: empty layers, probes on built nodes, large deflection, degenerate release support. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf } from '@cae/shared/access';
import { amBar, amFrd, amMesh, must, solveBar, type AmBar } from './support';

const frd =
  (uz: number) =>
  (mesh: Parameters<typeof amFrd>[0]): string =>
    amFrd(mesh, [
      { step: 7, time: 7, szz: 100, uz },
      { step: 8, time: 8, szz: 40, uz },
    ]);

const probe = (bar: AmBar, point: number[]): CadDocument =>
  must(bar.doc, 'add_result_probe', { analysisId: bar.analysisId, name: 'p', point, quantity: 'u_z' }).doc;

function findings(bar: AmBar, doc: CadDocument, uz = 0.001): { check: string[]; summary: string[] } {
  const solved = solveBar({ ...bar, doc }, frd(uz), doc);
  const result = execute(solved.doc, 'check_analysis', { analysisId: bar.analysisId }, solved.ctx);
  const items = ((result.data as { items?: { code: string }[] } | undefined)?.items ?? []).map((entry) => entry.code);
  const recorded = caseOf(solved.doc, bar.analysisId)?.results?.am?.findings.map((entry) => entry.code) ?? [];
  return { check: items.filter((code) => code.startsWith('PRC_')), summary: recorded };
}

describe('am findings with a mesh', () => {
  it('PRC_PROBE_ON_BUILT_NODE: a probe on the top face warns, one on the plate-part interface does not', () => {
    const bar = amBar({ release: true });
    const top = findings(bar, probe(bar, [2, 0.5, 1.5]));
    expect(top.check).toContain('PRC_PROBE_ON_BUILT_NODE');
    expect(top.summary).toContain('PRC_PROBE_ON_BUILT_NODE');
    const interfacePoint = findings(bar, probe(bar, [2, 0.5, 0]));
    expect(interfacePoint.check).not.toContain('PRC_PROBE_ON_BUILT_NODE');
    expect(interfacePoint.summary).toEqual([]);
  });

  it('PRC_LAYER_MESH_MISMATCH: a layer height finer than the mesh leaves empty layers (error); the 0.5 mm set-up has none', () => {
    const bar = amBar({ release: true });
    const fine = must(bar.doc, 'am_build_setup', {
      analysisId: bar.analysisId,
      buildDirection: [0, 0, 1],
      plateEntityId: bar.plate,
      layerHeight: 0.1,
    }).doc;
    expect(findings(bar, fine).check).toContain('PRC_LAYER_MESH_MISMATCH');
    expect(findings(bar, fine).summary).toContain('PRC_LAYER_MESH_MISMATCH');
    expect(findings(bar, bar.doc).check).not.toContain('PRC_LAYER_MESH_MISMATCH');
  });

  it('PRC_LARGE_DEFLECTION: a phase moving 5 % of the part warns; 0.025 % does not', () => {
    const bar = amBar({ release: true });
    expect(findings(bar, bar.doc, 0.2).check).toContain('PRC_LARGE_DEFLECTION');
    expect(findings(bar, bar.doc, 0.2).summary).toContain('PRC_LARGE_DEFLECTION');
    expect(findings(bar, bar.doc, 0.001).check).not.toContain('PRC_LARGE_DEFLECTION');
  });

  it('reports nothing for a case without a set-up', () => {
    const bar = amBar({ setup: false });
    const solved = solveBar(bar, frd(0.001));
    expect(caseOf(solved.doc, bar.analysisId)?.results?.am?.findings ?? []).toEqual([]);
  });
});

describe('release support', () => {
  it('refuses snapped 3-2-1 nodes that are nearly collinear (sine below 1e-3) though not exactly', () => {
    const bar = amBar({ release: true });
    const mesh = amMesh(bar);
    // node at (4, 0, 0) moves 1e-4 in y: the triangle (0,0,0) (2,0,0) (4,1e-4,0) has sine 2.5e-5
    const bent = { ...mesh, nodes: mesh.nodes.map((node) => (node[0] === 25 ? ([25, 4, 1e-4, 0] as const) : node)) };
    const analysis = caseOf(bar.doc, bar.analysisId);
    if (analysis?.am === undefined) throw new Error('no am');
    const doc = {
      ...bar.doc,
      analysis: {
        ...bar.doc.analysis,
        cases: {
          ...bar.doc.analysis?.cases,
          [bar.analysisId]: {
            ...analysis,
            am: {
              ...analysis.am,
              releaseSteps: [
                {
                  name: 'cut',
                  remove: ['plate' as const],
                  support321: [
                    [0, 0, 0],
                    [2, 0, 0],
                    [4, 0.0001, 0],
                  ] as [[number, number, number], [number, number, number], [number, number, number]],
                },
              ],
            },
          },
        },
        caseOrder: bar.doc.analysis?.caseOrder ?? [],
      },
    } as CadDocument;
    const written = writeInp(doc, bar.analysisId, { ...bent, inputHash: amMesh(bar, doc).inputHash });
    expect('code' in written && written.code).toBe('PRC_RELEASE_UNSUPPORTED');
    expect('message' in written && written.message).toContain('nearly collinear');
  });

  it('build steps never cut back: the minimum increment equals the increment', () => {
    const bar = amBar();
    const written = writeInp(bar.doc, bar.analysisId, amMesh(bar));
    if (!('text' in written)) throw new Error('refused');
    const lines = written.text.split('\n');
    const strain = lines.findIndex((line) => line.startsWith('** step 3'));
    expect(lines[strain + 3]).toBe('1, 1, 1, 1');
  });
});
