import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { BAR_NODES, X0_NODES, X2_NODES, barDocument, barMesh, facesOn, mustRun, type Bar } from './deckFixtures';

/** Add a constraint / load, returning the new document and its id. */
function add(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params);
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] ?? '' };
}

const deckOf = (
  bar: Bar,
  doc: CadDocument,
  sets: Record<string, readonly number[]>,
  faces: Record<string, [number, number][]> = {},
): string => {
  const base: Record<string, readonly number[]> = {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
  };
  const mesh: FeMeshArtifact = barMesh(doc, bar.analysisId, bar.boxId, { ...base, ...sets }, faces);
  const written = writeInp(doc, bar.analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
};

const stepOf = (text: string): string[] => text.slice(text.indexOf('*STEP')).split('\n');

describe('static deck: constraints', () => {
  it('writes fixed / pinned as dofs 1-3 and displacements in analysis units', () => {
    const bar = barDocument();
    let doc = bar.doc;
    const fixed = add(doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'fix',
      kind: 'fixed',
      target: { entityId: bar.boxId, facesNear: [[1, 0.5, 0]] },
    });
    doc = fixed.doc;
    const pinned = add(doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'pin',
      kind: 'pinned',
      target: { entityId: bar.boxId, edgesNear: [[1, 0, 0]] },
    });
    doc = pinned.doc;
    const pull = add(doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'pull',
      kind: 'displacement',
      dofs: { ux: 0.002, uy: 0 },
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    doc = pull.doc;
    const lines = stepOf(deckOf(bar, doc, { [`C_${fixed.id}`]: [1, 3], [`C_${pinned.id}`]: [1, 2], [`C_${pull.id}`]: X2_NODES }));
    const name = (id: string): string => `C_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
    expect(lines).toContain(`${name(fixed.id)}, 1, 3`);
    expect(lines).toContain(`${name(pinned.id)}, 1, 3`);
    expect(lines).toContain(`${name(pull.id)}, 1, 1, 0.002`);
    expect(lines).toContain(`${name(pull.id)}, 2, 2`);
    expect(lines[0]).toBe('*STEP');
    expect(lines).toContain('*BOUNDARY, OP=NEW');
  });

  it('holds the plane normal of a symmetry constraint and refuses a plane that is not axis-aligned', () => {
    const bar = barDocument({ supports: false });
    const sym = add(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'sym',
      kind: 'symmetry',
      target: { entityId: bar.boxId, facesNear: [[0, 0.5, 0.5]] },
    });
    const text = deckOf({ ...bar, constraints: {} }, sym.doc, { [`C_${sym.id}`]: X0_NODES });
    expect(stepOf(text)).toContain(`C_${sym.id.replace(/[^A-Za-z0-9_]/g, '_')}, 1, 1`);
    const skew = barMesh(sym.doc, bar.analysisId, bar.boxId, { [`C_${sym.id}`]: [1, 4, 6] });
    expect(writeInp(sym.doc, bar.analysisId, skew)).toMatchObject({ code: 'FEA_CONSTRAINT_INVALID' });
  });

  it('refuses rotational dofs and constraints without nodes in the mesh', () => {
    const bar = barDocument({ supports: false });
    const rot = add(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'rot',
      kind: 'displacement',
      dofs: { rx: 0 },
      target: { entityId: bar.boxId, facesNear: [[0, 0.5, 0.5]] },
    });
    const withRot = barMesh(rot.doc, bar.analysisId, bar.boxId, { [`C_${rot.id}`]: X0_NODES });
    expect(writeInp(rot.doc, bar.analysisId, withRot)).toMatchObject({ code: 'FEA_CONSTRAINT_INVALID', ids: [rot.id] });
    const empty = barMesh(rot.doc, bar.analysisId, bar.boxId, {});
    expect(writeInp(rot.doc, bar.analysisId, empty)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [rot.id] });
  });
});

describe('static deck: loads', () => {
  const loaded = (): { bar: Bar; doc: CadDocument } => {
    const bar = barDocument();
    return { bar, doc: bar.doc };
  };

  it('splits a total force equally over the target nodes and applies per_node at each node', () => {
    const { bar, doc } = loaded();
    const total = add(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'pull',
      kind: 'force',
      vector: [100, 0, -40],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const perNode = add(total.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'each',
      kind: 'force',
      distribution: 'per_node',
      vector: [0, 1, 0],
      target: { entityId: bar.boxId, pointsNear: [[2, 0, 0]] },
    });
    const text = deckOf(bar, perNode.doc, { [`L_${total.id}`]: X2_NODES, [`L_${perNode.id}`]: [2] });
    const lines = stepOf(text);
    expect(lines).toContain('*CLOAD, OP=NEW');
    expect(lines).toContain('2, 1, 25');
    expect(lines).toContain('2, 2, 1');
    expect(lines).toContain('2, 3, -10');
    expect(lines).toContain('8, 1, 25');
    expect(lines.filter((line) => /^\d+, 1, 25$/.test(line))).toHaveLength(4);
  });

  it('writes pressure as P<face> per element face, summing loads on the same face', () => {
    const { bar, doc } = loaded();
    const faces = facesOn(X2_NODES);
    expect(faces.length).toBeGreaterThan(0);
    const one = add(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'p1',
      kind: 'pressure',
      magnitude: 2,
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const two = add(one.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'p2',
      kind: 'pressure',
      magnitude: 0.5,
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const lines = stepOf(deckOf(bar, two.doc, {}, { [`L_${one.id}`]: faces, [`L_${two.id}`]: faces }));
    expect(lines).toContain('*DLOAD, OP=NEW');
    for (const [element, face] of faces) expect(lines).toContain(`${element}, P${face}, 2.5`);
  });

  it('writes gravity as magnitude and unit direction on every element, and restates loads in every load case', () => {
    const { bar, doc } = loaded();
    const gravity = add(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'g',
      kind: 'gravity',
      vector: [0, 0, -9810],
      loadCase: 'LC1',
    });
    const force = add(gravity.doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'f',
      kind: 'force',
      vector: [0, 0, 8],
      loadCase: 'LC2',
      category: 'ultimate',
      target: { entityId: bar.boxId, pointsNear: [[2, 0, 0]] },
    });
    const text = deckOf(bar, force.doc, { [`L_${force.id}`]: [2] });
    expect(text).toContain('EALL, GRAV, 9810, 0, 0, -1');
    expect(text.match(/\*STEP/g)).toHaveLength(2);
    expect(text.match(/\*STATIC/g)).toHaveLength(2);
    const second = text.slice(text.lastIndexOf('** load case LC2'));
    expect(second).toContain('2, 3, 8');
    expect(second).not.toContain('GRAV');
    expect(second).toContain('*DLOAD, OP=NEW');
    expect(text.slice(0, text.lastIndexOf('** load case LC2'))).not.toContain('2, 3, 8');
  });

  it('refuses a force or pressure whose target has no nodes / faces in the mesh', () => {
    const { bar, doc } = loaded();
    const force = add(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'f',
      kind: 'force',
      vector: [1, 0, 0],
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const supports = {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
    };
    const forceMesh = barMesh(force.doc, bar.analysisId, bar.boxId, supports);
    expect(writeInp(force.doc, bar.analysisId, forceMesh)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [force.id] });
    const pressure = add(doc, 'add_fea_load', {
      analysisId: bar.analysisId,
      name: 'p',
      kind: 'pressure',
      magnitude: 1,
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const pressureMesh = barMesh(pressure.doc, bar.analysisId, bar.boxId, supports);
    expect(writeInp(pressure.doc, bar.analysisId, pressureMesh)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: [pressure.id] });
  });

  it('requests node prints only for displacement probes with a resolved node', () => {
    const { bar, doc } = loaded();
    const withProbe = mustRun(doc, 'add_result_probe', { analysisId: bar.analysisId, name: 'tip', point: [2, 0, 0], quantity: 'u_x' });
    const probeId = Object.keys(withProbe.analysis?.cases[bar.analysisId]?.probes ?? {})[0] ?? '';
    const stress = mustRun(withProbe, 'add_result_probe', {
      analysisId: bar.analysisId,
      name: 's',
      point: [2, 0, 0],
      quantity: 'von_mises',
    });
    const text = deckOf(bar, stress, { [`P_${probeId}`]: [2] });
    expect(text).toContain(`*NODE PRINT, NSET=P_${probeId.replace(/[^A-Za-z0-9_]/g, '_')}\nU\n`);
    expect(text.match(/\*NODE PRINT/g)).toHaveLength(1);
  });
});

describe('static deck: model block', () => {
  it('lists nodes, elements per part, element sets and key-sorted node sets', () => {
    const bar = barDocument();
    const text = deckOf(bar, bar.doc, {});
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^\*\* llull analysis bar units N-mm-t-s inputHash [0-9a-f]{64} meshHash [0-9a-f]{64}$/);
    expect(lines.slice(1, 4)).toEqual(['*HEADING', expect.stringMatching(/^llull inputHash [0-9a-f]{16}$/), '*NODE, NSET=NALL']);
    expect(lines[4]).toBe('1, 0, 0, 0');
    expect(BAR_NODES.length).toBe(8);
    expect(text).toContain('*ELEMENT, TYPE=C3D4, ELSET=P_');
    expect(text).toContain('*ELSET, ELSET=EALL\nP_');
    const sets = lines.filter((line) => line.startsWith('*NSET, NSET='));
    expect(sets).toEqual([...sets].sort());
    expect(sets).toHaveLength(3);
  });
});
