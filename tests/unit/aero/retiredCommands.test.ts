import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type NurbsCurveEntity, type PolylineEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { migrateRetiredCalls } from '@core/commands/persistence/retiredCommands';
import { expectRefusal, ok } from '../../helpers/commandAssertions';

const call = (command: string, params: Record<string, unknown>): { command: string; params: unknown } =>
  migrateRetiredCalls({ command, params }) as { command: string; params: unknown };

describe('retired aero commands', () => {
  it.each([
    ['cfd_create_case', 'create_cfd_case'],
    ['cfd_update_case', 'update_cfd_case'],
    ['cfd_delete_case', 'delete_cfd_case'],
    ['cfd_set_boundary', 'set_cfd_boundary'],
    ['cfd_prepare', 'prepare_cfd_case'],
    ['aero_drag', 'compute_aero_drag'],
    ['export_flat_patterns_dxf', 'export_ply_flat_patterns_dxf'],
  ])('%s is rewritten to %s with unchanged params', (oldName, newName) => {
    expect(call(oldName, { caseId: 'a', part: 'p' })).toEqual({ command: newName, params: { caseId: 'a', part: 'p' } });
  });

  it('the renamed commands are registered and the old names are not', () => {
    for (const name of [
      'create_cfd_case',
      'update_cfd_case',
      'delete_cfd_case',
      'set_cfd_boundary',
      'prepare_cfd_case',
      'compute_aero_drag',
    ])
      expect(execute(createEmptyDocument(), name, {}).summary, name).not.toMatch(/unknown command/i);
    expect(execute(createEmptyDocument(), 'cfd_prepare', {}).summary).toMatch(/unknown/i);
  });

  it('draw_naca_airfoil params map onto airfoil_from_naca as a polyline', () => {
    expect(call('draw_naca_airfoil', { naca: '2412', chord: 1000 })).toEqual({
      command: 'airfoil_from_naca',
      params: { designation: '2412', chord: 1000, points: 121, trailingEdge: 'closed', as: 'polyline' },
    });
    expect(
      call('draw_naca_airfoil', {
        naca: '0012',
        chord: 5,
        pointsPerSide: 80,
        closedTrailingEdge: false,
        incidenceDeg: 3,
        position: [1, 0, 0],
      }),
    ).toEqual({
      command: 'airfoil_from_naca',
      params: { designation: '0012', chord: 5, points: 161, trailingEdge: 'open', as: 'polyline', incidenceDeg: 3, position: [1, 0, 0] },
    });
  });

  it('a saved draw_naca_airfoil step loads and replays to the polyline airfoil_from_naca draws', () => {
    const direct = ok(createEmptyDocument(), 'airfoil_from_naca', {
      designation: '2412',
      chord: 100,
      incidenceDeg: 5,
      points: 121,
      trailingEdge: 'closed',
      as: 'polyline',
    }).document;
    const legacyStep = { ...direct.featureHistory[0]!, name: 'draw_naca_airfoil', params: { naca: '2412', chord: 100, incidenceDeg: 5 } };
    const loaded = deserializeDocument(serializeDocument({ ...direct, featureHistory: [legacyStep] }));
    expect(loaded.featureHistory[0]).toMatchObject({ name: 'airfoil_from_naca', params: { designation: '2412', as: 'polyline' } });
    const replayed = execute(loaded, 'replay_history', {}).document;
    expect(Object.keys(replayed.entities)).toEqual(Object.keys(direct.entities));
    expect(replayed.entities).toEqual(direct.entities);
  });
});

describe('airfoil_from_naca chord, incidence and as', () => {
  const empty = createEmptyDocument();

  it('scales and rotates the NURBS section and keeps the airfoil id', () => {
    const result = ok(empty, 'airfoil_from_naca', { designation: '0012', chord: 10, incidenceDeg: 90 });
    const [airfoilId, curveId] = result.affected as [string, string];
    expect(result.document.aero?.airfoils[airfoilId]?.entityId).toBe(curveId);
    const points = (result.document.entities[curveId] as NurbsCurveEntity).curve.poles;
    const xs = points.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(2);
  });

  it('as polyline makes one closed polyline and no airfoil id', () => {
    const result = ok(empty, 'airfoil_from_naca', { designation: '2412', chord: 2, as: 'polyline', points: 41 });
    expect(result.affected).toHaveLength(1);
    const entity = result.document.entities[result.affected[0]!] as PolylineEntity;
    expect(entity.kind).toBe('polyline');
    expect(entity.closed).toBe(true);
    expect(result.document.aero?.airfoils ?? {}).toEqual({});
    expect(result.document.order).toContain(result.affected[0]);
  });

  it('refuses a non-positive chord and leaves the document unchanged', () => {
    expectRefusal(empty, 'airfoil_from_naca', { designation: '0012', chord: 0 }, 'AERO_PARAM_INVALID');
    expectRefusal(empty, 'airfoil_from_naca', { designation: '0012', chord: -1, as: 'polyline' }, 'AERO_PARAM_INVALID');
  });
});
