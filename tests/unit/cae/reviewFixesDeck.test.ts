/** Review fixes 1 and 7: no free text reaches the INP as a keyword line; material / set names cannot collide. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CavityRadiation, FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext } from '@cae/decks/context';
import { commentText } from '@cae/decks/format';
import { writeInp } from '@cae/decks/inpWriter';
import { thermalSections } from '@cae/thermal/deck';
import { cavityLines } from '@cae/thermal/deckLoads';
import { thermomechMaterialCards } from '@cae/thermomech/deck';
import { withCase } from '@cae/shared/access';
import { strainModel } from '../physics/thermomech/thermomechFixtures';
import { X0_NODES, barDocument, barMesh } from './deckFixtures';
import { caseIn } from './helpers';
import { addBc, facesOn, must, thermalFixture, twoTetMesh, TWO_TETS } from './thermal/fixtures';
import { deckContext, thermoFixture } from './thermomech/fixtures';

const INJECTION = '\n*INCLUDE, INPUT=/etc/passwd\n*NODE FILE, NSET=EVIL';

/** Every keyword the writers emit; a data or comment line must never start with `*` otherwise. */
const ALLOWED = new Set([
  'NODE',
  'ELEMENT',
  'ELSET',
  'NSET',
  'MATERIAL',
  'ELASTIC',
  'DENSITY',
  'SOLID SECTION',
  'STEP',
  'STATIC',
  'BOUNDARY',
  'CLOAD',
  'DLOAD',
  'NODE FILE',
  'EL FILE',
  'NODE PRINT',
  'END STEP',
  'CONDUCTIVITY',
  'SPECIFIC HEAT',
  'EXPANSION',
  'INITIAL CONDITIONS',
  'TEMPERATURE',
  'HEAT TRANSFER',
  'DFLUX',
  'CFLUX',
  'FILM',
  'RADIATE',
  'PHYSICAL CONSTANTS',
  'AMPLITUDE',
  'TIME POINTS',
]);

function keywordLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('*') && !line.startsWith('**'))
    .map((line) => (line.slice(1).split(',')[0] ?? '').trim().toUpperCase());
}

/** Lines that are the injected cards themselves (as opposed to the injected text surviving inside a `**` comment). */
const injectedLines = (text: string): string[] => text.split('\n').filter((line) => /^\s*\*(INCLUDE|NODE FILE, NSET=EVIL)/i.test(line));

const foreign = (text: string): string[] => keywordLines(text).filter((keyword) => !ALLOWED.has(keyword));

describe('commentText', () => {
  it('strips line breaks and control characters and caps the length', () => {
    expect(commentText('a\r\nb\u0000c d')).toBe('a b c d');
    expect(commentText('x'.repeat(500), 20)).toHaveLength(20);
    expect(commentText('  plain  ')).toBe('plain');
  });
});

describe('deck injection (review finding 1)', () => {
  it('a load case name with a newline yields no extra keyword line in the static deck', () => {
    const bar = barDocument();
    const added = must(bar.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'tip',
      kind: 'force',
      vector: [0, 0, -1],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const loadId = added.affected[0] ?? '';
    const analysisCase = caseIn(added.document, bar.analysisId);
    const load = analysisCase.loads[loadId]!;
    const doc = withCase(added.document, {
      ...analysisCase,
      loads: { ...analysisCase.loads, [loadId]: { ...load, loadCase: `LC1${INJECTION}` } },
    });
    const sets = {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
      [`L_${loadId}`]: [2, 4, 6, 8],
    };
    const written = writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets));
    if (!('text' in written)) throw new Error(written.message);
    expect(injectedLines(written.text)).toEqual([]);
    expect(written.text).toContain('** load case LC1');
    expect(foreign(written.text)).toEqual([]);
  });

  it('a BC name and a cavity name with newlines yield no extra keyword line in the thermal deck', () => {
    const fixture = thermalFixture({ units: 'mm', size: [2, 1, 1], k: 15 });
    const bc = addBc(fixture, {
      name: `hot${INJECTION}`,
      kind: 'film',
      filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
      sinkTemperature: { value: 20, unit: 'degC' },
      source: { citation: 'test source' },
      target: { entityId: fixture.boxId, facesNear: [[1, 0, 0.5]] },
    });
    const withBc = { ...fixture, doc: bc.doc };
    const cavity: CavityRadiation = {
      id: 'cv-1',
      name: `C1${INJECTION}`,
      environment: { kind: 'closed' },
      faces: [
        { target: { entityId: fixture.boxId }, emissivity: 0.5 },
        { target: { entityId: fixture.boxId }, emissivity: 0.5 },
      ],
    };
    const mesh = twoTetMesh(withBc, {
      faceSets: { [`B_${bc.id}`]: facesOn(TWO_TETS, [1, 2, 3]), 'V_cv-1_0': [[1, 1]], 'V_cv-1_1': [[2, 3]] },
    });
    const ctx = buildDeckContext(withBc.doc, fixture.analysisId, mesh);
    if (ctx === null) throw new Error('no context');
    const sections = thermalSections(ctx);
    if (!('text' in sections)) throw new Error(sections.message);
    const thermal = caseIn(withBc.doc, fixture.analysisId).thermal!;
    const block = cavityLines(ctx, thermal, cavity);
    if ('code' in block) throw new Error(block.message);
    const all = `${sections.text}${block.lines.join('\n')}\n`;
    expect(injectedLines(all)).toEqual([]);
    expect(foreign(all)).toEqual([]);
    expect(block.lines.find((line) => line.startsWith('*RADIATE'))).toMatch(/^\*RADIATE, CAVITY=[A-Z0-9_]+$/);
  });

  it('a material id and a property-model citation with newlines yield no extra keyword line in the thermo-mechanical cards', () => {
    const base = thermoFixture({ model: { ...strainModel(1.2e-5, 'typical'), source: { citation: `cite${INJECTION}` } } });
    const hostileId = `mat${INJECTION}`;
    const material = base.doc.materials['mat']!;
    const doc: CadDocument = {
      ...base.doc,
      materials: { [hostileId]: material },
      entities: { ...base.doc.entities, [base.boxId]: { ...base.doc.entities[base.boxId]!, materialId: hostileId } },
    };
    const cards = thermomechMaterialCards(deckContext({ ...base, doc }), base.boxId);
    if (!('text' in cards)) throw new Error(cards.message);
    expect(cards.text).toContain('*EXPANSION');
    expect(injectedLines(cards.text)).toEqual([]);
    expect(foreign(cards.text)).toEqual([]);
  });
});

describe('name validation (review finding 1)', () => {
  const bar = barDocument();
  const load = {
    analysisId: bar.analysisId,
    name: 'tip',
    kind: 'force',
    vector: [0, 0, -1],
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  };

  it('add_fea_load and update_fea_load refuse load case names that are not identifiers', () => {
    for (const loadCase of [`LC1${INJECTION}`, 'LC 1', 'a-b', 'x'.repeat(41), '']) {
      const result = execute(bar.doc, 'add_fea_load', { ...load, loadCase });
      expect(result.rejected, loadCase).toBe(true);
      expect(result.error?.code).toBe('FEA_LOAD_INVALID');
      expect(result.document).toBe(bar.doc);
    }
    const ok = execute(bar.doc, 'add_fea_load', { ...load, loadCase: 'wing_up_2' });
    expect(ok.rejected).not.toBe(true);
    const bad = execute(ok.document, 'update_fea_load', { analysisId: bar.analysisId, loadId: ok.affected[0], loadCase: 'a\nb' });
    expect(bad.error?.code).toBe('FEA_LOAD_INVALID');
  });

  it('create_analysis refuses a thermomech loadCaseName that is not an identifier', () => {
    const result = execute(bar.doc, 'create_analysis', {
      name: 'T',
      analysisType: 'thermo_static',
      referenceTemperature: { value: 20, unit: 'degC' },
      loadCaseName: `t${INJECTION}`,
    });
    expect(result.error?.code).toBe('FEA_LOAD_INVALID');
  });

  it('add_cavity_radiation refuses cavity names outside [A-Za-z0-9_]{1,3}', () => {
    const fixture = thermalFixture({ units: 'mm', size: [2, 1, 1] });
    const face = { target: { entityId: fixture.boxId, facesNear: [[1, 0, 0.5]] }, emissivity: 0.5 };
    for (const name of ['C\n1', 'a-b', 'ABCD', 'a b']) {
      const result = execute(fixture.doc, 'add_cavity_radiation', { analysisId: fixture.analysisId, name, faces: [face, face] });
      expect(result.error?.code, name).toBe('THM_CAVITY_INVALID');
    }
  });
});

describe('material and set names (review finding 7)', () => {
  function barWithMaterials(first: string, second: string): { text: string } {
    const bar = barDocument();
    let doc: CadDocument = bar.doc;
    const plate = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = plate.document;
    const secondId = plate.affected[0] ?? '';
    const props = { density: 0.00785, color: '#999999', metalness: 1, roughness: 0.4 };
    for (const name of [first, second])
      if (!Object.hasOwn(doc.materials, name)) {
        doc = must(doc, 'create_material', { name, ...props }).document;
        doc = must(doc, 'add_material_model', {
          material: name,
          id: 'elastic',
          model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
          basis: 'unspecified',
          source: { citation: 'test' },
        }).document;
        doc = must(doc, 'define_constitutive_set', {
          material: name,
          set: { id: 'linear', elastic: 'elastic' },
          makeDefault: true,
        }).document;
      }
    for (const [name, id] of [
      [first, bar.boxId],
      [second, secondId],
    ] as const) {
      doc = must(doc, 'assign_material', { materialName: name, entityIds: [id] }).document;
    }
    doc = must(doc, 'set_part_idealization', { analysisId: bar.analysisId, entityId: secondId }).document;
    const mesh: FeMeshArtifact = {
      ...barMesh(doc, bar.analysisId, bar.boxId, {
        [`C_${bar.constraints['x0']}`]: X0_NODES,
        [`C_${bar.constraints['nodeA']}`]: [1],
        [`C_${bar.constraints['nodeB']}`]: [3],
      }),
    };
    const second2 = { ...mesh.blocks[0]!, entityId: secondId, elements: [[7, 1, 2, 3, 4]] };
    const written = writeInp(doc, bar.analysisId, { ...mesh, blocks: [...mesh.blocks, second2] });
    if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
    return written;
  }

  it('materials whose sanitised or upper-cased names coincide get distinct *MATERIAL names', () => {
    for (const [first, second] of [
      ['Al-6061', 'Al 6061'],
      ['steel', 'STEEL'],
    ] as const) {
      const { text } = barWithMaterials(first, second);
      const names = text.split('\n').filter((line) => line.startsWith('*MATERIAL'));
      expect(names, `${first} / ${second}`).toEqual(['*MATERIAL, NAME=M_1', '*MATERIAL, NAME=M_2']);
      expect(text).toContain(`** material M_1 = '${first}'`);
      expect(text).toContain(`** material M_2 = '${second}'`);
      const sections = text.split('\n').filter((line) => line.startsWith('*SOLID SECTION'));
      expect(sections.map((line) => line.split('MATERIAL=')[1])).toEqual(['M_1', 'M_2']);
    }
  });

  it('refuses a deck whose part element sets collide after sanitising', () => {
    const bar = barDocument();
    const mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, {});
    const other = { ...bar.doc.entities[bar.boxId]!, id: 'x.1' };
    const doc: CadDocument = {
      ...bar.doc,
      entities: { ...bar.doc.entities, 'a-b': { ...other, id: 'a-b' }, a_b: { ...other, id: 'a_b' } },
    };
    const analysisCase = caseIn(doc, bar.analysisId);
    const parts = { ...analysisCase.parts, 'a-b': analysisCase.parts[bar.boxId]!, a_b: analysisCase.parts[bar.boxId]! };
    const patched = withCase(doc, { ...analysisCase, parts });
    const block = (entityId: string): FeMeshArtifact['blocks'][number] => ({ ...mesh.blocks[0]!, entityId });
    const result = writeInp(patched, bar.analysisId, { ...mesh, inputHash: '', blocks: [...mesh.blocks, block('a-b'), block('a_b')] });
    expect('code' in result).toBe(true);
  });
});
