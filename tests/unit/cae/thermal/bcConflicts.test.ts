import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { writeInp } from '@cae/decks/inpWriter';
import { temperatureBcConflicts, temperatureOverridesFlows } from '@cae/thermal/bcConflicts';
import { caseOf } from './fixtures';
import { addBc, machineContext, recorded, resultsFor, thermalFixture, twoTetMesh } from './fixtures';

const source = { citation: 'test input' };
const hot = (value: number, x: number): Record<string, unknown> => ({
  name: `t${value}`,
  kind: 'temperature',
  value,
  unit: 'degC',
  source,
  target: { entityId: '', facesNear: [[x, 0.5, 0.025]] },
});

function solvedWith(
  values: readonly [number, number],
  sharedFace: boolean,
): { doc: ReturnType<typeof recorded>; ids: string[]; analysisId: string } {
  const base = thermalFixture();
  const first = addBc(base, { ...hot(values[0], 0), target: { entityId: base.boxId, facesNear: [[0, 0.5, 0.025]] } });
  const second = addBc(
    { ...base, doc: first.doc },
    { ...hot(values[1], 1), target: { entityId: base.boxId, facesNear: [[sharedFace ? 0 : 1, 0.5, 0.025]] } },
  );
  const fixture = { ...base, doc: second.doc };
  const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${first.id}`]: [1, 3, 4], [`B_${second.id}`]: sharedFace ? [1, 3, 4] : [5] } });
  const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: values[1], 2: 60, 3: values[1], 4: values[1], 5: 40 } }]);
  return { doc: recorded(fixture, mesh, results), ids: [first.id, second.id], analysisId: base.analysisId };
}

describe('check_thermal THM_BC_CONFLICT', () => {
  it('fails when two temperature BCs prescribe different values on the same nodes', () => {
    const { doc, ids, analysisId } = solvedWith([50, 80], true);
    const result = execute(doc, 'check_thermal', { analysisId }, machineContext());
    const items = (result.data as { items: { code: string; ids: string[]; message: string }[] }).items;
    const conflict = items.find((entry) => entry.code === 'THM_BC_CONFLICT');
    expect(conflict?.ids).toEqual(ids);
    expect(conflict?.message).toContain('3 shared node(s)');
    expect((result.data as { status: string }).status).toBe('fail');
  });

  it('accepts equal values on shared nodes and different values on separate nodes', () => {
    for (const [values, shared] of [
      [[50, 50], true],
      [[50, 80], false],
    ] as const) {
      const { doc, analysisId } = solvedWith(values, shared);
      const items = (execute(doc, 'check_thermal', { analysisId }, machineContext()).data as { items: { code: string }[] }).items;
      expect(items.some((entry) => entry.code === 'THM_BC_CONFLICT')).toBe(false);
    }
  });
});

const film = (x: number, face: [number, number, number]): Record<string, unknown> => ({
  name: `film${x}`,
  kind: 'film',
  filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
  sinkTemperature: { value: 20, unit: 'degC' },
  source,
  target: { entityId: '', facesNear: [face] },
});

/** A temperature BC and a film BC whose node sets share nodes (or not). */
function filmOnFixed(sharedFace: boolean): {
  doc: ReturnType<typeof recorded>;
  fixture: ReturnType<typeof thermalFixture>;
  ids: string[];
  mesh: ReturnType<typeof twoTetMesh>;
} {
  const base = thermalFixture();
  const fixed = addBc(base, { ...hot(80, 0), target: { entityId: base.boxId, facesNear: [[0, 0.5, 0.025]] } });
  const filmed = addBc(
    { ...base, doc: fixed.doc },
    { ...film(1, [sharedFace ? 0 : 1, 0.5, 0.025]), target: { entityId: base.boxId, facesNear: [[sharedFace ? 0 : 1, 0.5, 0.025]] } },
  );
  const fixture = { ...base, doc: filmed.doc };
  const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${fixed.id}`]: [1, 3, 4], [`B_${filmed.id}`]: sharedFace ? [1, 3, 4] : [5] } });
  const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: 80, 2: 60, 3: 80, 4: 80, 5: 40 } }]);
  return { doc: recorded(fixture, mesh, results), fixture, ids: [fixed.id, filmed.id], mesh };
}

describe('film + prescribed temperature on the same nodes', () => {
  it('warns THM_BC_CONFLICT (the temperature overrides the film) without failing the check', () => {
    const { doc, ids, fixture } = filmOnFixed(true);
    const result = execute(doc, 'check_thermal', { analysisId: fixture.analysisId }, machineContext());
    const items = (result.data as { items: { code: string; severity: string; ids: string[]; message: string }[] }).items;
    const conflict = items.find((entry) => entry.code === 'THM_BC_CONFLICT');
    expect(conflict?.severity).toBe('warning');
    expect(conflict?.ids).toEqual([ids[1], ids[0]]);
    expect(conflict?.message).toContain('overrides the film');
    expect(conflict?.message).toContain('heat flow is not applied');
  });

  it('is silent when the node sets are disjoint, and leaves the error conflicts of two temperatures alone', () => {
    const { fixture, mesh } = filmOnFixed(false);
    const thermal = caseOf(fixture.doc, fixture.analysisId).thermal;
    if (thermal === undefined) throw new Error('no thermal set-up');
    expect(temperatureOverridesFlows(thermal, mesh)).toEqual([]);
    expect(temperatureBcConflicts(thermal, mesh)).toEqual([]);
  });
});

describe('deck gating on THM_BC_CONFLICT', () => {
  it('writeInp refuses two different temperatures on the same nodes, with the code, ids and remediation', () => {
    const { doc, ids, analysisId } = solvedWith([50, 80], true);
    const mesh = twoTetMesh(
      { doc, boxId: Object.keys(doc.entities)[0] ?? '', analysisId },
      { nodeSets: { [`B_${ids[0]}`]: [1, 3, 4], [`B_${ids[1]}`]: [1, 3, 4] } },
    );
    const deck = writeInp(doc, analysisId, mesh, null);
    expect('code' in deck && deck.code).toBe('THM_BC_CONFLICT');
    expect('message' in deck && deck.message).toContain('delete_thermal_bc');
    expect('ids' in deck && deck.ids).toEqual(ids);
  });

  it('writeInp still builds the deck when the temperatures agree or only a film overlaps', () => {
    for (const make of [() => solvedWith([50, 50], true), () => filmOnFixed(true)]) {
      const built = make();
      const analysisId = 'analysisId' in built ? built.analysisId : built.fixture.analysisId;
      const ids = built.ids;
      const boxId = Object.keys(built.doc.entities)[0] ?? '';
      const mesh = twoTetMesh(
        { doc: built.doc, boxId, analysisId },
        { nodeSets: { [`B_${ids[0]}`]: [1, 3, 4], [`B_${ids[1]}`]: [1, 3, 4] } },
      );
      const deck = writeInp(built.doc, analysisId, mesh, null);
      expect('code' in deck ? deck.code : '').not.toBe('THM_BC_CONFLICT');
    }
  });
});
