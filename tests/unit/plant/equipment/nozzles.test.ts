import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { applyEulerXYZ } from '@lib/eulerRotation';
import type { CadDocument, RevolutionEntity, Vec3 } from '@core/model/types';
import type { BuildingModel, EquipmentElement } from '@aec/building/types';
import { equipmentPorts } from '@aec/plant/equipment/geometry/ports';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { drumDocument, drumNozzles, mmDocument, separatorDocument, separatorNozzles, separatorParams } from './equipmentFixtures';

interface Port {
  id: string;
  position: Vec3;
  direction: Vec3;
  orientationDeg?: number | null;
  flange?: { placeholder: boolean; outsideDiameter: number; thickness: number; catalogRef?: string };
}
interface PortsData {
  ports: Record<string, Port>;
  order: string[];
  count: number;
  truncated: boolean;
  angleConvention: string;
}
interface NozzleData {
  portId: string;
  position: Vec3;
  direction: Vec3;
  angleConvention: string;
  orientationDeg: number | null;
  warnings: Array<{ code: string; path: string }>;
  flange: { placeholder: boolean; outsideDiameter: number; thickness: number; catalogRef?: string };
  defaulted: string[];
}

const ports = (doc: CadDocument, equipment?: string): PortsData =>
  data<PortsData>(doc, 'equipment_ports', equipment === undefined ? {} : { equipment });
const near = (actual: readonly number[], expected: readonly number[], digits = 6): void =>
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
const buildingOf = (doc: CadDocument): BuildingModel => doc.building as BuildingModel;
const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement =>
  Object.values(buildingOf(doc).elements).find(
    (element): element is EquipmentElement => element.category === 'equipment' && element.mark === tag,
  ) as EquipmentElement;

describe('VC-EQP-12: nozzle ports of the validation scenarios', () => {
  it('SC-EQP-01 vertical separator V-101 (angle 0 = north, projection from the axis / the tangent line)', () => {
    const result = ports(separatorDocument(), 'V-101');
    expect(result.order).toEqual(['V-101:N1', 'V-101:N2', 'V-101:N3', 'V-101:M1']);
    near(result.ports['V-101:N1']?.position ?? [], [5000, 6000, 5200]);
    near(result.ports['V-101:N1']?.direction ?? [], [0, 1, 0], 9);
    near(result.ports['V-101:N2']?.position ?? [], [5000, 5000, 1400]);
    near(result.ports['V-101:N2']?.direction ?? [], [0, 0, -1], 9);
    near(result.ports['V-101:N3']?.position ?? [], [5000, 5000, 6700]);
    near(result.ports['V-101:N3']?.direction ?? [], [0, 0, 1], 9);
    near(result.ports['V-101:M1']?.position ?? [], [5000, 4000, 3000]);
    near(result.ports['V-101:M1']?.direction ?? [], [0, -1, 0], 9);
  });

  it('SC-EQP-02 horizontal drum D-201 (0 = top, station from the left tangent line)', () => {
    const result = ports(drumDocument(), 'D-201');
    near(result.ports['D-201:N1']?.position ?? [], [-2400, 0, 2900]);
    near(result.ports['D-201:N2']?.position ?? [], [2400, 0, 200]);
    near(result.ports['D-201:N2']?.direction ?? [], [0, 0, -1], 9);
    near(result.ports['D-201:N3']?.position ?? [], [0, 0, 2600]);
    near(result.ports['D-201:N4']?.position ?? [], [4000, 0, 1500]);
    near(result.ports['D-201:N4']?.direction ?? [], [1, 0, 0], 9);
  });

  it('a shell nozzle at 90 degrees points to the +Y side of a horizontal vessel, and east (+X) on a vertical one', () => {
    const drum = apply(drumDocument(false), 'add_nozzle', {
      ...drumNozzles[0],
      equipment: 'D-201',
      mark: 'S1',
      location: { on: 'shell', station: 3000, orientationDeg: 90 },
    });
    near(ports(drum).ports['D-201:S1']?.direction ?? [], [0, 1, 0], 9);
    const sep = apply(separatorDocument(false), 'add_nozzle', {
      ...separatorNozzles[0],
      equipment: 'V-101',
      mark: 'S1',
      location: { on: 'shell', elevation: 3000, orientationDeg: 90 },
    });
    near(ports(sep).ports['V-101:S1']?.direction ?? [], [1, 0, 0], 9);
    near(ports(sep).ports['V-101:S1']?.position ?? [], [6000, 5000, 5000]);
  });

  it('the plan rotation turns the whole equipment frame: north nozzle of a vessel rotated 90 degrees clockwise points east', () => {
    const rotated = apply(mmDocument(), 'add_vessel', { ...separatorParams, planRotationDeg: 90 });
    const withNozzle = apply(rotated, 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[0] });
    near(ports(withNozzle).ports['V-101:N1']?.direction ?? [], [1, 0, 0], 9);
    near(ports(withNozzle).ports['V-101:N1']?.position ?? [], [6000, 5000, 5200]);
  });

  it('angleConvention east_ccw reads and reports the other convention; the stored nozzle is the same', () => {
    const north = separatorDocument();
    const added = data<NozzleData>(separatorDocument(false), 'add_nozzle', {
      equipment: 'V-101',
      ...separatorNozzles[0],
      angleConvention: 'east_ccw',
      location: { on: 'shell', elevation: 3200, orientationDeg: 90 },
    });
    expect(added.angleConvention).toBe('east_ccw');
    expect(added.orientationDeg).toBe(90);
    near(added.position, [5000, 6000, 5200]);
    expect(ports(north, 'V-101').ports['V-101:N1']?.orientationDeg).toBe(0);
    expect(
      data<PortsData>(north, 'equipment_ports', { equipment: 'V-101', angleConvention: 'east_ccw' }).ports['V-101:N1']?.orientationDeg,
    ).toBe(90);
  });

  it('ports are stable in world coordinates under the level elevation', () => {
    let doc = apply(mmDocument(), 'add_level', { name: 'Deck', elevation: 3000 });
    doc = apply(doc, 'add_vessel', { ...separatorParams, levelId: 'level-1' });
    doc = apply(doc, 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[2] });
    near(ports(doc).ports['V-101:N3']?.position ?? [], [5000, 5000, 3000 + 6700]);
  });
});

describe('add_nozzle: hardware from the 01 PSC catalogue', () => {
  it('DN150 CL150 takes the ASME B16.5 flange row; DN500 has none and is flagged as a placeholder', () => {
    const doc = separatorDocument();
    const result = ports(doc, 'V-101');
    expect(result.ports['V-101:N1']?.flange).toMatchObject({ outsideDiameter: 279.4, thickness: 23.9, placeholder: false });
    expect(result.ports['V-101:N1']?.flange?.catalogRef).toMatch(/^llull-open-piping@.*\/asme-b16\.5-wn-rf$/);
    expect(result.ports['V-101:M1']?.flange?.placeholder).toBe(true);
    const manway = data<NozzleData>(separatorDocument(false), 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[3] });
    expect(manway.warnings.map((warning) => warning.code)).toContain('EQP_FLANGE_PLACEHOLDER');
    const standard = data<NozzleData>(separatorDocument(false), 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[0] });
    expect(standard.warnings).toEqual([]);
  });

  it('accepts nps instead of dn, an EN PN rating, and falls back for another facing', () => {
    const base = separatorDocument(false);
    const byNps = data<NozzleData>(base, 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[0], dn: undefined, nps: 6 });
    expect(byNps.flange.outsideDiameter).toBe(279.4);
    const en = data<NozzleData>(base, 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[0], dn: 100, rating: 'PN16' });
    expect(en.flange.outsideDiameter).toBe(220);
    const flat = data<NozzleData>(base, 'add_nozzle', { equipment: 'V-101', ...separatorNozzles[0], facing: 'FF' });
    expect(flat.flange.outsideDiameter).toBe(279.4);
    const omitted = data<NozzleData>(base, 'add_nozzle', {
      equipment: 'V-101',
      ...separatorNozzles[0],
      facing: undefined,
      location: { on: 'shell', elevation: 3200 },
    });
    expect(omitted.defaulted).toEqual(expect.arrayContaining(['facing', 'location.orientationDeg']));
  });

  it('draws one revolution per nozzle whose axis (local +Z after its rotation) is the port direction', () => {
    const doc = separatorDocument();
    const element = equipmentOf(doc, 'V-101');
    const result = ports(doc, 'V-101');
    for (const mark of ['N1', 'N2', 'N3', 'M1']) {
      const entity = doc.entities[`${element.id}:nozzle-${mark}`] as RevolutionEntity;
      expect(entity.kind).toBe('revolution');
      expect(entity.tags).toContain(`element:${element.id}`);
      const axis = applyEulerXYZ([0, 0, 1], [0, 0, 0], entity.rotation);
      near(axis, result.ports[`V-101:${mark}`]?.direction ?? [], 9);
      // the flange face (profile top) lands on the port position
      const length = Math.max(...entity.profile.map((point) => point[1]));
      const face: Vec3 = [
        entity.position[0] + axis[0] * length,
        entity.position[1] + axis[1] * length,
        entity.position[2] + axis[2] * length,
      ];
      near(face, result.ports[`V-101:${mark}`]?.position ?? [], 6);
    }
  });
});

describe('add_nozzle: free locations work on legacy equipment blocks and pumps', () => {
  const blockDocument = (): CadDocument =>
    apply(mmDocument(), 'add_equipment', {
      name: 'Pump skid',
      location: [1000, 2000],
      size: [2000, 800, 900],
      mark: 'P-1',
      angle: Math.PI / 2,
    });

  it('adds a nozzle to an add_equipment block: the box stays, the nozzle solid joins, legacy fields are untouched', () => {
    const before = equipmentOf(blockDocument(), 'P-1');
    const result = ok(blockDocument(), 'add_nozzle', {
      equipment: 'P-1',
      mark: 'S1',
      service: 'suction',
      dn: 100,
      rating: 'CL150',
      location: { on: 'free', position: [1000, 0, 450], direction: [1, 0, 0] },
      projection: 200,
    });
    const doc = result.document;
    const after = equipmentOf(doc, 'P-1');
    expect(after.size).toEqual(before.size);
    expect(after.weight).toBe(before.weight);
    expect(after.plant?.template.kind).toBe('block');
    expect(Object.keys(doc.entities).sort()).toEqual([`${after.id}:body`, `${after.id}:nozzle-S1`]);
    // equipment frame rotated 90 degrees counter-clockwise: local +X -> world +Y
    near(ports(doc).ports['P-1:S1']?.position ?? [], [1000, 2000 + 1000, 450]);
    near(ports(doc).ports['P-1:S1']?.direction ?? [], [0, 1, 0], 9);
  });

  it('ports follow the block when it is moved with update_equipment', () => {
    const doc = apply(blockDocument(), 'add_nozzle', {
      equipment: 'P-1',
      mark: 'D1',
      dn: 80,
      rating: 'CL150',
      location: { on: 'free', position: [0, 0, 900], direction: [0, 0, 1] },
      projection: 150,
    });
    const moved = apply(doc, 'update_equipment', { currentMark: 'P-1', location: [5000, 5000] });
    near(ports(moved).ports['P-1:D1']?.position ?? [], [5000, 5000, 900]);
  });

  it('refuses a shell / head location on a block and a vessel from update_equipment', () => {
    expectRefusal(
      blockDocument(),
      'add_nozzle',
      { equipment: 'P-1', mark: 'X', dn: 80, rating: 'CL150', projection: 300, location: { on: 'shell', elevation: 100 } },
      'EQP_PARAM_INVALID',
      'location.on',
    );
    const result = execute(separatorDocument(false), 'update_equipment', { currentMark: 'V-101', size: [1, 1, 1] });
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(/update_equipment_parameters/);
  });
});

describe('add_nozzle: refusals and warnings', () => {
  const base = separatorDocument(false);
  const nozzle = { equipment: 'V-101', ...separatorNozzles[0] };
  it.each([
    ['unknown equipment', { equipment: 'V-999' }, 'EQP_NOT_FOUND', 'equipment'],
    ['blank mark', { mark: '  ' }, 'EQP_PARAM_INVALID', 'mark'],
    ['elevation above the shell', { location: { on: 'shell', elevation: 4500 } }, 'EQP_NOZZLE_OFF_BODY', 'location.elevation'],
    ['negative elevation', { location: { on: 'shell', elevation: -1 } }, 'EQP_NOZZLE_OFF_BODY', 'location.elevation'],
    ['station on a vertical vessel', { location: { on: 'shell', station: 100 } }, 'EQP_PARAM_INVALID', 'location.elevation'],
    ['both elevation and station', { location: { on: 'shell', elevation: 100, station: 100 } }, 'EQP_PARAM_INVALID', 'location.station'],
    ['no shell coordinate', { location: { on: 'shell' } }, 'EQP_PARAM_INVALID', 'location.elevation'],
    ['head without a name', { location: { on: 'head' } }, 'EQP_PARAM_INVALID', 'location.head'],
    ['left head on a vertical vessel', { location: { on: 'head', head: 'left' } }, 'EQP_PARAM_INVALID', 'location.head'],
    [
      'radial offset beyond the head',
      { location: { on: 'head', head: 'top', radialOffset: 800 } },
      'EQP_NOZZLE_OFF_BODY',
      'location.radialOffset',
    ],
    ['flange face inside the wall (shell)', { projection: 700 }, 'EQP_NOZZLE_PROJECTION_TOO_SHORT', 'projection'],
    [
      'flange face inside the head',
      { location: { on: 'head', head: 'top' }, projection: 380 },
      'EQP_NOZZLE_PROJECTION_TOO_SHORT',
      'projection',
    ],
    ['free without position', { location: { on: 'free', direction: [1, 0, 0] } }, 'EQP_PARAM_INVALID', 'location.position'],
    ['free without direction', { location: { on: 'free', position: [0, 0, 0] } }, 'EQP_PARAM_INVALID', 'location.direction'],
    [
      'free with a zero direction',
      { location: { on: 'free', position: [0, 0, 0], direction: [0, 0, 0] } },
      'EQP_PARAM_INVALID',
      'location.direction',
    ],
    [
      'free with a neck shorter than the flange',
      { location: { on: 'free', position: [0, 0, 0], direction: [1, 0, 0] }, projection: 10 },
      'EQP_NOZZLE_PROJECTION_TOO_SHORT',
      'projection',
    ],
    ['rating that is not a class or PN', { rating: 'heavy' }, 'EQP_RATING_UNKNOWN', 'rating'],
    ['DN outside the nominal table', { dn: 7 }, 'EQP_RATING_UNKNOWN', 'rating'],
    ['dn and nps together', { nps: 6 }, 'EQP_PARAM_INVALID', 'nps'],
    ['nps without a DN pairing', { dn: undefined, nps: 5.5 }, 'EQP_PARAM_INVALID', 'nps'],
    ['neither dn nor nps', { dn: undefined }, 'EQP_PARAM_INVALID', 'dn'],
  ])('%s', (_name, override, code, path) => {
    expectRefusal(base, 'add_nozzle', { ...nozzle, ...override }, code, path);
  });

  it('duplicate mark', () => {
    expectRefusal(separatorDocument(), 'add_nozzle', nozzle, 'EQP_NOZZLE_MARK_DUPLICATE', 'mark');
  });

  it('a head nozzle in the knuckle zone and two nozzles with overlapping reinforcement zones are warned, not refused', () => {
    const knuckle = data<NozzleData>(base, 'add_nozzle', {
      ...nozzle,
      mark: 'K1',
      location: { on: 'head', head: 'top', radialOffset: 700 },
      projection: 700,
    });
    expect(knuckle.warnings.map((warning) => warning.code)).toContain('EQP_NOZZLE_IN_KNUCKLE');
    const doc = apply(base, 'add_nozzle', nozzle);
    const close = data<NozzleData>(doc, 'add_nozzle', {
      ...nozzle,
      mark: 'N9',
      location: { on: 'shell', elevation: 3250, orientationDeg: 0 },
    });
    expect(close.warnings.map((warning) => warning.code)).toContain('EQP_NOZZLE_OVERLAP');
  });

  it('is pure', () => {
    const snapshot = JSON.stringify(base);
    execute(base, 'add_nozzle', nozzle);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('update_nozzle and delete_nozzle', () => {
  it('update_nozzle keeps the port id and moves the flange face', () => {
    const doc = separatorDocument();
    const updated = ok(doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', projection: 1200, rating: 'CL300', service: 'feed' });
    const data1 = updated.data as NozzleData & { changed: string[] };
    expect(data1.portId).toBe('V-101:N1');
    expect(data1.changed).toEqual(['service', 'rating', 'projection']);
    near(data1.position, [5000, 6200, 5200]);
    const port = ports(updated.document).ports['V-101:N1'] as Port & { service?: string; rating?: string };
    expect(port.service).toBe('feed');
    expect(port.rating).toBe('CL300');
    expect(ports(updated.document).order).toEqual(['V-101:N1', 'V-101:N2', 'V-101:N3', 'V-101:M1']);
  });

  it('update_nozzle re-reads the location in the convention of the call and re-validates', () => {
    const doc = separatorDocument();
    const turned = data<NozzleData>(doc, 'update_nozzle', {
      equipment: 'V-101',
      mark: 'N1',
      location: { on: 'shell', elevation: 3200, orientationDeg: 0 },
      angleConvention: 'east_ccw',
    });
    near(turned.direction, [1, 0, 0], 9);
    const byNps = data<NozzleData>(doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', nps: 8 });
    expect(byNps.flange.outsideDiameter).toBe(342.9);
  });

  it.each([
    ['unknown equipment', { equipment: 'V-999', mark: 'N1', projection: 1100 }, 'EQP_NOT_FOUND', 'equipment'],
    ['unknown mark', { equipment: 'V-101', mark: 'Z9', projection: 1100 }, 'EQP_NOZZLE_NOT_FOUND', 'mark'],
    ['nothing to change', { equipment: 'V-101', mark: 'N1' }, 'EQP_PARAM_INVALID', undefined],
    ['face inside the wall', { equipment: 'V-101', mark: 'N1', projection: 700 }, 'EQP_NOZZLE_PROJECTION_TOO_SHORT', 'projection'],
    ['bad rating', { equipment: 'V-101', mark: 'N1', rating: 'x' }, 'EQP_RATING_UNKNOWN', 'rating'],
    ['dn and nps', { equipment: 'V-101', mark: 'N1', dn: 100, nps: 4 }, 'EQP_PARAM_INVALID', 'nps'],
    ['bad location', { equipment: 'V-101', mark: 'N1', location: { on: 'shell' } }, 'EQP_PARAM_INVALID', 'location.elevation'],
  ])('update_nozzle refuses: %s', (_name, params, code, path) => {
    expectRefusal(separatorDocument(), 'update_nozzle', params, code, path);
  });

  it('delete_nozzle removes the record and its solid, keeping the other ports', () => {
    const doc = separatorDocument();
    const element = equipmentOf(doc, 'V-101');
    const result = ok(doc, 'delete_nozzle', { equipment: 'V-101', mark: 'N2' });
    expect(ports(result.document).order).toEqual(['V-101:N1', 'V-101:N3', 'V-101:M1']);
    expect(result.document.entities[`${element.id}:nozzle-N2`]).toBeUndefined();
    expect(result.document.entities[`${element.id}:nozzle-N1`]).toBeDefined();
  });

  it('delete_nozzle refuses a connected port unless forced; unknown targets are coded', () => {
    const piped = apply(separatorDocument(), 'add_pipe_run', {
      points: [
        [5000, 6000, 5200],
        [5000, 7000, 5200],
      ],
      from: 'V-101:N1',
      to: 'BL-1',
    });
    const refusal = expectRefusal(piped, 'delete_nozzle', { equipment: 'V-101', mark: 'N1' }, 'EQP_PORT_CONNECTED', 'mark');
    expect(refusal.error?.ids).toContain('equipment-1');
    const forced = ok(piped, 'delete_nozzle', { equipment: 'V-101', mark: 'N1', force: true });
    expect((forced.data as { disconnectedPipes: string[] }).disconnectedPipes).toHaveLength(1);
    const moved = data<{ connectedPipes: string[] }>(piped, 'update_nozzle', { equipment: 'V-101', mark: 'N1', projection: 1100 });
    expect(moved.connectedPipes).toHaveLength(1);
    expectRefusal(separatorDocument(), 'delete_nozzle', { equipment: 'V-999', mark: 'N1' }, 'EQP_NOT_FOUND', 'equipment');
    expectRefusal(separatorDocument(), 'delete_nozzle', { equipment: 'V-101', mark: 'Q' }, 'EQP_NOZZLE_NOT_FOUND', 'mark');
  });
});

describe('equipment_ports', () => {
  it('lists every equipment, is read-only, refuses an unknown one', () => {
    const doc = apply(separatorDocument(), 'add_vessel', { ...separatorParams, tag: 'V-102', location: [9000, 5000] });
    const all = ports(doc);
    expect(all.count).toBe(4);
    expect(all.truncated).toBe(false);
    expect(execute(doc, 'equipment_ports', {}).document).toBe(doc);
    expect(ports(doc, 'V-102').count).toBe(0);
    expect(ports(doc, 'equipment-1').count).toBe(4);
    expectRefusal(doc, 'equipment_ports', { equipment: 'V-999' }, 'EQP_NOT_FOUND', 'equipment');
  });

  it('bounds the answer at 500 ports when no equipment is named (AF-12)', () => {
    const doc = separatorDocument();
    const element = equipmentOf(doc, 'V-101');
    const template = element.plant?.nozzles[0];
    if (template === undefined || element.plant === undefined) throw new Error('fixture');
    const many = Array.from({ length: 501 }, (_unused, index) => ({ ...template, mark: `T${index}` }));
    const building = buildingOf(doc);
    const crowded: CadDocument = {
      ...doc,
      building: {
        ...building,
        elements: { ...building.elements, [element.id]: { ...element, plant: { ...element.plant, nozzles: many } } },
      },
    };
    const result = ports(crowded);
    expect(result.count).toBe(501);
    expect(result.order).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(ports(crowded, 'V-101').order).toHaveLength(501);
  });

  it('equipmentPorts (the shared API) takes a building model or a document and skips equipment without plant data', () => {
    const doc = separatorDocument();
    const element = equipmentOf(doc, 'V-101');
    expect(equipmentPorts(doc, element)).toHaveLength(4);
    expect(equipmentPorts(buildingOf(doc), element)).toEqual(equipmentPorts(doc, element));
    expect(equipmentPorts(buildingOf(doc), { ...element, plant: undefined } as unknown as EquipmentElement)).toEqual([]);
    expect(equipmentPorts({}, element)).toEqual([]);
  });
});

describe('is pure', () => {
  const unchanged = (doc: CadDocument, name: string, params: Record<string, unknown>): void => {
    const snapshot = JSON.stringify(doc);
    execute(doc, name, params);
    expect(JSON.stringify(doc)).toBe(snapshot);
  };
  it('update_nozzle, delete_nozzle and the forced delete leave their input untouched', () => {
    const doc = separatorDocument();
    unchanged(doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', projection: 1200 });
    unchanged(doc, 'delete_nozzle', { equipment: 'V-101', mark: 'N1' });
    const piped = apply(doc, 'add_pipe_run', {
      points: [
        [5000, 6000, 5200],
        [5000, 7000, 5200],
      ],
      from: 'V-101:N1',
    });
    unchanged(piped, 'delete_nozzle', { equipment: 'V-101', mark: 'N1', force: true });
  });
});

describe('add_nozzle: identifiers and ratings', () => {
  const nozzle = { equipment: 'V-101', ...separatorNozzles[0] };
  it.each([
    ['a colon in the mark', { mark: 'N:1' }, 'EQP_PARAM_INVALID', 'mark'],
    ['a space in the mark', { mark: 'N 1' }, 'EQP_PARAM_INVALID', 'mark'],
    ['a class that is not an ASME class', { rating: 'CL200' }, 'EQP_RATING_UNKNOWN', 'rating'],
    ['a PN that is not in the series', { rating: 'PN7' }, 'EQP_RATING_UNKNOWN', 'rating'],
  ])('refuses %s', (_name, override, code, path) => {
    expectRefusal(separatorDocument(false), 'add_nozzle', { ...nozzle, ...override }, code, path);
  });

  it('accepts every ASME class of the series (hardware placeholder where the catalogue has no row)', () => {
    for (const rating of ['CL400', 'CL900', 'CL1500', 'CL2500']) ok(separatorDocument(false), 'add_nozzle', { ...nozzle, rating });
  });

  it('update_equipment refuses a parametric vessel with a coded refusal', () => {
    const result = execute(separatorDocument(false), 'update_equipment', { currentMark: 'V-101', size: [1, 1, 1] });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('EQP_NOT_PARAMETRIC');
    expect(result.error?.paths).toContain('elementId');
  });
});
