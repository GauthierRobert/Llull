/** PHY-06 M3 bolt pretension deck (TR-CNT-03/04): the mesh cut, duplicate nodes, equations, preload / lock steps and the refusals of the writer. */
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf, withCase } from '@cae/shared/access';
import { isCutRefusal, pretensionCut } from '@cae/contact/pretensionSection';
import { must } from './support';
import { bolted, boltedMesh, quadraticMesh, sectionParams, type Bolted } from './boltSupport';

function deckOf(b: Bolted, doc: CadDocument, mesh: FeMeshArtifact = boltedMesh(b, doc)): string {
  const written = writeInp(doc, b.analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
}

const withBolt = (extra: Record<string, unknown> = {}, b = bolted()): { b: Bolted; doc: CadDocument; boltId: string } => {
  const added = must(b.doc, 'add_bolt_pretension', sectionParams(b, extra));
  return { b, doc: added.doc, boltId: added.affected[1] ?? '' };
};

const MESH = (b: Bolted): FeMeshArtifact => boltedMesh(b, b.doc);

describe('pretension cut', () => {
  it('cuts the bolt along z = 2: the two faces on the plane, its four nodes, area 1, normal +z', () => {
    const b = bolted();
    const cut = pretensionCut(MESH(b), b.bolt, [0.5, 0.5, 2], [0, 0, 2]);
    if (isCutRefusal(cut)) throw new Error(cut.message);
    expect(cut.faces).toHaveLength(2);
    expect(cut.nodes).toEqual([9, 10, 11, 12]);
    expect(cut.area).toBeCloseTo(1, 12);
    expect(cut.diameter).toBeCloseTo(2 / Math.sqrt(Math.PI), 12);
    expect(cut.centroid[0]).toBeCloseTo(0.5, 12);
    expect(cut.centroid[2]).toBeCloseTo(2, 12);
    expect(cut.normal).toEqual([0, 0, 1]);
    expect(cut.highElements.size).toBe(12);
  });

  it('cuts along an oblique plane in one piece (a jagged cut is still a complete cut)', () => {
    const b = bolted();
    const cut = pretensionCut(MESH(b), b.bolt, [0.5, 0.5, 2], [3, 0, 1]);
    if (isCutRefusal(cut)) throw new Error(cut.message);
    expect(cut.faces.length).toBeGreaterThan(2);
    expect(cut.nodes.length).toBeGreaterThan(4);
  });

  it('refuses a plane that touches the part from outside, a zero normal, a part without elements and a plane that cuts twice', () => {
    const b = bolted();
    const mesh = MESH(b);
    expect(pretensionCut(mesh, b.bolt, [0.5, 0.5, 0], [0, 0, 1])).toMatchObject({ code: 'CNT_PRETENSION_SECTION_INVALID' });
    expect(pretensionCut(mesh, b.bolt, [0.5, 0.5, 2], [0, 0, 0])).toMatchObject({ message: expect.stringContaining('zero vector') });
    expect(pretensionCut(mesh, 'ghost', [0.5, 0.5, 2], [0, 0, 1])).toMatchObject({ message: expect.stringContaining('no tetrahedral') });
    const first = mesh.blocks[0];
    if (first === undefined) throw new Error('no block');
    const twin: FeMeshArtifact = {
      ...mesh,
      nodes: [...mesh.nodes, ...mesh.nodes.slice(0, 20).map(([id, x, y, z]) => [id + 100, x + 5, y, z] as const)],
      blocks: [
        {
          ...first,
          elements: [...first.elements, ...first.elements.map(([id = 0, ...nodes]) => [id + 100, ...nodes.map((node) => node + 100)])],
        },
        ...mesh.blocks.slice(1),
      ],
    };
    expect(pretensionCut(twin, b.bolt, [0.5, 0.5, 2], [0, 0, 1])).toMatchObject({
      message: expect.stringContaining('2 separate sections'),
    });
  });
});

describe('pretension deck', () => {
  it('duplicates the cut nodes, gives the high side the copies, ties them to the reference node, applies the preload in the first step (golden)', () => {
    const { b, doc, boltId } = withBolt();
    const text = deckOf(b, doc);
    expect(text).toContain('*NODE\n29, 0, 0, 2\n30, 1, 0, 2\n31, 0, 1, 2\n32, 1, 1, 2\n*ELEMENT');
    expect(text.match(/^\*EQUATION$/gm)).toHaveLength(12);
    expect(text).toContain(
      `** bolt pretension ${boltId} m1: 4 cut nodes, section area 1\n*NSET, NSET=PTD_1\n29, 30, 31, 32\n*NODE, NSET=PTN_1\n33, 0.5, 0.5, 2\n*EQUATION\n2\n29, 1, 1, 9, 1, -1\n`,
    );
    expect(text).toContain('*EQUATION\n3\n29, 3, 1, 9, 3, -1, 33, 1, 1\n');
    const rows = text.split('\n').filter((line) => /^\d+, \d+, \d+, \d+, \d+$/.test(line));
    const copies = (line: string): boolean => /\b(29|30|31|32)\b/.test(line.split(', ').slice(1).join(', '));
    expect(rows.filter((line) => Number(line.split(', ')[0]) >= 13 && copies(line)).length).toBeGreaterThan(0);
    expect(rows.filter((line) => Number(line.split(', ')[0]) <= 12 && copies(line))).toHaveLength(0);
    expect(text).toContain('*CLOAD\n33, 1, 10\n*NODE FILE');
    expect(text).toContain('*NODE PRINT, NSET=PTN_1\nU, RF\n*NODE PRINT, NSET=PTD_1, TOTALS=ONLY\nRF\n*END STEP');
    expect(text).not.toContain('*PRE-TENSION');
  });

  it('holds the shortening with *BOUNDARY, FIXED (and zeroes the load) in later steps of a locked bolt; an unlocked bolt keeps the constant force', () => {
    const base = bolted();
    const second = must(base.doc, 'add_analysis_step', {
      analysisId: base.analysisId,
      name: 'service',
      multipliers: {},
      control: { kind: 'load', initialIncrement: 0.5, minIncrement: 0.001, maxIncrement: 0.5, maxIncrements: 20 },
    });
    const b: Bolted = { ...base, doc: second.doc };
    const locked = withBolt({}, b);
    const stepsLocked = deckOf(b, locked.doc).split('*STEP').slice(1);
    expect(stepsLocked[0]).toContain('*CLOAD\n33, 1, 10\n');
    expect(stepsLocked[0]).not.toContain('FIXED');
    expect(stepsLocked[1]).toContain('*CLOAD\n33, 1, 0\n*BOUNDARY, FIXED\n33, 1, 1\n');
    const free = withBolt({ lockAfter: false }, b);
    const stepsFree = deckOf(b, free.doc).split('*STEP').slice(1);
    expect(stepsFree[1]).not.toContain('FIXED');
    expect(stepsFree[1]).not.toContain('33, 1,');
  });

  it('derives the torque force, numbers the duplicates and reference nodes of several bolts above the mesh nodes in bolt order', () => {
    const { b, doc } = withBolt({ preload: { kind: 'torque', torque: 50, diameter: 0.5, nutFactor: 0.2, nutFactorSource: 's' } });
    const two = must(doc, 'add_bolt_pretension', sectionParams(b, { name: 'm2', section: { point: [0.5, 0.5, 3], normal: [0, 0, 1] } }));
    const text = deckOf(b, two.doc);
    expect(text).toContain(
      '*NODE\n29, 0, 0, 2\n30, 1, 0, 2\n31, 0, 1, 2\n32, 1, 1, 2\n33, 0, 0, 3\n34, 1, 0, 3\n35, 0, 1, 3\n36, 1, 1, 3\n',
    );
    expect(text).toContain('*NODE, NSET=PTN_1\n37, 0.5, 0.5, 2\n');
    expect(text).toContain('*NODE, NSET=PTN_2\n38, 0.5, 0.5, 3\n');
    expect(text).toContain('*CLOAD\n37, 1, 500\n38, 1, 10\n');
  });

  it('writes the preload on the oblique axis in every component that carries it, and no pretension card for a case without bolts', () => {
    const { b, doc } = withBolt({ section: { point: [0.5, 0.5, 2], normal: [1, 0, 1] } });
    expect(deckOf(b, doc)).toMatch(/\*EQUATION\n3\n\d+, 1, 1, \d+, 1, -1, \d+, 1, 0\.7071/);
    const plain = bolted();
    expect(deckOf(plain, plain.doc)).not.toContain('PTN_');
  });

  it('refuses a cut that touches a constraint node, a plane that misses the mesh, and an invalid stored bolt, with the bolt id', () => {
    const { b, doc, boltId } = withBolt();
    const mesh = boltedMesh(b, doc);
    const touched = writeInp(doc, b.analysisId, { ...mesh, nodeSets: { ...mesh.nodeSets, [`C_${b.bottomId}`]: [1, 2, 3, 4, 9] } });
    expect(touched).toMatchObject({ code: 'CNT_PRETENSION_SECTION_INVALID', ids: [boltId] });
    expect('message' in touched && touched.message).toContain('constraint, load or probe target');
    const analysis = caseOf(doc, b.analysisId);
    const bolt = analysis?.pretension?.bolts[boltId];
    if (analysis === undefined || bolt === undefined) throw new Error('no bolt');
    const at = (patch: Partial<typeof bolt>): CadDocument =>
      withCase(doc, { ...analysis, pretension: { order: [boltId], bolts: { [boltId]: { ...bolt, ...patch } } } });
    const flat = at({ section: { point: [0.5, 0.5, 0], normal: [0, 0, 1] } });
    expect(writeInp(flat, b.analysisId, boltedMesh(b, flat))).toMatchObject({ code: 'CNT_PRETENSION_SECTION_INVALID', ids: [boltId] });
    const late = at({ preloadStepId: 'gone' });
    expect(writeInp(late, b.analysisId, boltedMesh(b, late))).toMatchObject({ code: 'CNT_STEP_UNKNOWN', ids: [boltId] });
  });
});

/** Element rows `[id, ...nodes]` of every `*ELEMENT` card of a deck. */
function elementRows(text: string): number[][] {
  const rows: number[][] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('*')) inside = line.startsWith('*ELEMENT');
    else if (inside && line !== '') rows.push(line.split(', ').map(Number));
  }
  return rows;
}

/** Duplicate node ids of a deck: the rows of the `*NODE` card without a set. */
function duplicateIds(text: string): number[] {
  const lines = text.split('\n');
  const start = lines.indexOf('*NODE');
  const ids: number[] = [];
  for (let at = start + 1; start >= 0 && at < lines.length && !(lines[at] ?? '*').startsWith('*'); at++)
    ids.push(Number((lines[at] ?? '').split(', ')[0]));
  return ids;
}

describe('pretension deck invariants', () => {
  const nested = (
    planes: readonly number[],
    meshOf: (b: Bolted, doc: CadDocument) => FeMeshArtifact = boltedMesh,
  ): { b: Bolted; doc: CadDocument; text: string; mesh: FeMeshArtifact } => {
    const b = bolted();
    let doc = b.doc;
    planes.forEach((z, k) => {
      doc = must(
        doc,
        'add_bolt_pretension',
        sectionParams({ ...b, doc }, { name: `m${k}`, section: { point: [0.5, 0.5, z], normal: [0, 0, 1] } }),
      ).doc;
    });
    const built = meshOf(b, doc);
    return { b, doc, mesh: built, text: deckOf(b, doc, built) };
  };

  it('two sections of one part: every duplicate sits in an element, no element above a cut keeps a cut node, no element below one holds a copy', () => {
    const { b, text, mesh } = nested([1, 3]);
    const rows = elementRows(text);
    const copies = duplicateIds(text);
    expect(copies).toHaveLength(8);
    for (const copy of copies)
      expect(
        rows.some((row) => row.slice(1).includes(copy)),
        `duplicate ${copy} is in no element`,
      ).toBe(true);
    [1, 3].forEach((z, order) => {
      const cut = pretensionCut(mesh, b.bolt, [0.5, 0.5, z], [0, 0, 1]);
      if (isCutRefusal(cut)) throw new Error(cut.message);
      const own = copies.slice(4 * order, 4 * order + 4);
      for (const row of rows) {
        const [id = 0, ...nodes] = row;
        if (cut.highElements.has(id))
          expect(
            nodes.filter((node) => cut.nodes.includes(node)),
            `element ${id} above z=${z}`,
          ).toEqual([]);
        else if (id <= 24)
          expect(
            nodes.filter((node) => own.includes(node)),
            `element ${id} below z=${z}`,
          ).toEqual([]);
      }
    });
  });

  it('refuses two sections that share nodes (the same plane twice)', () => {
    const b = bolted();
    const one = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const two = must(one.doc, 'add_bolt_pretension', sectionParams(b, { name: 'again' }));
    expect(writeInp(two.doc, b.analysisId, boltedMesh(b, two.doc))).toMatchObject({
      code: 'CNT_PRETENSION_SECTION_INVALID',
      message: expect.stringContaining('shares nodes with the section'),
    });
  });

  it('cuts a second-order mesh: the mid-side nodes of the cut are duplicated too and every copy is attached to an element', () => {
    const { b, text, mesh } = nested([2], (bolt, doc) => quadraticMesh(boltedMesh(bolt, doc)));
    const cut = pretensionCut(mesh, b.bolt, [0.5, 0.5, 2], [0, 0, 1]);
    if (isCutRefusal(cut)) throw new Error(cut.message);
    expect(cut.nodes).toHaveLength(9);
    const copies = duplicateIds(text);
    expect(copies).toHaveLength(9);
    const rows = elementRows(text);
    for (const copy of copies) expect(rows.some((row) => row.slice(1).includes(copy))).toBe(true);
    for (const row of rows)
      if (cut.highElements.has(row[0] ?? 0)) expect(row.slice(1).filter((node) => cut.nodes.includes(node))).toEqual([]);
    expect(text.match(/^\*EQUATION$/gm)).toHaveLength(27);
  });

  it('refuses a cut node that another part uses (a conformal mesh shares nodes between parts) and a part with a node without coordinates', () => {
    const b = bolted();
    const added = must(b.doc, 'add_bolt_pretension', sectionParams(b));
    const mesh = boltedMesh(b, added.doc);
    const [boltBlock, plate] = mesh.blocks;
    if (boltBlock === undefined || plate === undefined) throw new Error('no blocks');
    const fused: FeMeshArtifact = {
      ...mesh,
      blocks: [
        boltBlock,
        { ...plate, elements: plate.elements.map(([id = 0, first = 0, ...rest]) => (id === 25 ? [id, 9, ...rest] : [id, first, ...rest])) },
      ],
    };
    expect(writeInp(added.doc, b.analysisId, fused)).toMatchObject({
      code: 'CNT_PRETENSION_SECTION_INVALID',
      message: expect.stringContaining('also a node of part'),
    });
    const holed: FeMeshArtifact = { ...mesh, nodes: mesh.nodes.filter(([id]) => id !== 3) };
    expect(writeInp(added.doc, b.analysisId, holed)).toMatchObject({
      code: 'CNT_PRETENSION_SECTION_INVALID',
      message: expect.stringContaining('no coordinates'),
    });
  });

  it('converts units: a centimetre document in a millimetre analysis puts the copies, the plane and the torque preload in millimetres', () => {
    const b = bolted({ units: 'cm' });
    const added = must(
      b.doc,
      'add_bolt_pretension',
      sectionParams(b, { preload: { kind: 'torque', torque: 50, diameter: 0.5, nutFactor: 0.2, nutFactorSource: 'test' } }),
    );
    const text = deckOf(b, added.doc);
    expect(text).toContain('*NODE\n29, 0, 0, 20\n30, 10, 0, 20\n31, 0, 10, 20\n32, 10, 10, 20\n');
    expect(text).toContain('*NODE, NSET=PTN_1\n33, 5, 5, 20\n');
    expect(text).toContain('*CLOAD\n33, 1, 50\n');
  });
});
