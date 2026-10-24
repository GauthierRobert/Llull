/**
 * Plant 02 RTE V1 part 2: pipe supports on spec-driven runs (`add_pipe_support runId`) through the one carrier lookup. Hand calculations: DN80 CS150
 * (OD 88.9, 50 mm insulation) at z 3000: pipe underside 3000 - 44.45 = 2955.55; IPE200 axis at z 2830: top 2930; pedestal 25.55 mm. DN100 (OD 114.3) of
 * SC-RTE-01 at z 2500: underside 2442.85; IPE200 axis 2300: top 2400, pedestal 42.85 mm.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeSupportElement } from '@aec/building/types';
import { buildPlanDrawing } from '@aec/building/drawings/planDrawing';
import { reconcileRunSupports } from '@aec/plant/piping/supportReconcile';
import { pipeWeightPerMetre } from '@aec/industrial/piping/pipeWeight';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document, routedPumpToVessel } from './rteFixtures';

const HOT = { service: 'HO', sequence: '4001', spec: 'CS150', dn: 80, designTempC: 180, insulation: { code: 'H', thickness: 'fromSpec' } };
const beamAt = (x: number, z = 2830): Record<string, unknown> => ({
  role: 'beam',
  start: [x, -1000, z],
  end: [x, 1000, z],
  profile: 'IPE200',
});

/** SC-RTE-07 line (DN80, 180 C, insulation H 50 mm) at z 3000 from x 0 to 6000, routed. */
function hotLine(): { doc: CadDocument; runId: string; lineId: string } {
  const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', HOT);
  const lineId = created.affected[0] as string;
  const doc = apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc, runId: doc.plant?.piping?.runOrder[0] as string, lineId };
}

/** The hot line with IPE200 beams under it at x 500, 3000 and 5500. */
function supportedScene(): { doc: CadDocument; runId: string; lineId: string } {
  const base = hotLine();
  const doc = [500, 3000, 5500].reduce((next, x) => apply(next, 'add_steel_member', beamAt(x)), base.doc);
  return { ...base, doc };
}

const supportsOf = (doc: CadDocument): PipeSupportElement[] =>
  Object.values(doc.building?.elements ?? {}).filter((element): element is PipeSupportElement => element.category === 'pipeSupport');

interface Row {
  id: string;
  line: string;
  supports: number;
  unattached: number;
  basis: string;
  ok: boolean;
  largestSpanM: number;
  issues: string[];
}
const rows = (doc: CadDocument): Row[] => data<{ pipes: Row[] }>(doc, 'check_pipe_supports', {}).pipes;

describe('add_pipe_support on a run', () => {
  const scene = supportedScene();

  it('places a shoe on the run centreline and bears it on the beam below: pedestal 2955.55 - 2930 = 25.55', () => {
    const result = ok(scene.doc, 'add_pipe_support', { runId: scene.runId, at: [[3000, 0, 3000]] });
    const [support] = supportsOf(result.document);
    expect(support).toMatchObject({ pipeId: scene.runId, type: 'shoe', position: [3000, 0, expect.any(Number)] });
    expect(support?.memberId).not.toBeNull();
    expect(support?.pedestalHeight).toBeCloseTo(25.55, 6);
    expect(result.affected[0]).toBe(support?.id);
    expect(result.document.order).toEqual(expect.arrayContaining(support?.entityIds ?? ['missing']));
    expect(support?.entityIds.length).toBeGreaterThan(0);
    expect(result.summary).toContain(scene.runId);
  });

  it('spacing with snapToSteel puts one support on each beam the run crosses (500, 3000, 5500)', () => {
    const result = ok(scene.doc, 'add_pipe_support', { runId: scene.runId, spacing: 3000 });
    const placed = supportsOf(result.document).map((support) => support.position[0]);
    expect(placed.sort((x, y) => x - y)).toEqual([500, 3000, 5500]);
    expect(supportsOf(result.document).every((support) => support.memberId !== null)).toBe(true);
  });

  it('the line number selects the run (and building pipes with that line)', () => {
    const lineNumber = scene.doc.plant?.piping?.lines[scene.lineId]?.lineNumber as string;
    const result = ok(scene.doc, 'add_pipe_support', { line: lineNumber, at: [[3000, 0, 3000]] });
    expect(supportsOf(result.document)[0]?.pipeId).toBe(scene.runId);
  });

  it('is pure', () => {
    expectPure(scene.doc, () => execute(scene.doc, 'add_pipe_support', { runId: scene.runId, at: [[3000, 0, 3000]] }));
  });

  it.each([
    ['an unknown run', { runId: 'run-99', at: [[3000, 0, 3000]] }, "'run-99' is not a pipe run"],
    ['a run id given as pipeId', { pipeId: scene.runId, at: [[3000, 0, 3000]] }, 'is not a pipe element'],
    ['two selectors', { runId: scene.runId, pipeId: 'pipe-1', at: [[3000, 0, 3000]] }, 'exactly one of pipeId, runId or line'],
    ['a point far from the run', { runId: scene.runId, at: [[3000, 5000, 3000]] }, 'no support could be placed'],
  ])('is a no-op for %s', (_label, params, text) => {
    const result = execute(scene.doc, 'add_pipe_support', params);
    expect(result.document).toBe(scene.doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain(text);
  });

  it('refuses a run with no building level to hold the support (add_level first)', () => {
    const bare = hotLine();
    const result = execute(bare.doc, 'add_pipe_support', { runId: bare.runId, at: [[3000, 0, 3000]] });
    expect(result.document).toBe(bare.doc);
    expect(result.summary).toContain('no building level');
  });

  it('refuses a broken run', () => {
    const { doc, runId } = supportedScene();
    const broken: CadDocument = {
      ...doc,
      plant: {
        ...doc.plant,
        piping: {
          ...(doc.plant?.piping as NonNullable<NonNullable<CadDocument['plant']>['piping']>),
          runs: {
            [runId]: { ...(doc.plant?.piping?.runs[runId] as object), broken: { code: 'RTE_STRETCH_FAILED', reason: 'test' } } as never,
          },
        },
      },
    };
    expect(execute(broken, 'add_pipe_support', { runId, at: [[3000, 0, 3000]] }).summary).toContain('is broken');
  });
});

describe('consumers read the run through the carrier', () => {
  const placed = (): { doc: CadDocument; runId: string } => {
    const scene = supportedScene();
    return { doc: apply(scene.doc, 'add_pipe_support', { runId: scene.runId, spacing: 3000 }), runId: scene.runId };
  };

  it('check_pipe_supports: the run has a row on its supports; spans 2500 mm, ends overhang 500 mm, passes (DN80 allows 3.7 m)', () => {
    const { doc, runId } = placed();
    const row = rows(doc).find((candidate) => candidate.id === runId);
    expect(row).toMatchObject({ supports: 3, unattached: 0, basis: 'supports', ok: true });
    expect(row?.largestSpanM).toBe(2.5);
  });

  it('check_pipe_supports: a single support leaves 3 m overhangs (> 0.5 x 3.7 = 1.85): fails, naming the overhang', () => {
    const scene = supportedScene();
    const doc = apply(scene.doc, 'add_pipe_support', { runId: scene.runId, at: [[3000, 0, 3000]] });
    const row = rows(doc).find((candidate) => candidate.id === scene.runId);
    expect(row?.ok).toBe(false);
    expect(row?.issues.join(' ')).toContain('overhang');
  });

  it('a run without supports is reported with basis "none" (no beam under it) and fails: 6 m rest on nothing', () => {
    const { doc, runId } = hotLine();
    const row = rows(apply(doc, 'add_level', { name: 'Ground', elevation: 0, height: 3000 })).find((candidate) => candidate.id === runId);
    expect(row).toMatchObject({ supports: 0, ok: false });
    expect(row?.issues.join(' ')).toContain('no support');
  });

  it('check_steel_members: the supported run weighs on its beams, the water-filled pipe weight over the tributary lengths (2.5 + 2.5 + 3 + ... = 6 m)', () => {
    const { doc, runId } = placed();
    const result = execute(doc, 'check_steel_members', {});
    const lines = (result.data as { loads: { lines: Array<{ id: string; basis: string; supports: number; carriedKn: number }> } }).loads
      .lines;
    const line = lines.find((candidate) => candidate.id === runId);
    expect(line).toMatchObject({ basis: 'supports', supports: 3 });
    // the run is 6 m long (its centreline is the pipe from face to face)
    expect(line?.carriedKn).toBeCloseTo(6 * pipeWeightPerMetre(88.9, 1000), 6);
  });

  it('check_clashes: a run does not clash with its own supports (not with the pipe, not with the insulation envelope)', () => {
    const { doc } = placed();
    const clashes = data<{ clashes: Array<{ a: string; b: string }> }>(doc, 'check_clashes', {}).clashes;
    const supportIds = supportsOf(doc).map((support) => support.id);
    expect(clashes.filter((clash) => supportIds.includes(clash.a) || supportIds.includes(clash.b))).toEqual([]);
  });

  it('support schedule: the row names the run and its line number', () => {
    const { doc, runId } = placed();
    const schedule = data<{ columns: string[]; rows: Array<Array<string | number>> }>(doc, 'building_schedule', { kind: 'support' });
    expect(schedule.rows).toHaveLength(3);
    expect(schedule.rows[0]?.[1]).toBe('80-HO-4001-CS150-H50');
    expect(schedule.rows[0]?.[2]).toBe(runId);
  });

  it('plan drawing: a symbol per support on layer P-SUPP', () => {
    const { doc } = placed();
    const plan = buildPlanDrawing(doc, doc.building?.levelOrder[0]);
    const onLayer = plan?.primitives.filter((primitive) => 'layer' in primitive && String(primitive.layer).includes('SUPP')) ?? [];
    expect(onLayer.length).toBeGreaterThanOrEqual(3);
  });

  it('IFC export: the supports are exported with the run as their pipe', () => {
    const { doc, runId } = placed();
    const ifc = (execute(doc, 'export_ifc', {}).data as { ifc: string }).ifc;
    expect(ifc.match(/PIPESUPPORT/g)).toHaveLength(3);
    expect(ifc).toContain(`IFCLABEL('${runId}')`);
  });

  it('persistence: the supports survive a save and load; a support naming no pipe or run still loads (V1c: check_pipe_supports reports it)', () => {
    const { doc } = placed();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(supportsOf(loaded)).toHaveLength(3);
    expect(loaded.entities).toEqual(doc.entities);
    const text = serializeDocument(doc).replace(/"pipeId":s*"run-[^"]*"/g, '"pipeId": "run-404"');
    expect(supportsOf(deserializeDocument(text))).toHaveLength(3);
  });
});

describe('supports follow their run', () => {
  /** SC-RTE-01 with an IPE200 under leg 2 (+X, y 3000, z 2500) at x 1500 along Y, and a shoe there. */
  function stretchScene(): { doc: CadDocument; runId: string } {
    const { doc, runId } = routedPumpToVessel();
    const beam = apply(doc, 'add_steel_member', { role: 'beam', start: [1500, 2000, 2300], end: [1500, 4000, 2300], profile: 'IPE200' });
    return { doc: apply(beam, 'add_pipe_support', { runId, at: [[1500, 3000, 2500]] }), runId };
  }

  it('moving the vessel +500 Y re-snaps the shoe 500 mm onto the shifted leg (y 3000 -> 3500) and keeps its beam', () => {
    const { doc } = stretchScene();
    const before = supportsOf(doc)[0] as PipeSupportElement;
    expect(before.pedestalHeight).toBeCloseTo(42.85, 6);
    const result = execute(doc, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7000, 3500] } });
    const after = supportsOf(result.document)[0] as PipeSupportElement;
    expect(after.position[0]).toBeCloseTo(1500, 6);
    expect(after.position[1]).toBeCloseTo(3500, 6);
    expect(after.memberId).toBe(before.memberId);
    expect(result.summary).toContain('moved to stay on the run');
    expect(result.summary).toContain(`${before.mark} 500 mm`);
    expect(result.affected).toContain(before.id);
  });

  it('edit_route that lifts the leg out of the beam reach detaches the shoe and says so in the summary (never dropped)', () => {
    const { doc, runId } = stretchScene();
    const result = ok(doc, 'edit_route', { runId, op: 'move_pi', index: 0, delta: [0, 0, 1000] });
    const [support] = supportsOf(result.document);
    expect(support?.memberId).toBeNull();
    expect(support?.position[2]).toBeCloseTo(3500, 6);
    expect(result.summary).toContain('DETACHED');
    expect(supportsOf(result.document)).toHaveLength(1);
  });

  it('delete_pipe_run deletes the supports with the run and names them', () => {
    const { doc, runId } = stretchScene();
    const result = ok(doc, 'delete_pipe_run', { runId });
    expect(supportsOf(result.document)).toHaveLength(0);
    expect((result.data as { deletedSupports: string[] }).deletedSupports).toHaveLength(1);
    expect(result.summary).toContain('pipe support');
    expect(result.document.order.filter((id) => id.startsWith('pipeSupport'))).toEqual([]);
  });

  it('a support whose run vanished by other means is kept in place and named by the reconcile', () => {
    const { doc, runId } = stretchScene();
    const piping = doc.plant?.piping as NonNullable<NonNullable<CadDocument['plant']>['piping']>;
    const { [runId]: gone, ...runs } = piping.runs;
    void gone;
    const orphaned: CadDocument = { ...doc, plant: { ...doc.plant, piping: { ...piping, runs, runOrder: [], entityIds: {} } } };
    const result = reconcileRunSupports(doc, orphaned);
    expect(supportsOf(result.document)).toHaveLength(1);
    expect(result.notes.join(' ')).toContain('no longer exists');
  });
});
