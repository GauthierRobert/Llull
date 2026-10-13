import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { plans } from '../golden/plans';
import { runPlan } from '../golden/runPlan';

/** Writer/loader drift guard: whatever a command produced must reload, and re-serialize identically. */
function expectReloads(doc: CadDocument, includeDerived = false): void {
  const json = serializeDocument(doc, { includeDerived });
  const reloaded = deserializeDocument(json);
  expect(serializeDocument(reloaded, { includeDerived })).toBe(json);
}

function run(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
}

describe('golden corpus round trip', () => {
  it.each(Object.entries(plans))('%s reloads and re-serializes equal', (_name, plan) => {
    const { document } = runPlan(plan);
    expectReloads(document);
    expectReloads(document, true);
  });
});

describe('generator commands at their maximum parameters reload', () => {
  it('add_spur_gear with the maximum tooth count', () => {
    expectReloads(run(createEmptyDocument(), 'add_spur_gear', { module: 1, teeth: 1000, faceWidth: 5 }));
  });
  it('add_spur_gear above the old 10 000 point cap (626 teeth)', () => {
    expectReloads(run(createEmptyDocument(), 'add_spur_gear', { module: 1, teeth: 626, faceWidth: 5 }));
  });
  it('add_spline_shaft with ~1000 teeth', () => {
    expectReloads(run(createEmptyDocument(), 'add_spline_shaft', { referenceDiameter: 499, module: 0.5, length: 50 }));
  });
  it('add_spline_shaft at the generator tooth limit', () => {
    expectReloads(run(createEmptyDocument(), 'add_spline_shaft', { referenceDiameter: 1002, module: 1, teeth: 1000, length: 10 }));
  });
});

const TRIANGLE = [
  [1, 0],
  [2, 0],
  [2, 1],
];

describe('ids ending in -0.<n>', () => {
  it('revolve_profile id "shim-0.5" reloads', () => {
    expectReloads(run(createEmptyDocument(), 'revolve_profile', { profile: TRIANGLE, id: 'shim-0.5' }));
  });
  it('still rejects a step number that is not a safe integer', () => {
    const doc = run(createEmptyDocument(), 'revolve_profile', { profile: TRIANGLE, id: 'x-99999999999999999999.1' });
    expect(() => deserializeDocument(serializeDocument(doc))).toThrow('safe integer');
  });
});

describe('closed sweeps', () => {
  it('a full-circle arc swept into a ring reloads', () => {
    let doc = run(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 40 });
    doc = run(doc, 'sweep_profile', { pathId: Object.keys(doc.entities)[0], radius: 3 });
    expectReloads(doc);
  });
  it('a closed path with stations is still rejected on load', () => {
    let doc = run(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 40 });
    doc = run(doc, 'sweep_profile', { pathId: Object.keys(doc.entities)[0], radius: 3 });
    const envelope = JSON.parse(serializeDocument(doc)) as { document: { entities: Record<string, Record<string, unknown>> } };
    const sweep = Object.values(envelope.document.entities).find((e) => e['kind'] === 'sweep') as Record<string, unknown>;
    const ring = Array.from({ length: 8 }, (_, i): [number, number] => [Math.cos(i), Math.sin(i)]);
    sweep['stations'] = [
      { at: 0, ring },
      { at: 1, ring },
    ];
    expect(() => deserializeDocument(JSON.stringify(envelope))).toThrow();
  });
});
