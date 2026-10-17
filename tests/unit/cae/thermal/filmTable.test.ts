import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext } from '@cae/decks/context';
import { thermalSections } from '@cae/thermal/deck';
import { bcFaces, bcFlowW, nodalLoadsW, type StepFields } from '@cae/thermal/bcFlows';
import { indexMesh, partVolumes } from '@cae/thermal/meshGeometry';
import { addBc, caseOf, facesOn, must, thermalFixture, twoTetMesh, TWO_TETS, type ThermalFixture } from './fixtures';
import { execute } from '@core/commands/registry';

const SOURCE = { citation: 'test source' };
const TABLE = {
  points: [
    [0, 100],
    [100, 300],
  ],
};
const sink = { value: 20, unit: 'degC' };

const filmParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'tab',
  kind: 'film',
  filmTable: TABLE,
  sinkTemperature: sink,
  source: SOURCE,
  target: { entityId: '', facesNear: [[0, 0, 0]] },
  ...extra,
});

function withFilm(
  extra: Record<string, unknown> = {},
  fixture: ThermalFixture = thermalFixture(),
): { fixture: ThermalFixture; doc: CadDocument; id: string } {
  const params = filmParams({ target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0]] }, ...extra });
  const added = addBc(fixture, params);
  return { fixture, doc: added.doc, id: added.id };
}

const sectionsText = (doc: CadDocument, fixture: ThermalFixture, mesh: FeMeshArtifact): string => {
  const ctx = buildDeckContext(doc, fixture.analysisId, mesh);
  const sections = ctx === null ? null : thermalSections(ctx);
  if (sections === null || !('text' in sections)) throw new Error(JSON.stringify(sections));
  return sections.text;
};

describe('film coefficient table h(T): set-up', () => {
  it('stores the table and refuses short, unordered, non-positive, out-of-range, unsourced, amplitude-scaled and transient tables', () => {
    const { fixture, doc, id } = withFilm();
    expect(caseOf(doc, fixture.analysisId).thermal?.bcs[id]?.bc).toMatchObject({ kind: 'film', filmCoefficient: { table: TABLE } });
    const refused = (extra: Record<string, unknown>, code: string, base: ThermalFixture = fixture): void => {
      const result = execute(base.doc, 'add_thermal_bc', {
        analysisId: base.analysisId,
        ...filmParams({ target: { entityId: base.boxId, facesNear: [[0.5, 0.5, 0]] }, ...extra }),
      });
      expect(result.affected, JSON.stringify(extra)).toEqual([]);
      expect(result.summary).toContain(code);
    };
    const rows = (...points: number[][]): Record<string, unknown> => ({ filmTable: { points } });
    refused(rows([0, 100]), 'THM_FILM_INVALID');
    refused(rows([10, 100], [10, 200]), 'THM_FILM_INVALID');
    refused(rows([0, 100], [50, 0]), 'THM_FILM_INVALID');
    refused(rows([-300, 100], [50, 10]), 'THM_FILM_INVALID');
    refused(rows([0, 100], [1e9, 10]), 'THM_FILM_INVALID');
    refused({ filmCoefficient: { value: 10, unit: 'W/(m^2*K)' } }, 'THM_FILM_INVALID');
    refused({ source: undefined }, 'THM_SOURCE_REQUIRED');
    const amplitude = must(fixture.doc, 'define_amplitude', {
      analysisId: fixture.analysisId,
      name: 'ramp',
      kind: 'table',
      points: [
        [0, 1],
        [10, 2],
      ],
    });
    refused({ amplitude: 'ramp' }, 'THM_FILM_INVALID', { ...fixture, doc: amplitude.document });
    const transient = thermalFixture({ type: 'heat_transient' });
    refused({}, 'THM_FILM_INVALID', transient);
  });

  it('update_thermal_bc keeps the table when only the sink temperature changes', () => {
    const { fixture, doc, id } = withFilm();
    const updated = must(doc, 'update_thermal_bc', {
      analysisId: fixture.analysisId,
      bcId: id,
      sinkTemperature: { value: 30, unit: 'degC' },
    });
    expect(caseOf(updated.document, fixture.analysisId).thermal?.bcs[id]?.bc).toMatchObject({
      filmCoefficient: { table: TABLE },
      sinkTemperature: { value: 30 },
    });
  });
});

describe('film coefficient table h(T): deck', () => {
  /** All four faces of tet A (nodes 1-2-3-4) as the film target. */
  function meshWithFilm(): { fixture: ThermalFixture; doc: CadDocument; id: string; mesh: FeMeshArtifact } {
    const fixture = thermalFixture();
    const film = withFilm({}, fixture);
    const cold = addBc(
      { ...fixture, doc: film.doc },
      { name: 'T', kind: 'temperature', value: 100, unit: 'degC', target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] } },
    );
    const faces = [
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ] as [number, number][];
    return {
      fixture,
      doc: cold.doc,
      id: film.id,
      mesh: twoTetMesh(fixture, { nodeSets: { [`B_${cold.id}`]: [1] }, faceSets: { [`B_${film.id}`]: faces } }),
    };
  }

  it('writes a sink wedge on the outer side of each face, the tied pair (sink as slave) with the table at the mean temperature, and the sink BC', () => {
    const { fixture, doc, id, mesh } = meshWithFilm();
    const text = sectionsText(doc, fixture, mesh);
    const base = id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    expect(text).toContain('*MATERIAL, NAME=FILM_SINK\n*CONDUCTIVITY\n1\n');
    expect(text).toContain(
      `*SURFACE INTERACTION, NAME=FI_${base}\n*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=TIED\n*GAP CONDUCTANCE\n100, 0, 10\n300, 0, 60\n`,
    );
    expect(text).toContain(`*CONTACT PAIR, INTERACTION=FI_${base}, TYPE=SURFACE TO SURFACE\nFM_${base}, FQ_${base}\n`);
    expect(text).toContain(`*INITIAL CONDITIONS, TYPE=TEMPERATURE\nFN_${base}, 20\n`);
    expect(text).toContain(`*BOUNDARY\nFN_${base}, 11, 11, 20\n`);
    expect(text).toContain(`*SURFACE, NAME=FQ_${base}, TYPE=ELEMENT\n1, S1\n1, S2\n1, S3\n1, S4\n`);
    expect(text).not.toContain('*FILM');
    expect(text.indexOf('*CONTACT PAIR')).toBeLessThan(text.indexOf('*STEP'));
    const coordinates = new Map<number, number[]>();
    const lines = text.split('\n');
    const nodeStart = lines.indexOf(`*NODE, NSET=FN_${base}`);
    for (const line of lines.slice(nodeStart + 1)) {
      if (line.startsWith('*')) break;
      const [node = 0, ...xyz] = line.split(', ').map(Number);
      coordinates.set(node, xyz);
    }
    expect([...coordinates.keys()]).toEqual(Array.from({ length: 24 }, (_, i) => 6 + i));
    const wedges = lines.filter((line) => /^\d+, \d+, \d+, \d+, \d+, \d+, \d+$/.test(line) && Number(line.split(', ')[0]) > 2);
    expect(wedges).toHaveLength(4);
    const tetA = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const centroid = [0.25, 0.25, 0.25];
    const faceCorners = [
      [0, 1, 2],
      [0, 3, 1],
      [1, 3, 2],
      [2, 3, 0],
    ];
    const opposite = [3, 2, 0, 1];
    wedges.forEach((line, index) => {
      const [, ...ids] = line.split(', ').map(Number);
      const [a, b, c, d] = ids.slice(0, 4).map((node) => coordinates.get(node) ?? []);
      const diff = (p: number[], q: number[]): number[] => p.map((x, i) => x - (q[i] ?? 0));
      const cross = (p: number[], q: number[]): number[] => [
        (p[1] ?? 0) * (q[2] ?? 0) - (p[2] ?? 0) * (q[1] ?? 0),
        (p[2] ?? 0) * (q[0] ?? 0) - (p[0] ?? 0) * (q[2] ?? 0),
        (p[0] ?? 0) * (q[1] ?? 0) - (p[1] ?? 0) * (q[0] ?? 0),
      ];
      const dot = (p: number[], q: number[]): number => p.reduce((sum, x, i) => sum + x * (q[i] ?? 0), 0);
      const up = diff(d ?? [], a ?? []);
      expect(dot(cross(diff(b ?? [], a ?? []), diff(c ?? [], a ?? [])), up), `wedge ${index} volume`).toBeGreaterThan(0);
      const corners = (faceCorners[index] ?? []).map((corner) => tetA[corner] ?? []);
      for (const corner of [a, b, c]) expect(corners.some((p) => p.every((x, i) => Math.abs(x - (corner?.[i] ?? 99)) < 1e-12))).toBe(true);
      const away = diff(corners[0] ?? [], tetA[opposite[index] ?? 0] ?? []);
      expect(dot(up, away), `wedge ${index} outward`).toBeGreaterThan(0);
      expect(dot(up, diff(corners[0] ?? [], centroid))).toBeGreaterThan(0);
    });
  });

  it('refuses a stored film table once the case is no longer heat_steady (the deck never drops it silently)', () => {
    const { fixture, doc, mesh } = meshWithFilm();
    const stored = caseOf(doc, fixture.analysisId);
    const transient: CadDocument = {
      ...doc,
      analysis: {
        ...doc.analysis!,
        cases: {
          [fixture.analysisId]: {
            ...stored,
            type: 'heat_transient' as const,
            thermal: { ...stored.thermal!, initialTemperature: { value: 20, unit: 'degC' }, step: { endTimeS: 10 } },
          },
        },
      },
    };
    const ctx = buildDeckContext(transient, fixture.analysisId, mesh);
    expect(ctx && thermalSections(ctx)).toMatchObject({ code: 'THM_FILM_INVALID' });
  });

  it('refuses a film table whose faces are missing from the mesh (FEA_TARGET_UNRESOLVED)', () => {
    const { fixture, doc, id, mesh } = meshWithFilm();
    const ctx = buildDeckContext(doc, fixture.analysisId, { ...mesh, faceSets: {} });
    expect(ctx && thermalSections(ctx)).toMatchObject({ code: 'FEA_TARGET_UNRESOLVED', ids: expect.arrayContaining([id]) as unknown });
  });
});

describe('film coefficient table h(T): quadratic faces', () => {
  it('writes a 15-node wedge on a C3D10 face whose bottom mid-side nodes are the midpoints of its own bottom corners', () => {
    const fixture = thermalFixture();
    const film = withFilm({}, fixture);
    const cold = addBc(
      { ...fixture, doc: film.doc },
      { name: 'T', kind: 'temperature', value: 100, unit: 'degC', target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] } },
    );
    const corners = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const mid = (i: number, j: number): number[] => [0, 1, 2].map((axis) => ((corners[i]?.[axis] ?? 0) + (corners[j]?.[axis] ?? 0)) / 2);
    const nodes: [number, number, number, number][] = [
      ...corners.map((p, i): [number, number, number, number] => [i + 1, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]),
      ...[mid(0, 1), mid(1, 2), mid(2, 0), mid(0, 3), mid(1, 3), mid(2, 3)].map((p, i): [number, number, number, number] => [
        5 + i,
        p[0] ?? 0,
        p[1] ?? 0,
        p[2] ?? 0,
      ]),
    ];
    const base = twoTetMesh(fixture, { nodeSets: { [`B_${cold.id}`]: [1] }, faceSets: { [`B_${film.id}`]: [[1, 1]] } });
    const mesh: FeMeshArtifact = {
      ...base,
      nodes,
      blocks: [{ type: 'C3D10', entityId: fixture.boxId, elements: [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }],
    };
    const text = sectionsText(cold.doc, fixture, mesh);
    const lines = text.split('\n');
    const elementLine = lines[lines.findIndex((line) => line.startsWith('*ELEMENT, TYPE=C3D15, ELSET=FS_')) + 1] ?? '';
    const ids = elementLine.split(', ').map(Number).slice(1);
    expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => 11 + i));
    const nodeStart = lines.findIndex((line) => line.startsWith('*NODE, NSET=FN_'));
    const at = (id: number): number[] => (lines[nodeStart + (id - 10)] ?? '').split(', ').slice(1).map(Number);
    const [a, b, c] = [at(ids[0] ?? 0), at(ids[1] ?? 0), at(ids[2] ?? 0)];
    const midpoint = (p: number[], q: number[]): number[] => p.map((x, i) => (x + (q[i] ?? 0)) / 2);
    expect(at(ids[6] ?? 0)).toEqual(midpoint(a, b));
    expect(at(ids[7] ?? 0)).toEqual(midpoint(b, c));
    expect(at(ids[8] ?? 0)).toEqual(midpoint(c, a));
    const top = at(ids[3] ?? 0);
    at(ids[12] ?? 0).forEach((x, axis) => expect(x - (a[axis] ?? 0)).toBeCloseTo(((top[axis] ?? 0) - (a[axis] ?? 0)) / 2, 9));
    expect(top[2]).toBeLessThan(0);
  });
});

describe('film coefficient table h(T): flows', () => {
  it('integrates h(T)(sink - T) over the face (end values held outside the table) and leaves no nodal load (the gap sits in the stiffness)', () => {
    const fixture = thermalFixture();
    const film = withFilm({}, fixture);
    const mesh = twoTetMesh(fixture, { faceSets: { [`B_${film.id}`]: facesOn(TWO_TETS, [1, 2, 3]) } });
    const thermal = caseOf(film.doc, fixture.analysisId).thermal;
    const index = indexMesh(mesh);
    if (thermal === undefined) throw new Error('no thermal');
    const record = thermal.bcs[film.id];
    if (record === undefined) throw new Error('no bc');
    const inputs = {
      thermal,
      mesh,
      index,
      unitSystem: caseOf(film.doc, fixture.analysisId).unitSystem,
      volumes: partVolumes(index),
      faces: bcFaces(thermal, mesh, index),
    };
    const at = (temperature: number): StepFields => ({ time: 0, temperature: () => temperature, reaction: () => 0 });
    const area = 0.5;
    expect(bcFlowW(inputs, record, at(60), true)).toBeCloseTo(220 * (20 - 60) * area, 6);
    expect(bcFlowW(inputs, record, at(500), true)).toBeCloseTo(300 * (20 - 500) * area, 6);
    expect(bcFlowW(inputs, record, at(-50), true)).toBeCloseTo(100 * (20 + 50) * area, 6);
    expect(nodalLoadsW(inputs, record, at(60), true).size).toBe(0);
  });
});
