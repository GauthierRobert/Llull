/**
 * Fixtures of the 02 RTE tests: the pack's CS150 catalogue stub + spec (PSC format, docs/plant/02-spec-driven-routing/validation/data), documents
 * holding them, and the SC-RTE-01 scene (pump P-101 and vessel V-101 with DN100 CL150 RF nozzles).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data } from '../../../helpers/commandAssertions';

const DATA = path.resolve(__dirname, '../../../../docs/plant/02-spec-driven-routing/validation/data');

export const rteJson = <T = Record<string, unknown>>(file: string): T => JSON.parse(readFileSync(path.join(DATA, file), 'utf8')) as T;

/** An empty mm document holding the pack's catalogue stub and spec CS150 (draft, rows partly not grade A). */
export function cs150Document(): CadDocument {
  const mm = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  const withCatalog = apply(mm, 'import_piping_catalog', { catalog: rteJson('catalog_stub_cs150.json') });
  return apply(withCatalog, 'import_pipe_spec', { spec: rteJson('spec_cs150.json') });
}

/** CS150 document + one DN100 line (`P-1001`); returns the line id (affected[0]). */
export function cs150Line(dn = 100, sequence = '1001'): { doc: CadDocument; lineId: string } {
  const result = apply(cs150Document(), 'create_pipeline', { service: 'P', sequence, spec: 'CS150', dn });
  return { doc: result, lineId: (result.plant?.piping?.lineOrder.at(-1) ?? '') as string };
}

/** Adds a tie-in; returns its id. */
export function addTie(
  doc: CadDocument,
  tag: string,
  position: [number, number, number],
  direction: [number, number, number],
  extra: Record<string, unknown> = {},
): { doc: CadDocument; id: string } {
  const next = apply(doc, 'add_tie_in_point', { tag, position, direction, dn: 100, endType: 'BW', ...extra });
  return { doc: next, id: next.plant?.piping?.tieInOrder.at(-1) as string };
}

/** SC-RTE-01 scene: pump P-101 (top discharge at z 1000 facing +Z) and vessel V-101 (side inlet N1, face at x 6000 facing -X, z 4000). */
export function pumpToVessel(): CadDocument {
  let doc = cs150Document();
  doc = apply(doc, 'add_equipment', { name: 'Centrifugal pump', mark: 'P-101', location: [0, -300], size: [1200, 600, 800], weight: 650 });
  doc = apply(doc, 'add_nozzle', {
    equipment: 'P-101',
    mark: 'N2',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'free', position: [0, 300, 1000], direction: [0, 0, 1] },
    projection: 300,
  });
  doc = apply(doc, 'add_vessel', {
    tag: 'V-101',
    name: 'Feed drum',
    orientation: 'vertical',
    location: [7000, 3000],
    insideDiameter: 1600,
    tangentLength: 4000,
    heads: { top: { type: 'ellipsoidal', ratio: 2 }, bottom: { type: 'ellipsoidal', ratio: 2 } },
    shellThickness: 10,
    headThickness: 10,
    corrosionAllowance: 3,
    support: { type: 'skirt', height: 1000, thickness: 10 },
    design: {
      pressure: { value: 1, unit: 'MPa' },
      temperatureC: 150,
      material: 'SA-516 Gr 70',
      allowableStress: { value: 137.9, unit: 'MPa', source: 'user input' },
      jointEfficiency: { shell: 1, heads: 1 },
      materialDensityKgM3: 7850,
    },
  });
  return apply(doc, 'add_nozzle', {
    equipment: 'V-101',
    mark: 'N1',
    dn: 100,
    rating: 'CL150',
    facing: 'RF',
    location: { on: 'shell', elevation: 3000, orientationDeg: 270 },
    projection: 1000,
  });
}

/** The compass legs of SC-RTE-01: up 1500, +Y 3000, +X 3000, up 1500 (the closing +X 3000 is added). */
export const SC01_LEGS = [
  { direction: '+Z', length: 1500 },
  { direction: '+Y', length: 3000 },
  { direction: '+X', length: 3000 },
  { direction: '+Z', length: 1500 },
] as const;

/** SC-RTE-01 through route_pipe: the document and the route_pipe data. */
export function routedPumpToVessel(): { doc: CadDocument; line: string; runId: string; route: Record<string, unknown> } {
  const base = pumpToVessel();
  const withLine = apply(base, 'create_pipeline', {
    service: 'P',
    sequence: '1001',
    spec: 'CS150',
    dn: 100,
    from: 'P-101:N2',
    to: 'V-101:N1',
    designTempC: 60,
    designPressureBarG: 10,
  });
  const line = withLine.plant?.piping?.lineOrder.at(-1) as string;
  const params = { lineId: line, from: { portId: 'P-101:N2' }, to: { portId: 'V-101:N1' }, legs: SC01_LEGS };
  const route = data<Record<string, unknown>>(withLine, 'route_pipe', params);
  const doc = apply(withLine, 'route_pipe', params);
  return { doc, line, runId: route['runId'] as string, route };
}

/** `doc` without any pipe spec (a line whose spec is gone). */
export function withoutSpecs(doc: CadDocument): CadDocument {
  const { spec, ...plant } = doc.plant ?? {};
  expect(spec).toBeDefined();
  return { ...doc, plant };
}

/** SC-RTE-02: SC-RTE-01 plus the NPS 4 CL150 gate valve XV-1001 centred 800 mm along the first (vertical) leg, stem toward -Y. */
export function valveScene(): { doc: CadDocument; line: string; runId: string; valveId: string; insert: Record<string, unknown> } {
  const base = routedPumpToVessel();
  const params = { runId: base.runId, type: 'valveGate', tag: 'XV-1001', at: { leg: 0, centreDistance: 800 }, stemDirection: [0, -1, 0] };
  const insert = data<Record<string, unknown>>(base.doc, 'insert_inline_component', params);
  return {
    doc: apply(base.doc, 'insert_inline_component', params),
    line: base.line,
    runId: base.runId,
    valveId: insert['componentId'] as string,
    insert,
  };
}

/**
 * SC-RTE-03: a DN150 header between two butt-weld tie-ins at z 3000 (x 0 -> 10000), routed; a third DN100 tie-in TP-3 at (4000, 2000, 3000) facing -Y
 * for the branch. Returns the ids.
 */
export function headerScene(): { doc: CadDocument; lineId: string; headerId: string; tieA: string; tieB: string; tieC: string } {
  const line = cs150Line(150, '2001');
  const a = addTie(line.doc, 'TP-1', [0, 0, 3000], [1, 0, 0], { dn: 150 });
  const b = addTie(a.doc, 'TP-2', [10000, 0, 3000], [-1, 0, 0], { dn: 150 });
  const c = addTie(b.doc, 'TP-3', [4000, 2000, 3000], [0, -1, 0], { dn: 100 });
  const doc = apply(c.doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc, lineId: line.lineId, headerId: doc.plant?.piping?.runOrder[0] as string, tieA: a.id, tieB: b.id, tieC: c.id };
}
