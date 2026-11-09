/**
 * PHY-06 M3b: a nonlinear case with BOTH a bolt pretension and a buckling imperfection (merge 53d31591c). The duplicated nodes of the pretension cut
 * must sit where their originals sit after the imperfection moved them, otherwise the cut opens by the offset and the preload section is torn.
 * Bar: bolt 1 x 1 x 4 (four cubes, 24 tets), cut at z = 2; mode shape ux = (z / 5)^2, peak 1 at the plate top, amplitude 0.5.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { bucklingDat } from '../eigenFixtures';
import { hashOf, portOf } from '../deckFixtures';
import { must } from './support';
import { bolted, boltedMesh, facesIn, sectionParams, type Bolted } from './boltSupport';

const AMPLITUDE = 0.5;
const shape = (z: number): number => (z / 5) ** 2;

interface Imperfect {
  readonly b: Bolted;
  readonly doc: CadDocument;
  readonly mesh: FeMeshArtifact;
  readonly ctx: ExecutionContext;
  readonly boltId: string;
}

/** The bolted case with a pretension at z = 2 and an imperfection from a solved buckling case `bk` meshed node-for-node like it. */
function imperfectBolted(withPretension = true): Imperfect {
  const b = bolted();
  let doc = b.doc;
  let boltId = '';
  if (withPretension) {
    const added = must(doc, 'add_bolt_pretension', sectionParams(b));
    doc = added.doc;
    boltId = added.affected[1] ?? '';
  }
  const created = must(doc, 'create_analysis', { name: 'bk', analysisType: 'buckling', modes: 1 });
  const bucklingId = created.affected[0] ?? '';
  doc = created.doc;
  for (const entityId of [b.bolt, b.plate]) doc = must(doc, 'set_part_idealization', { analysisId: bucklingId, entityId }).doc;
  const fixed = must(doc, 'add_fea_constraint', {
    analysisId: bucklingId,
    name: 'base',
    kind: 'fixed',
    target: { entityId: b.bolt, facesNear: [[0.5, 0.5, 0]] },
  });
  const load = must(fixed.doc, 'add_fea_load', {
    analysisId: bucklingId,
    name: 'axial',
    kind: 'force',
    loadCase: 'LC1',
    vector: [0, 0, -1],
    target: { entityId: b.plate, facesNear: [[0.5, 0.5, 5]] },
  });
  doc = load.doc;
  const nodes = boltedMesh(b, doc).nodes;
  const bucklingMesh: FeMeshArtifact = {
    ...boltedMesh(b, doc),
    inputHash: analysisInputHash(doc, bucklingId, 'mesh'),
    nodeSets: { [`C_${fixed.affected[0]}`]: [1, 2, 3, 4], [`L_${load.affected[0]}`]: [25, 26, 27, 28] },
    faceSets: { [`L_${load.affected[0]}`]: facesIn([25, 26, 27, 28], 25, 30) },
  };
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(bucklingMesh),
    inputHash: analysisInputHash(doc, bucklingId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: [
      {
        step: 1,
        time: 4.5,
        fields: {
          DISP: { components: ['D1', 'D2', 'D3'], values: Object.fromEntries(nodes.map(([id, , , z]) => [String(id), [shape(z), 0, 0]])) },
        },
      },
    ],
    dat: parseDat(bucklingDat([4.5])),
  };
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(bucklingMesh, results) };
  const meshed = must(doc, 'record_fe_mesh', { analysisId: bucklingId, summary: meshSummary(bucklingMesh, hashOf(bucklingMesh)) }, ctx);
  const summary = resultsSummary(meshed.doc, bucklingId, bucklingMesh, results, hashOf(results));
  doc = must(meshed.doc, 'record_fea_results', { analysisId: bucklingId, summary }, ctx).doc;
  doc = must(
    doc,
    'add_imperfection',
    { analysisId: b.analysisId, fromAnalysisId: bucklingId, modes: [{ mode: 1, amplitude: AMPLITUDE }], amplitudeSource: 'unit fixture' },
    ctx,
  ).doc;
  return { b, doc, mesh: boltedMesh(b, doc), ctx, boltId };
}

/** `*NODE` rows of the deck (the mesh block and the duplicate block): id -> [x, y, z]. */
function nodeRows(text: string): Map<number, number[]> {
  const rows = new Map<number, number[]>();
  let inNode = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('*')) inNode = line.startsWith('*NODE,') ? !line.includes('NSET=PTN') : line === '*NODE';
    else if (inNode) {
      const [id, ...xyz] = line.split(',').map(Number);
      if (id !== undefined) rows.set(id, xyz);
    }
  }
  return rows;
}

const deckOf = (i: Imperfect): string => {
  const written = writeInp(i.doc, i.b.analysisId, i.mesh, i.ctx.feaArtifacts ?? null);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
};

describe('pretension + imperfection in one deck', () => {
  it('writes each duplicate at the IMPERFECT coordinates of its original (x moved by 0.5 (z/5)^2 = 0.08 at z = 2), not at the mesh coordinates', () => {
    const i = imperfectBolted();
    const rows = nodeRows(deckOf(i));
    const offset = AMPLITUDE * shape(2);
    expect(offset).toBeCloseTo(0.08, 12);
    // mesh cut nodes 9..12 (z = 2, k = 2: id 1 + i + 2j + 4k) and their copies 29..32 (ascending)
    const cut = [9, 10, 11, 12];
    const originals = cut.map((id) => rows.get(id));
    expect(originals).toEqual([
      [0.08, 0, 2],
      [1.08, 0, 2],
      [0.08, 1, 2],
      [1.08, 1, 2],
    ]);
    const copies = [29, 30, 31, 32].map((id) => rows.get(id));
    expect(copies).toEqual(originals);
    // the reference node is not a mesh node: it stays at the plane point
    expect(deckOf(i)).toContain('*NODE, NSET=PTN_1\n33, 0.5, 0.5, 2\n');
  });

  it('every duplicate lies exactly on its original in every coordinate (cut stays closed), for the whole bar', () => {
    const i = imperfectBolted();
    const text = deckOf(i);
    const rows = nodeRows(text);
    const pairs = [...text.matchAll(/^(\d+), 1, 1, (\d+), 1, -1$/gm)].map(
      ([, copy, original]) => [Number(copy), Number(original)] as const,
    );
    expect(pairs).toHaveLength(4);
    for (const [copy, original] of pairs) expect(rows.get(copy)).toEqual(rows.get(original));
    // and the imperfection really moved the bar: a mid-height node differs from its mesh coordinate
    expect(rows.get(1)?.[0]).toBe(0);
    expect(rows.get(21)?.[0]).toBeCloseTo(AMPLITUDE * shape(4), 12);
  });

  it('without the pretension the same imperfection writes no duplicate block (control)', () => {
    const i = imperfectBolted(false);
    const rows = nodeRows(deckOf(i));
    expect(rows.has(29)).toBe(false);
    expect(rows.get(9)?.[0]).toBeCloseTo(AMPLITUDE * shape(2), 12);
  });
});
