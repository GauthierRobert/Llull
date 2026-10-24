/**
 * Plant 02 RTE V1: valve operators (handwheel / gear / actuator envelopes from the catalogue row, orientation by the stem), RTE_VALVE_OPERATOR_CLASH, and the
 * clash bodies of valves, flanges, tees, olets and reducers. Hand calculations from the operator stub (NPS 4 Class 150): gate handwheel 400 mm x 30 at
 * 650 above the axis; globe actuator 250 x 500 topping at 900 + wheel 200 x 20; ball gear box 200 x 250 topping at 520 + wheel 300 x 25.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { pipingClashBodies } from '@aec/plant/piping/clashBodies';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, headerScene, valveScene } from './rteFixtures';
import { operatorsDocument } from './smallBoreFixtures';

interface Operator {
  kind: string;
  bodies: Array<{ id: string; kind: string; from: number[]; axis: number[]; lengthMm: number; radiusMm: number }>;
}
interface Inserted {
  componentId: string;
  runId: string;
  handwheelCentre: { point: number[]; stemHeightMm: number } | null;
  operator: Operator | null;
}

/** A DN100 run on CS150OP between two butt-weld tie-ins, x 0 -> 6000 at z 0. */
function straightRun(): { doc: CadDocument; runId: string; lineId: string } {
  let doc = operatorsDocument();
  doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '7001', spec: 'CS150OP', dn: 100 });
  const lineId = doc.plant?.piping?.lineOrder[0] as string;
  doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [1, 0, 0], dn: 100, endType: 'BW' });
  doc = apply(doc, 'add_tie_in_point', { tag: 'B', position: [6000, 0, 0], direction: [-1, 0, 0], dn: 100, endType: 'BW' });
  const [a, b] = doc.plant?.piping?.tieInOrder as [string, string];
  const routed = ok(doc, 'route_pipe', { lineId, from: { portId: a }, to: { portId: b } });
  return { doc: routed.document, runId: (routed.data as { runId: string }).runId, lineId };
}

const insert = (doc: CadDocument, runId: string, type: string, extra: Record<string, unknown> = {}): ReturnType<typeof ok> =>
  ok(doc, 'insert_inline_component', { runId, type, at: { leg: 0, centreDistance: 3000 }, ...extra });

describe('operator envelopes from the catalogue row', () => {
  const s = straightRun();

  it('gate valve: a 400 x 30 handwheel disc centred 650 above the axis along the stem (default up)', () => {
    const result = insert(s.doc, s.runId, 'valveGate').data as Inserted;
    expect(result.operator?.kind).toBe('handwheel');
    expect(result.operator?.bodies).toHaveLength(1);
    const wheel = result.operator?.bodies[0];
    expect(wheel).toMatchObject({ kind: 'handwheel', axis: [0, 0, 1], lengthMm: 30, radiusMm: 200 });
    expect(wheel?.from).toEqual([3000, 0, 635]);
    expect(wheel?.id).toMatch(/\/valve-1\/wheel$/);
    expect(result.handwheelCentre?.point).toEqual([3000, 0, 650]);
  });

  it('globe valve with an actuator: cylinder 250 x 500 from 400 to 900, override wheel 200 x 20 at 890 - 910', () => {
    const result = insert(s.doc, s.runId, 'valveGlobe').data as Inserted;
    expect(result.operator?.kind).toBe('actuator');
    expect(result.operator?.bodies.map((body) => [body.kind, body.from[2], body.lengthMm, body.radiusMm])).toEqual([
      ['actuator', 400, 500, 125],
      ['handwheel', 890, 20, 100],
    ]);
  });

  it('ball valve with a gear operator: box 200 x 250 from 270 to 520, wheel 300 x 25 centred at 520', () => {
    const result = insert(s.doc, s.runId, 'valveBall').data as Inserted;
    expect(result.operator?.kind).toBe('gear');
    expect(result.operator?.bodies.map((body) => [body.kind, body.from[2], body.lengthMm, body.radiusMm])).toEqual([
      ['gear', 270, 250, 100],
      ['handwheel', 507.5, 25, 150],
    ]);
  });

  it('orientation follows the stem direction: stem +X puts the wheel at x 3650 with its axis along X', () => {
    const result = insert(s.doc, s.runId, 'valveGate', { stemDirection: [1, 0, 0] }).data as Inserted;
    const wheel = result.operator?.bodies[0];
    expect(wheel?.axis).toEqual([1, 0, 0]);
    expect(wheel?.from).toEqual([3635, 0, 0]);
  });

  it('a valve row without operator dimensions has no envelope (the bundled CS150 gate valve: nothing guessed)', () => {
    const plain = valveScene();
    const result = data<Inserted>(plain.doc, 'move_inline_component', { runId: plain.runId, componentId: plain.valveId, delta: 10 });
    expect(result.operator).toBeNull();
    expect(pipingClashBodies(plain.doc).some((body) => body.accessoryOf !== undefined)).toBe(false);
  });

  it('display: the wheel is drawn from the catalogue diameter (radius 200, id <valve>/wheel); gear and actuator get their own entities', () => {
    const gate = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGate', at: { leg: 0, centreDistance: 3000 } });
    const wheel = gate.entities[`${s.runId}/valve-1/wheel`] as unknown as { profile: Array<[number, number]> };
    expect(Math.max(...wheel.profile.map((point) => point[0]))).toBe(200);
    const globe = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGlobe', at: { leg: 0, centreDistance: 3000 } });
    expect(
      Object.keys(globe.entities)
        .filter((id) => id.startsWith(`${s.runId}/valve-1/`))
        .sort(),
    ).toEqual([`${s.runId}/valve-1/actuator`, `${s.runId}/valve-1/stem`, `${s.runId}/valve-1/wheel`]);
  });
});

describe('RTE_VALVE_OPERATOR_CLASH', () => {
  const s = straightRun();
  // a gate valve at x 3000 (stem up): wheel z 635 - 665, r 200 around x 3000
  const withValve = insert(s.doc, s.runId, 'valveGate');
  const valveId = (withValve.data as Inserted).componentId;
  const beam = (z: number): Record<string, unknown> => ({ role: 'beam', start: [3000, -1000, z], end: [3000, 1000, z], profile: 'IPE200' });

  it('a beam across the handwheel (axis z 700, bottom 600): one clash, depth 65 = 15 + 100 - |650 - 700|, ids = [valve, member]', () => {
    const doc = apply(withValve.document, 'add_steel_member', beam(700));
    const check = data<{ status: string; issues: Array<{ code: string; ids: string[]; detail: Record<string, number | string> }> }>(
      doc,
      'check_piping',
      {},
    );
    const clashes = check.issues.filter((issue) => issue.code === 'RTE_VALVE_OPERATOR_CLASH');
    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.ids[0]).toBe(valveId);
    expect(clashes[0]?.detail['depthMm']).toBeCloseTo(65, 6);
    expect(clashes[0]?.detail).toMatchObject({ kind: 'hard', operatorKind: 'handwheel', toleranceMm: 5 });
    expect(check.status).toBe('warn');
  });

  it('check_clashes finds the same hit with the operator body id (hard clash <valve part>/wheel x the member)', () => {
    const doc = apply(withValve.document, 'add_steel_member', beam(700));
    const clashes = data<{ clashes: Array<{ a: string; b: string; kind: string; depth: number }> }>(doc, 'check_clashes', {}).clashes;
    const hit = clashes.find((clash) => clash.a.endsWith('/valve-1/wheel') || clash.b.endsWith('/valve-1/wheel'));
    expect(hit?.kind).toBe('hard');
    expect(hit?.depth).toBeCloseTo(65, 6);
  });

  it('turning the stem to +X clears it (the disc leaves the beam), and a beam above the wheel (axis z 800) does not clash', () => {
    const turned = ok(s.doc, 'insert_inline_component', {
      runId: s.runId,
      type: 'valveGate',
      at: { leg: 0, centreDistance: 3000 },
      stemDirection: [1, 0, 0],
    });
    const doc = apply(turned.document, 'add_steel_member', beam(700));
    expect(
      data<{ issues: Array<{ code: string }> }>(doc, 'check_piping', {}).issues.some((issue) => issue.code === 'RTE_VALVE_OPERATOR_CLASH'),
    ).toBe(false);
    const high = apply(withValve.document, 'add_steel_member', beam(800));
    expect(
      data<{ issues: Array<{ code: string }> }>(high, 'check_piping', {}).issues.some((issue) => issue.code === 'RTE_VALVE_OPERATOR_CLASH'),
    ).toBe(false);
  });

  it('clashToleranceMm: a penetration of 65 is ignored when the tolerance is 70', () => {
    const doc = apply(withValve.document, 'add_steel_member', beam(700));
    const check = data<{ issues: Array<{ code: string }>; limits: { operatorClash: { toleranceMm: number; source: string } } }>(
      doc,
      'check_piping',
      { clashToleranceMm: 70 },
    );
    expect(check.issues.some((issue) => issue.code === 'RTE_VALVE_OPERATOR_CLASH')).toBe(false);
    expect(check.limits.operatorClash).toEqual({ toleranceMm: 70, source: 'check_piping clashToleranceMm' });
  });

  it('the operator of a valve on another line is an obstacle for this one only when it is checked: lineIds of the other line report nothing', () => {
    const doc = apply(withValve.document, 'add_steel_member', beam(700));
    let other = apply(doc, 'create_pipeline', { service: 'P', sequence: '7003', spec: 'CS150OP', dn: 100 });
    other = apply(other, 'add_tie_in_point', { tag: 'D', position: [0, 3000, 0], direction: [1, 0, 0], dn: 100, endType: 'BW' });
    const lineId = other.plant?.piping?.lineOrder.at(-1) as string;
    const routed = apply(other, 'route_pipe', {
      lineId,
      from: { portId: other.plant?.piping?.tieInOrder.at(-1) },
      legs: [{ direction: '+X', length: 3000 }],
    });
    const check = data<{ issues: Array<{ code: string }> }>(routed, 'check_piping', { lineIds: [lineId] });
    expect(check.issues.some((issue) => issue.code === 'RTE_VALVE_OPERATOR_CLASH')).toBe(false);
  });

  it('is a query: the document is returned unchanged, and an unknown line is still refused', () => {
    const doc = apply(withValve.document, 'add_steel_member', beam(700));
    expect(ok(doc, 'check_piping', {}).document).toBe(doc);
    expectRefusal(doc, 'check_piping', { lineIds: ['nope'] }, 'RTE_UNKNOWN_LINE');
  });
});

describe('clash bodies of valves, flanges, tees, olets and reducers', () => {
  it('a beam clipping a flange plate (OD 228.6, top 114.3) but not the pipe (top 57.15) hits the flange part: depth 14.3', () => {
    const s = straightRun();
    const withValve = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGlobe', at: { leg: 0, centreDistance: 3000 } });
    // the globe valve is 292 long: faces at x 2854 / 3146; flange sets reach 79 further; the upstream flange plate spans x 2849.6 - 2872 (gasket 3 first)
    const beam = apply(withValve, 'add_steel_member', {
      role: 'beam',
      start: [2860, -1000, 200],
      end: [2860, 1000, 200],
      profile: 'IPE200',
    });
    const clashes = data<{ clashes: Array<{ a: string; b: string; kind: string; depth: number }> }>(beam, 'check_clashes', {}).clashes;
    const hit = clashes.find((clash) => /\/flange-\d+$/.test(clash.a) || /\/flange-\d+$/.test(clash.b));
    expect(hit?.kind).toBe('hard');
    expect(hit?.depth).toBeCloseTo(14.3, 6);
    expect(clashes.some((clash) => /\/pipe-\d+$/.test(clash.a) || /\/pipe-\d+$/.test(clash.b))).toBe(false);
  });

  it('tees, olets and reducers have bodies: header + stub, base to outlet, both ends', () => {
    const header = headerScene();
    const branch = ok(header.doc, 'add_branch', {
      runId: header.headerId,
      at: { point: [4000, 0, 3000] },
      dn: 100,
      to: { portId: header.tieC },
    });
    const withOlet = ok(branch.document, 'add_branch', {
      runId: header.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const ids = pipingClashBodies(withOlet.document).map((body) => body.id);
    expect(ids.filter((id) => id.endsWith('/tee-1'))).toHaveLength(2);
    expect(ids.some((id) => id.endsWith('/olet-1'))).toBe(true);
    const line = cs150Line(150, '8001');
    const tie = addTie(line.doc, 'R', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const reduced = ok(tie.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: tie.id },
      legs: [{ direction: '+X', length: 6000 }],
      inline: [{ type: 'reducerConcentric', dn2: 100, at: { leg: 0, centreDistance: 3000 } }],
    });
    expect(pipingClashBodies(reduced.document).some((body) => body.id.includes('/reducer-'))).toBe(true);
  });

  it('no bodies in a non-mm document or without runs', () => {
    expect(pipingClashBodies(operatorsDocument())).toEqual([]);
  });
});
