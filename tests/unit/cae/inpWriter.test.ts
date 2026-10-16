import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildInp, type DisciplineTable } from '@cae/decks/deckBuilder';
import { buildDeckContext, loadCasesOf, safeName } from '@cae/decks/context';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf, withCase } from '@cae/shared/access';
import { X0_NODES, barDocument, barMesh, mustRun } from './deckFixtures';

const supportSets = (constraints: Record<string, string>): Record<string, number[]> => ({
  [`C_${constraints['x0']}`]: X0_NODES,
  [`C_${constraints['nodeA']}`]: [1],
  [`C_${constraints['nodeB']}`]: [3],
});

const normalised = (text: string): string => text.replace(/inputHash \w+ meshHash \w+/, 'inputHash H meshHash M');

describe('writeInp golden deck', () => {
  it('writes the model block, material, section and static step of a gravity case', () => {
    const bar = barDocument();
    const doc = mustRun(bar.doc, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, -9810] });
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, supportSets(bar.constraints));
    const written = writeInp(doc, bar.analysisId, mesh);
    expect('text' in written && normalised(written.text)).toBe(`** llull analysis bar units N-mm-t-s inputHash H meshHash M
*NODE, NSET=NALL
1, 0, 0, 0
2, 2, 0, 0
3, 0, 1, 0
4, 2, 1, 0
5, 0, 0, 1
6, 2, 0, 1
7, 0, 1, 1
8, 2, 1, 1
*ELEMENT, TYPE=C3D4, ELSET=P_box_1_1
1, 1, 2, 4, 8
2, 1, 6, 2, 8
3, 1, 4, 3, 8
4, 1, 3, 7, 8
5, 1, 5, 6, 8
6, 1, 7, 5, 8
*ELSET, ELSET=EALL
P_box_1_1
*NSET, NSET=C_fc_10_1
3
*NSET, NSET=C_fc_8_1
1, 3, 5, 7
*NSET, NSET=C_fc_9_1
1
*MATERIAL, NAME=M_steel
*ELASTIC
210000, 0.3
*DENSITY
7.85e-9
*SOLID SECTION, ELSET=P_box_1_1, MATERIAL=M_steel
** load case LC1
*STEP
*STATIC
*BOUNDARY, OP=NEW
C_fc_8_1, 1, 1
C_fc_9_1, 2, 2
C_fc_9_1, 3, 3
C_fc_10_1, 3, 3
*CLOAD, OP=NEW
*DLOAD, OP=NEW
EALL, GRAV, 9810, 0, 0, -1
*NODE FILE
U
*EL FILE
S, E
*END STEP
`);
  });

  it('is byte-identical for identical inputs whatever the key order of the node sets', () => {
    const bar = barDocument();
    const sets = supportSets(bar.constraints);
    const forward = writeInp(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, sets));
    const reversed = writeInp(
      bar.doc,
      bar.analysisId,
      barMesh(bar.doc, bar.analysisId, bar.boxId, Object.fromEntries(Object.entries(sets).reverse())),
    );
    expect(forward).toHaveProperty('text');
    expect(reversed).toEqual(forward);
    // the mesh key order does not change the mesh hash in the header either
    expect(JSON.stringify(writeInp(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, sets)))).toBe(
      JSON.stringify(forward),
    );
  });

  it('does not change the document', () => {
    const bar = barDocument();
    const snapshot = structuredClone(bar.doc);
    writeInp(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, supportSets(bar.constraints)));
    expect(bar.doc).toEqual(snapshot);
  });
});

describe('writeInp refusals', () => {
  const code = (doc: CadDocument, analysisId: string, mesh: ReturnType<typeof barMesh>): string | undefined => {
    const written = writeInp(doc, analysisId, mesh);
    return 'code' in written ? written.code : undefined;
  };

  it('refuses an unknown analysis, an unsupported type and a mesh of other inputs or units', () => {
    const bar = barDocument();
    const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, supportSets(bar.constraints));
    expect(code(bar.doc, 'nope', mesh)).toBe('FEA_ANALYSIS_NOT_FOUND');
    const modal = withCase(bar.doc, { ...caseOf(bar.doc, bar.analysisId)!, type: 'modal' });
    expect(code(modal, bar.analysisId, mesh)).toBe('FEA_ANALYSIS_TYPE_UNSUPPORTED');
    const remeshed = mustRun(bar.doc, 'set_mesh_controls', { analysisId: bar.analysisId, globalSize: 3 });
    expect(code(remeshed, bar.analysisId, mesh)).toBe('FEA_MESH_STALE');
    expect(code(bar.doc, bar.analysisId, { ...mesh, unitSystem: 'N-m-kg-s' })).toBe('FEA_UNITS_MISMATCH');
    expect(code(bar.doc, bar.analysisId, { ...mesh, kind: 'fe_results' } as never)).toBe('FEA_ARTIFACT_NOT_FOUND');
  });

  it('refuses element types that are not tets, foreign parts and parts without elements', () => {
    const bar = barDocument();
    const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, supportSets(bar.constraints));
    const block = mesh.blocks[0]!;
    expect(code(bar.doc, bar.analysisId, { ...mesh, blocks: [{ ...block, type: 'S4' }] })).toBe('FEA_PART_INVALID');
    expect(code(bar.doc, bar.analysisId, { ...mesh, blocks: [block, { ...block, entityId: 'other' }] })).toBe('FEA_PART_INVALID');
    expect(code(bar.doc, bar.analysisId, { ...mesh, blocks: [] })).toBe('FEA_PART_INVALID');
  });

  it('refuses parts without material or elastic constants and models without constraints', () => {
    const none = barDocument({ material: 'none' });
    expect(code(none.doc, none.analysisId, barMesh(none.doc, none.analysisId, none.boxId, supportSets(none.constraints)))).toBe(
      'FEA_MATERIAL_MISSING',
    );
    const bare = mustRun(none.doc, 'create_material', { name: 'bare', density: 0.001, color: '#000000', metalness: 0, roughness: 0.5 });
    const assigned = mustRun(bare, 'assign_material', { materialName: 'bare', entityIds: [none.boxId] });
    const written = writeInp(assigned, none.analysisId, barMesh(assigned, none.analysisId, none.boxId, supportSets(none.constraints)));
    expect(written).toMatchObject({ code: 'FEA_MATERIAL_NO_ELASTIC', ids: [none.boxId] });
    const free = barDocument({ supports: false });
    expect(code(free.doc, free.analysisId, barMesh(free.doc, free.analysisId, free.boxId, {}))).toBe('FEA_NO_CONSTRAINTS');
  });
});

describe('discipline dispatch', () => {
  const table = (log: string[]): DisciplineTable => ({
    heat: {
      materialCards: (_ctx, entityId) => ({ text: `*CONDUCTIVITY\n50\n** heat cards of ${entityId}\n` }),
      sections: () => {
        log.push('heat');
        return { text: '*STEP\n*HEAT TRANSFER, STEADY STATE\n*END STEP' };
      },
    },
    thermomech: {
      materialCards: () => ({ text: '*EXPANSION, ZERO=20\n1.2e-5\n' }),
      sections: () => {
        log.push('thermomech');
        return { text: '*STEP\n*STATIC\n*END STEP\n' };
      },
    },
  });

  it('uses the thermal functions for heat cases and no mechanical cards', () => {
    const base = barDocument({ supports: false });
    const created = execute(base.doc, 'create_analysis', { name: 'h', analysisType: 'heat_steady' });
    const analysisId = created.affected[0] ?? '';
    const doc = mustRun(created.document, 'set_part_idealization', { analysisId, entityId: base.boxId });
    const log: string[] = [];
    const written = buildInp(doc, analysisId, barMesh(doc, analysisId, base.boxId, {}), null, table(log));
    expect(written).toHaveProperty('text');
    const text = 'text' in written ? written.text : '';
    expect(log).toEqual(['heat']);
    expect(text).not.toContain('*ELASTIC');
    expect(text).toContain('*MATERIAL, NAME=M_steel\n*CONDUCTIVITY\n50\n** heat cards of box-1.1\n*SOLID SECTION');
    expect(text.endsWith('*END STEP\n')).toBe(true);
  });

  it('appends the thermo-mechanical cards inside each mechanical material for thermo_static', () => {
    const base = barDocument({ analysisType: 'thermo_static' });
    const log: string[] = [];
    const mesh = barMesh(base.doc, base.analysisId, base.boxId, supportSets(base.constraints));
    const written = buildInp(base.doc, base.analysisId, mesh, null, table(log));
    const text = 'text' in written ? written.text : '';
    expect(log).toEqual(['thermomech']);
    expect(text).toContain(
      '*MATERIAL, NAME=M_steel\n*ELASTIC\n210000, 0.3\n*DENSITY\n7.85e-9\n*EXPANSION, ZERO=20\n1.2e-5\n*SOLID SECTION',
    );
  });

  it('passes a discipline refusal through', () => {
    const base = barDocument({ analysisType: 'thermo_static' });
    const mesh = barMesh(base.doc, base.analysisId, base.boxId, supportSets(base.constraints));
    const refusing: DisciplineTable = {
      ...table([]),
      thermomech: { materialCards: () => ({ code: 'TMC_X', message: 'no cte', ids: ['m'] }), sections: () => ({ text: '' }) },
    };
    expect(buildInp(base.doc, base.analysisId, mesh, null, refusing)).toEqual({ code: 'TMC_X', message: 'no cte', ids: ['m'] });
    const refusingSteps: DisciplineTable = {
      ...table([]),
      thermomech: { ...table([]).thermomech, sections: () => ({ code: 'TMC_Y', message: 'no field' }) },
    };
    expect(buildInp(base.doc, base.analysisId, mesh, null, refusingSteps)).toMatchObject({ code: 'TMC_Y' });
  });
});

describe('deck context', () => {
  it('names sets safely, resolves materials and carries the artifact port', () => {
    const bar = barDocument();
    const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, supportSets(bar.constraints), { 'L_x-1.2': [[1, 2]] });
    const port = { get: () => null };
    const ctx = buildDeckContext(bar.doc, bar.analysisId, mesh, port);
    expect(ctx?.artifacts).toBe(port);
    expect(buildDeckContext(bar.doc, bar.analysisId, mesh)?.artifacts).toBeNull();
    expect(ctx?.nset('C_fc-8.1')).toBe('C_fc_8_1');
    expect(ctx?.elset(bar.boxId)).toBe('P_box_1_1');
    expect(ctx?.materialName(bar.boxId)).toBe('M_steel');
    expect(ctx?.materialOf(bar.boxId)?.name).toBe('steel');
    expect(ctx?.materialOf('nope')).toBeNull();
    expect(ctx?.materialName('nope')).toBe('M_NONE');
    expect(ctx?.faces('L_x-1.2')).toEqual([[1, 2]]);
    expect(ctx?.faces('missing')).toEqual([]);
    expect(ctx?.lengthToAnalysis).toBe(1);
    expect(buildDeckContext(bar.doc, 'nope', mesh)).toBeNull();
    expect(safeName('a b/c')).toBe('a_b_c');
  });

  it('orders load cases by first appearance and defaults to LC1', () => {
    const bar = barDocument();
    expect(loadCasesOf(caseOf(bar.doc, bar.analysisId)!)).toEqual([{ name: 'LC1', category: 'limit' }]);
    let doc = bar.doc;
    for (const [loadCase, category] of [
      ['B', 'limit'],
      ['A', 'limit'],
      ['B', 'ultimate'],
    ] as const)
      doc = mustRun(doc, 'add_fea_load', {
        analysisId: bar.analysisId,
        name: 'g',
        kind: 'gravity',
        vector: [0, 0, -1],
        loadCase,
        category,
      });
    expect(loadCasesOf(caseOf(doc, bar.analysisId)!)).toEqual([
      { name: 'B', category: 'ultimate' },
      { name: 'A', category: 'limit' },
    ]);
    const thermo = barDocument({ analysisType: 'thermo_static' });
    expect(loadCasesOf(caseOf(thermo.doc, thermo.analysisId)!)).toEqual([{ name: 'thermal', category: 'limit' }]);
  });
});
