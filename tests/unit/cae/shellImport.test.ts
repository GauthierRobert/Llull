/** fea_import_results of a shell .frd: the expanded fibre nodes are mapped back before the mesh check (as fea_solve does). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary } from '@cae/results/summary';
import { createFeArtifactStore } from '../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../server/src/fea/caeHooks';
import { runFeaImportResults } from '../../../server/src/fea/feaImportResults';
import { must, plateDocument } from './shellFixtures';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-shell-import-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const NODES: FeMeshArtifact['nodes'] = [
  [1, 0, 0, 1],
  [2, 100, 0, 1],
  [3, 100, 50, 1],
  [4, 0, 50, 1],
];

const fmt = (value: number): string => {
  const [mantissa = '0', exponent = '0'] = value.toExponential(5).split('e');
  const power = Number(exponent);
  return `${mantissa}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`.padStart(12);
};
const line = (id: number, values: readonly number[]): string => ` -1${String(id).padStart(10)}${values.map(fmt).join('')}`;

/** Expanded .frd (top nodes 100 + n at z = 2, bottom 200 + n at z = 0), optionally with a node block. */
function frd(withNodes: boolean): Uint8Array {
  const block = (name: string, components: readonly string[], top: number[], bottom: number[]): string[] => [
    '    1PSTEP                         1           1           1',
    '  100CL  101 1.000000000           8                     0    1           1',
    ` -4  ${name.padEnd(8)}${String(components.length).padStart(4)}    1`,
    ...components.map((component, index) => ` -5  ${component.padEnd(8)}    1    2    ${index + 1}    0`),
    ...NODES.flatMap(([id]) => [line(100 + id, top), line(200 + id, bottom)]),
    ' -3',
  ];
  const text = [
    ...(withNodes
      ? [
          '    2C                             8                                     1',
          ...NODES.flatMap(([id, x, y]) => [line(100 + id, [x, y, 2]), line(200 + id, [x, y, 0])]),
          ' -3',
        ]
      : []),
    ...block('DISP', ['D1', 'D2', 'D3'], [1, 0, 0], [-1, 0, 0]),
    ...block('STRESS', ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'], [80, 0, 0, 0, 0, 0], [-80, 0, 0, 0, 0, 0]),
  ].join('\n');
  return new TextEncoder().encode(text);
}

describe('fea_import_results of a shell .frd', () => {
  it('maps the fibres back, records them and refuses a file without the expanded nodes', () => {
    const plate = plateDocument();
    let doc: CadDocument = must(plate.doc, 'set_part_idealization', {
      analysisId: plate.analysisId,
      entityId: plate.plateId,
      idealization: 'shell',
    });
    const fixed = execute(doc, 'add_fea_constraint', {
      analysisId: plate.analysisId,
      name: 'f',
      kind: 'fixed',
      target: { entityId: plate.plateId, facesNear: [[0, 25, 1]] },
    });
    doc = fixed.document;
    const store = createFeArtifactStore(directory);
    const host = {
      getDoc: (): CadDocument => doc,
      applyCommand: (name: string, params: unknown): { summary: string; affected: string[]; isError: boolean } => {
        const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
        if (result.rejected !== true) doc = result.document;
        return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
      },
    };
    const mesh: FeMeshArtifact = {
      kind: 'fe_mesh',
      unitSystem: 'N-mm-t-s',
      mesher: 'test',
      mesherVersion: '1',
      inputHash: analysisInputHash(doc, plate.analysisId, 'mesh'),
      nodes: NODES,
      blocks: [{ type: 'S4', entityId: plate.plateId, elements: [[1, 1, 2, 3, 4]] }],
      nodeSets: { [`C_${fixed.affected[0] ?? ''}`]: [1, 4] },
      faceSets: {},
      targets: {},
    };
    host.applyCommand('record_fe_mesh', { analysisId: plate.analysisId, summary: meshSummary(mesh, store.put(mesh)) });
    const imported = runFeaImportResults(plate.analysisId, { format: 'frd', bytes: frd(true) }, host, { store, hooks: caeHooks });
    expect(imported.isError).toBe(false);
    expect(doc.analysis?.cases[plate.analysisId]?.results?.loadCases[0]?.maxVonMises.value).toBeCloseTo(80);
    const lost = runFeaImportResults(plate.analysisId, { format: 'frd', bytes: frd(false) }, host, { store, hooks: caeHooks });
    expect(lost.summary).toContain('FEA_SHELL_RESULTS_UNMAPPED');
  });
});
