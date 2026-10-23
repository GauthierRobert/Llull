/** `PortSource` (02 RTE §2): tie-ins, equipment nozzles and run ends resolve to one `PortSpec`. */

import { describe, expect, it } from 'vitest';
import { portIdOf, portOccupant, portOfRef, resolvePortId } from '@aec/plant/piping/ports';
import type { PortRef } from '@aec/plant/types';
import { apply } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, pumpToVessel } from './rteFixtures';

const near = (actual: readonly number[], expected: readonly number[]): void =>
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6));

describe('resolvePortId', () => {
  it('resolves an equipment nozzle "<tag>:<mark>" through equipmentPorts: face position, direction, DN, CL150 RF, end type FL', () => {
    const doc = pumpToVessel();
    const pump = resolvePortId(doc, 'P-101:N2');
    expect(pump.ok).toBe(true);
    if (!pump.ok) return;
    near(pump.port.spec.position, [0, 0, 1000]);
    near(pump.port.spec.direction, [0, 0, 1]);
    expect(pump.port.spec).toMatchObject({ dn: 100, endType: 'FL', rating: 'CL150', facing: 'RF' });
    expect(pump.port.ref).toMatchObject({ kind: 'nozzle', nozzleId: 'N2' });
    const vessel = resolvePortId(doc, 'V-101:N1');
    if (!vessel.ok) throw new Error(vessel.message);
    near(vessel.port.spec.position, [6000, 3000, 4000]);
    near(vessel.port.spec.direction, [-1, 0, 0]);
    expect(portIdOf(doc, vessel.port.ref)).toBe('V-101:N1');
    expect(portOfRef(doc, vessel.port.ref)).toEqual(vessel.port.spec);
  });

  it('resolves a tie-in by id and gives the PortSpec stored by add_tie_in_point', () => {
    const { doc: withLine } = cs150Line();
    const { doc, id } = addTie(withLine, 'TP-1', [10, 20, 30], [0, 2, 0], { endType: 'FL', rating: 'CL150', facing: 'RF' });
    const found = resolvePortId(doc, id);
    if (!found.ok) throw new Error(found.message);
    expect(found.port.spec).toEqual({
      position: [10, 20, 30],
      direction: [0, 1, 0],
      dn: 100,
      endType: 'FL',
      rating: 'CL150',
      facing: 'RF',
    });
    expect(found.port.ref).toEqual({ kind: 'tieIn', id });
    expect(portIdOf(doc, found.port.ref)).toBe(id);
  });

  it('resolves the open end of a run as a butt-weld port that continues the pipe (and its start backwards)', () => {
    const { doc: withLine, lineId } = cs150Line();
    const { doc, id } = addTie(withLine, 'TP-1', [0, 0, 0], [1, 0, 0]);
    const routed = apply(doc, 'route_pipe', { lineId, from: { portId: id }, legs: [{ direction: '+X', length: 2000 }] });
    const runId = routed.plant?.piping?.runOrder[0] as string;
    const end = resolvePortId(routed, `${runId}:end`);
    if (!end.ok) throw new Error(end.message);
    expect(end.port.spec).toEqual({ position: [2000, 0, 0], direction: [1, 0, 0], dn: 100, endType: 'BW' });
    const start = resolvePortId(routed, `${runId}:start`);
    if (!start.ok) throw new Error(start.message);
    expect(start.port.spec.direction).toEqual([-1, 0, 0]);
    expect(portIdOf(routed, end.port.ref)).toBe(`${runId}:end`);
    expect(portOfRef(routed, { kind: 'runEnd', runId: 'run-nope', end: 'end' })).toBeNull();
    expect(portOfRef(routed, { kind: 'tieIn', id: 'tie-nope' })).toBeNull();
    expect(portOfRef(routed, { kind: 'nozzle', equipmentId: 'nope', nozzleId: 'N1' })).toBeNull();
  });

  it('names what exists when the id is unknown, and the nozzles of a known equipment when the mark is', () => {
    const doc = pumpToVessel();
    const unknown = resolvePortId(doc, 'nope');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain('add_tie_in_point');
    const noMark = resolvePortId(doc, 'P-101:N9');
    expect(noMark.ok).toBe(false);
    if (!noMark.ok) expect(noMark.message).toContain('P-101:N2');
    expect(resolvePortId(doc, 'run-1:end').ok).toBe(false);
  });
});

describe('portOccupant', () => {
  it('is undefined for a free port and the run id (or the connected port, for a run end) once used', () => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'TP-1', [0, 0, 0], [1, 0, 0]);
    const ref: PortRef = { kind: 'tieIn', id: a.id };
    expect(portOccupant(a.doc, ref)).toBeUndefined();
    const routed = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] });
    const runId = routed.plant?.piping?.runOrder[0] as string;
    expect(portOccupant(routed, ref)).toBe(runId);
    // The far end is open and free; the start end is connected to the tie-in.
    expect(portOccupant(routed, { kind: 'runEnd', runId, end: 'end' })).toBeUndefined();
    expect(portOccupant(routed, { kind: 'runEnd', runId, end: 'start' })).toBe(a.id);
    expect(portOccupant(routed, { kind: 'runEnd', runId: 'run-nope', end: 'end' })).toBeUndefined();
  });

  it('sees a nozzle used by a run', () => {
    const doc = pumpToVessel();
    const line = apply(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'CS150', dn: 100 });
    const lineId = line.plant?.piping?.lineOrder[0] as string;
    const routed = apply(line, 'route_pipe', {
      lineId,
      from: { portId: 'P-101:N2' },
      legs: [
        { direction: '+Z', length: 1500 },
        { direction: '+X', length: 1000 },
      ],
    });
    const nozzle = resolvePortId(routed, 'P-101:N2');
    if (!nozzle.ok) throw new Error(nozzle.message);
    expect(portOccupant(routed, nozzle.port.ref)).toBe(routed.plant?.piping?.runOrder[0]);
  });
});
