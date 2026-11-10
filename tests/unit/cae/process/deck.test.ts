/** PHY-16 §5.3 deck: layer sets, per-layer expansion tables, the two steps per layer, release step with snapped 3-2-1 nodes, outputs and refusals. */
import { describe, expect, it } from 'vitest';
import type { AmReleaseStep } from '@core/model/am';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf, withCase } from '@cae/shared/access';
import { amBar, amMesh, must, type AmBar } from './support';

const written = (bar: AmBar, doc: CadDocument = bar.doc): { text: string } | { code: string; message: string } =>
  writeInp(doc, bar.analysisId, amMesh(bar, doc));

function deckOf(bar: AmBar, doc: CadDocument = bar.doc): string {
  const result = written(bar, doc);
  if (!('text' in result)) throw new Error(`${result.code}: ${result.message}`);
  return result.text;
}

const refusalOf = (bar: AmBar, doc: CadDocument = bar.doc): { code: string; message: string } => {
  const result = written(bar, doc);
  if ('text' in result) throw new Error('the deck was written');
  return result;
};

/** The lines from the initial conditions on. */
const steps = (text: string): string[] => text.slice(text.indexOf('*INITIAL CONDITIONS')).split('\n');

/** The rows of the expansion table of material `name`. */
const tableOf = (lines: readonly string[], name: string): string[][] => {
  const at = lines.indexOf('*EXPANSION, TYPE=ORTHO, ZERO=0', lines.indexOf(`*MATERIAL, NAME=${name}`));
  const rows: string[][] = [];
  for (let i = at + 1; i < lines.length && /^[-0-9]/.test(lines[i] ?? ''); i++) rows.push((lines[i] ?? '').split(', '));
  return rows;
};

const releaseStep = (name: string): AmReleaseStep => ({
  name,
  remove: ['plate'],
  support321: [
    [2, 0, 0],
    [2, 1, 0],
    [0, 0, 0],
  ],
});

const withAm = (bar: AmBar, patch: Record<string, unknown>): CadDocument => {
  const analysis = caseOf(bar.doc, bar.analysisId);
  if (analysis?.am === undefined) throw new Error('no am');
  return withCase(bar.doc, { ...analysis, am: { ...analysis.am, ...patch } });
};

describe('am_build_distortion deck', () => {
  const bar = amBar({ release: true });
  const text = deckOf(bar);
  const lines = text.split('\n');

  it('writes the build-frame orientation, one material per layer with the saturating table and one section per layer set; the plate keeps its own section', () => {
    const orientation = lines.indexOf('*ORIENTATION, NAME=AM_BUILD, SYSTEM=RECTANGULAR');
    expect(orientation).toBeGreaterThan(0);
    expect(lines[orientation + 1]).toBe('1, 0, 0, 0, 1, 0');
    expect(tableOf(lines, 'MAM_1_1').map((r) => r.join(', '))).toEqual([
      '0, 0, 0, 0',
      '-0.002, 0, 0, 1',
      '-0.001, 0, 0, 2',
      '-0.000666666666667, 0, 0, 3',
    ]);
    expect(tableOf(lines, 'MAM_3_1').map((r) => r.join(', '))).toEqual(['0, 0, 0, 2', '-0.000666666666667, 0, 0, 3']);
    for (const k of [1, 2, 3]) expect(lines).toContain(`*SOLID SECTION, ELSET=AML_${k}_1, MATERIAL=MAM_${k}_1, ORIENTATION=AM_BUILD`);
    expect(lines).toContain('*SOLID SECTION, ELSET=P_box_1_1, MATERIAL=M_1');
    expect(lines.some((line) => line.startsWith('*SOLID SECTION, ELSET=P_box_2_1'))).toBe(false);
  });

  it('every table obeys e(T) = eps clamp(T - (s - 1), 0, 1): alpha(T) T equals the strain at each integer temperature', () => {
    for (let s = 1; s <= 3; s++) {
      const rows = tableOf(lines, `MAM_${s}_1`);
      expect(rows).toHaveLength(3 - s + 2);
      for (const row of rows) {
        const [alpha = 0, , , temperature = 0] = row.map(Number);
        expect(alpha * temperature).toBeCloseTo(-0.002 * Math.min(1, Math.max(0, temperature - (s - 1))), 12);
      }
    }
  });

  it('removes every layer in step 1, then per layer adds it strain free in one step and raises the global temperature in the next; results only at the end of the build and after the release', () => {
    const procedure = steps(text);
    expect(procedure.filter((line) => line === '*STEP, NLGEOM')).toHaveLength(8);
    expect(procedure.filter((line) => line === '*MODEL CHANGE, TYPE=ELEMENT, ADD=STRAIN FREE')).toHaveLength(3);
    expect(procedure.filter((line) => line.startsWith('*MODEL CHANGE, TYPE=ELEMENT, REMOVE'))).toHaveLength(2);
    const removeAt = procedure.indexOf('*MODEL CHANGE, TYPE=ELEMENT, REMOVE');
    expect(procedure[removeAt + 1]).toBe('AML_1_1, AML_2_1, AML_3_1');
    expect(procedure.slice(procedure.indexOf('** step 1: every layer removed, constraints applied'), removeAt)).toContain(
      '*BOUNDARY, OP=NEW',
    );
    expect(procedure.filter((line) => /^NALL, \d$/.test(line))).toEqual(['NALL, 0', 'NALL, 0', 'NALL, 1', 'NALL, 2', 'NALL, 3']);
    expect(procedure.filter((line) => line === '*NODE FILE')).toHaveLength(2);
    expect(procedure.filter((line) => line === '*EL FILE')).toHaveLength(2);
    expect(procedure.some((line) => line.startsWith('*CLOAD') || line.startsWith('*DLOAD'))).toBe(false);
    const order = [
      'step 1',
      'step 2: layer 1',
      'step 3: global temperature 1',
      'step 4: layer 2',
      'step 5: global temperature 2',
      'step 6: layer 3',
      'step 7: global temperature 3',
      'step 8: release',
    ];
    const at = order.map((tag) => procedure.findIndex((line) => line.startsWith(`** ${tag}`)));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('release: removes the plate, replaces the constraints by the 3-2-1 on the nearest nodes of the remaining parts, with the dofs of support321', () => {
    const procedure = steps(text);
    const release = procedure.slice(procedure.findIndex((line) => line.startsWith('** step 8')));
    const remove = release.indexOf('*MODEL CHANGE, TYPE=ELEMENT, REMOVE');
    expect(release[remove + 1]).toBe('P_box_1_1');
    const boundary = release.indexOf('*BOUNDARY, OP=NEW');
    expect(release.slice(boundary, boundary + 7)).toEqual([
      '*BOUNDARY, OP=NEW',
      '23, 1, 1',
      '23, 2, 2',
      '23, 3, 3',
      '28, 1, 1',
      '28, 3, 3',
      '21, 3, 3',
    ]);
    expect(release[0]).toContain('3-2-1 on nodes 23 (0 mm from the point), 28 (0 mm from the point), 21 (0 mm from the point)');
  });

  it('is byte-deterministic', () => {
    expect(deckOf(amBar({ release: true }))).toBe(text);
  });

  it('a layer height finer than the mesh reports the empty layers in the deck header', () => {
    const fine = amBar({ release: true });
    const doc = must(fine.doc, 'am_build_setup', {
      analysisId: fine.analysisId,
      buildDirection: [0, 0, 1],
      plateEntityId: fine.plate,
      layerHeight: 0.1,
    }).doc;
    expect(deckOf(fine, doc)).toMatch(/EMPTY layers \d/);
  });

  it('a build along document X uses the document Y as frame x and Z as frame y (right handed, frame z = the build direction)', () => {
    const along = amBar();
    const doc = must(along.doc, 'am_build_setup', {
      analysisId: along.analysisId,
      buildDirection: [1, 0, 0],
      plateEntityId: along.plate,
      layerHeight: 0.5,
    }).doc;
    const frame = deckOf(along, doc).split('\n');
    expect(frame[frame.indexOf('*ORIENTATION, NAME=AM_BUILD, SYSTEM=RECTANGULAR') + 1]).toBe('0, 1, 0, 0, 0, 1');
  });
});

describe('am_build_distortion deck refusals', () => {
  it('refuses a case without a set-up, without a strain, with loads, and without the part to build', () => {
    expect(refusalOf(amBar({ setup: false })).code).toBe('PRC_BUILD_SETUP_MISSING');
    expect(refusalOf(amBar({ strain: false })).code).toBe('PRC_INHERENT_STRAIN_MISSING');
    const good = amBar();
    const loaded = must(good.doc, 'add_fea_load', {
      analysisId: good.analysisId,
      name: 'g',
      kind: 'gravity',
      loadCase: 'LC1',
      category: 'limit',
      vector: [0, 0, -9810],
    }).doc;
    expect(refusalOf(good, loaded).code).toBe('PRC_LOADS_UNSUPPORTED');
    expect(refusalOf(good, withAm(good, { supportEntityIds: [good.deposit] })).code).toBe('PRC_PART_NOT_BUILT');
  });

  it('refuses a release whose points snap to one node or to collinear nodes', () => {
    const bar = amBar();
    const withPoints = (points: [number, number, number][]): CadDocument =>
      withAm(bar, {
        releaseSteps: [
          { name: 'cut', remove: ['plate'], support321: [points[0] ?? [0, 0, 0], points[1] ?? [0, 0, 0], points[2] ?? [0, 0, 0]] },
        ],
      });
    const sameNode = refusalOf(
      bar,
      withPoints([
        [2, 0, 0],
        [2.1, 0.1, 0],
        [1.9, 0, 0.1],
      ]),
    );
    expect(sameNode.code).toBe('PRC_RELEASE_UNSUPPORTED');
    expect(sameNode.message).toContain('distinct nodes');
    const collinear = refusalOf(
      bar,
      withPoints([
        [0, 0, 0],
        [2, 0.2, 0],
        [4, 0, 0],
      ]),
    );
    expect(collinear.code).toBe('PRC_RELEASE_UNSUPPORTED');
    expect(collinear.message).toContain('collinear');
  });

  it('a second removal of a part is not written (CalculiX breaks on it): the step keeps its support and removes nothing', () => {
    const bar = amBar();
    const procedure = steps(deckOf(bar, withAm(bar, { releaseSteps: [releaseStep('first'), releaseStep('second')] })));
    expect(procedure.filter((line) => line.startsWith('*MODEL CHANGE, TYPE=ELEMENT, REMOVE'))).toHaveLength(2);
    expect(procedure.find((line) => line.includes("release 'second'"))).toContain('remove nothing');
  });
});
