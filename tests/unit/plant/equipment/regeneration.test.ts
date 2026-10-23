import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, RevolutionEntity, Vec3 } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { drumDocument, mmDocument, separatorDocument, separatorParams } from './equipmentFixtures';

interface UpdateData {
  elementId: string;
  changed: string[];
  movedPorts: Array<{ id: string; from: Vec3; to: Vec3; distance: number }>;
  connectedPipes: string[];
  portIds: string[];
  weightKg: number;
  angleConvention: string;
}
interface PortsData {
  ports: Record<string, { position: Vec3 }>;
  order: string[];
}
const portsOf = (doc: CadDocument): PortsData => data<PortsData>(doc, 'equipment_ports', {});
const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement =>
  Object.values(doc.building?.elements ?? {}).find(
    (element): element is EquipmentElement => element.category === 'equipment' && element.mark === tag,
  ) as EquipmentElement;

describe('VC-EQP-19: update_equipment_parameters keeps identity and the flange faces', () => {
  const before = separatorDocument();
  const result = ok(before, 'update_equipment_parameters', { equipment: 'V-101', set: { insideDiameter: 1800 } });
  const after = result.document;

  it('keeps the element id, tag, nozzle marks and port ids; the faces of fitting nozzles do not move', () => {
    const report = result.data as UpdateData;
    expect(report.elementId).toBe(equipmentOf(before, 'V-101').id);
    expect(report.changed).toEqual(['insideDiameter']);
    expect(report.portIds).toEqual(['V-101:N1', 'V-101:N2', 'V-101:N3', 'V-101:M1']);
    expect(portsOf(after).order).toEqual(portsOf(before).order);
    expect(report.movedPorts).toEqual([]);
    expect(portsOf(after).ports['V-101:N1']?.position).toEqual([5000, 6000, 5200]);
    expect(portsOf(after).ports['V-101:N3']?.position).toEqual([5000, 5000, 6700]);
    expect(equipmentOf(after, 'V-101').id).toBe(equipmentOf(before, 'V-101').id);
    expect(report.angleConvention).toBe('north_cw');
  });

  it('regenerates the geometry and re-derives the legacy fields; the new inside volume is 11.7056 m3', () => {
    const body = after.entities[`${equipmentOf(after, 'V-101').id}:body`] as RevolutionEntity;
    expect(Math.max(...body.profile.map((point) => point[0]))).toBeCloseTo(910, 6);
    expect(equipmentOf(after, 'V-101').size[0]).toBeCloseTo(1840, 6);
    const volume = data<{ totalVolumeM3: number }>(after, 'vessel_volume', { equipment: 'V-101' }).totalVolumeM3;
    expect(Math.abs(volume / 11.70557422727557 - 1)).toBeLessThan(1e-9);
    expect(equipmentOf(after, 'V-101').weight).toBeGreaterThan(equipmentOf(before, 'V-101').weight);
  });

  it('is pure', () => {
    const snapshot = JSON.stringify(before);
    execute(before, 'update_equipment_parameters', { equipment: 'V-101', set: { insideDiameter: 1800 } });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('update_equipment_parameters: moved ports and connected pipes', () => {
  it('a new location moves every port by the same vector and lists the pipes attached to them', () => {
    const piped = apply(separatorDocument(), 'add_pipe_run', {
      points: [
        [5000, 6000, 5200],
        [5000, 7000, 5200],
      ],
      from: 'V-101:N1',
      to: 'BL-1',
    });
    const moved = ok(piped, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [5500, 5000], name: 'Separator A' } });
    const report = moved.data as UpdateData;
    expect(report.changed).toEqual(['name', 'location']);
    expect(report.movedPorts).toHaveLength(4);
    expect(report.movedPorts[0]?.to).toEqual([5500, 6000, 5200]);
    expect(report.movedPorts[0]?.distance).toBeCloseTo(500, 9);
    expect(report.connectedPipes).toHaveLength(1);
    expect(equipmentOf(moved.document, 'V-101').name).toBe('Separator A');
  });

  it('a taller skirt lifts the shell nozzles; a plan rotation turns them (read with the angle convention)', () => {
    const lifted = ok(separatorDocument(), 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { support: { type: 'skirt', height: 2500, thickness: 10 } },
    });
    expect((lifted.data as UpdateData).movedPorts).toHaveLength(4);
    expect(portsOf(lifted.document).ports['V-101:N1']?.position).toEqual([5000, 6000, 5700]);
    const turned = ok(separatorDocument(), 'update_equipment_parameters', { equipment: 'V-101', set: { planRotationDeg: 90 } });
    expect((turned.data as UpdateData).changed).toEqual(['planRotationDeg']);
    expect(portsOf(turned.document).ports['V-101:N1']?.position).toEqual([6000, 5000, 5200]);
    const counter = ok(separatorDocument(), 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { planRotationDeg: 90 },
      angleConvention: 'east_ccw',
    });
    expect(portsOf(counter.document).ports['V-101:N1']?.position).toEqual([4000, 5000, 5200]);
  });

  it('design data is merged field by field; heads are replaced by name; thickness and clearance change', () => {
    const doc = separatorDocument();
    const result = ok(doc, 'update_equipment_parameters', {
      equipment: 'V-101',
      set: {
        design: { temperatureC: 200 },
        heads: { top: { type: 'torispherical', standard: 'asme_fd' } },
        shellThickness: 12,
        headThickness: 12,
        corrosionAllowance: 2,
        tangentLength: 4200,
        clearance: 900,
      },
    });
    const plant = equipmentOf(result.document, 'V-101').plant;
    expect(plant?.design?.temperatureC).toBe(200);
    expect(plant?.design?.pressure).toEqual({ value: 1, unit: 'MPa' });
    expect(plant?.template.kind === 'vessel' && plant.template.heads.second.type).toBe('torispherical');
    expect(plant?.template.kind === 'vessel' && plant.template.heads.first.type).toBe('ellipsoidal');
    expect((result.data as UpdateData).changed).toEqual(
      expect.arrayContaining(['clearance', 'tangentLength', 'shellThickness', 'headThickness', 'corrosionAllowance', 'heads', 'design']),
    );
    expect(equipmentOf(result.document, 'V-101').clearance).toBe(900);
  });

  it('works for a horizontal drum and re-derives its weight', () => {
    const doc = drumDocument();
    const thinner = ok(doc, 'update_equipment_parameters', { equipment: 'D-201', set: { shellThickness: 12 } });
    expect(equipmentOf(thinner.document, 'D-201').weight).toBeLessThan(equipmentOf(doc, 'D-201').weight);
    expect((thinner.data as UpdateData).changed).toEqual(['shellThickness']);
  });
});

describe('update_equipment_parameters: refusals leave the document unchanged', () => {
  const doc = separatorDocument();
  it.each([
    ['unknown equipment', { equipment: 'V-999', set: { name: 'x' } }, 'EQP_NOT_FOUND', 'equipment'],
    ['thickness not above the allowance', { equipment: 'V-101', set: { shellThickness: 3 } }, 'EQP_PARAM_INVALID', 'set.shellThickness'],
    [
      'invalid head',
      { equipment: 'V-101', set: { heads: { top: { type: 'torispherical' } } } },
      'EQP_HEAD_INVALID',
      'set.heads.top.standard',
    ],
    [
      'saddles on a vertical vessel',
      { equipment: 'V-101', set: { support: { type: 'saddles', stations: [100], width: 10, axisElevation: 3000 } } },
      'EQP_SUPPORT_INVALID',
      'set.support.type',
    ],
    [
      'a nozzle off the shorter shell',
      { equipment: 'V-101', set: { tangentLength: 3000 } },
      'EQP_NOZZLE_OFF_BODY',
      'nozzles.N1.location.elevation',
    ],
    [
      'a head that swallows a nozzle face',
      { equipment: 'V-101', set: { heads: { top: { type: 'hemispherical' } } } },
      'EQP_NOZZLE_PROJECTION_TOO_SHORT',
      'nozzles.N3.projection',
    ],
  ])('%s', (_name, params, code, path) => {
    expectRefusal(doc, 'update_equipment_parameters', params, code, path);
  });

  it('a legacy block is not parametric', () => {
    const block = apply(mmDocument(), 'add_equipment', { name: 'Skid', location: [0, 0], size: [1000, 1000, 1000], mark: 'P-1' });
    expectRefusal(block, 'update_equipment_parameters', { equipment: 'P-1', set: { name: 'x' } }, 'EQP_NOT_PARAMETRIC', 'equipment');
  });

  it('a revision that changes nothing is a no-op, not a refusal', () => {
    const result = execute(doc, 'update_equipment_parameters', { equipment: 'V-101', set: { insideDiameter: 1500 } });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/nothing changed/);
  });

  it('a shorter drum keeps its saddle stations valid', () => {
    expectRefusal(
      drumDocument(),
      'update_equipment_parameters',
      { equipment: 'D-201', set: { tangentLength: 4000 } },
      'EQP_SUPPORT_INVALID',
      'set.support.stations.1',
    );
  });
});

describe('recorded history', () => {
  it('records one step per command, so replaying them regenerates the same equipment', () => {
    const built = ok(separatorDocument(), 'update_equipment_parameters', { equipment: 'V-101', set: { insideDiameter: 1800 } }).document;
    expect(built.featureHistory.map((step) => step.name)).toEqual([
      'set_units',
      'add_vessel',
      'add_nozzle',
      'add_nozzle',
      'add_nozzle',
      'add_nozzle',
      'update_equipment_parameters',
    ]);
    const replayed = apply(mmDocument(), 'add_vessel', separatorParams);
    expect(Object.keys(replayed.entities)).toEqual([
      `${equipmentOf(replayed, 'V-101').id}:body`,
      `${equipmentOf(replayed, 'V-101').id}:skirt`,
    ]);
  });
});
