/**
 * Plant 08 DAT M1: the object providers (TR-DAT-05): the built-in ones (building elements, routed lines, inline components, tie-ins) and the registration point
 * sibling plugins use. A read-only provider adopts the tag its object carries and is never renamed.
 */

import type { CadDocument } from '@core/model/types';
import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { getPlantData } from '@aec/plant/data/model';
import {
  allProviders,
  getProvider,
  registerPlantObjectProvider,
  unregisterPlantObjectProvider,
  type PlantObjectProvider,
} from '@aec/plant/data/providers';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { addTie, routedPumpToVessel, valveScene } from '../piping/rteFixtures';
import { addEquipment, assignPump, libraryDocument } from './dataFixtures';

const withLibrary = (doc: CadDocument): CadDocument =>
  apply(
    apply(doc, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1' },
      ],
    }),
    'load_plant_class_library',
    { library: 'llull-default-process' },
  );

describe('built-in providers', () => {
  it('are registered by the plugin: building elements, routed lines, inline components and tie-ins', () => {
    expect(allProviders().map((provider) => provider.id)).toEqual(
      expect.arrayContaining(['buildingElement', 'pipeLine', 'inlineComponent', 'tieIn']),
    );
    expect(getProvider('nope')).toBeUndefined();
  });

  it('an inline component without a tag cannot be adopted by a provider that cannot rename it', () => {
    const base = routedPumpToVessel();
    const inserted = data<{ componentId: string }>(base.doc, 'insert_inline_component', {
      runId: base.runId,
      type: 'valveGate',
      at: { leg: 0, centreDistance: 800 },
      stemDirection: [0, -1, 0],
    });
    const doc = withLibrary(
      apply(base.doc, 'insert_inline_component', {
        runId: base.runId,
        type: 'valveGate',
        at: { leg: 0, centreDistance: 800 },
        stemDirection: [0, -1, 0],
      }),
    );
    const refusal = expectRefusal(
      doc,
      'assign_plant_object',
      { target: inserted.componentId, className: 'IsolationValve', hierarchy: 'U10', tagFields: { valveCode: 'XV', seq: 1 } },
      'DAT_TARGET_TAG_READONLY',
      'target',
    );
    expect(refusal.summary).toContain('no tag to adopt');
  });

  it('a tie-in tag is adopted only when it fits the class format', () => {
    const tie = addTie(withLibrary(routedPumpToVessel().doc), 'TP-1', [0, 0, 0], [1, 0, 0]);
    expectRefusal(
      tie.doc,
      'assign_plant_object',
      { target: tie.id, className: 'IsolationValve', hierarchy: 'U10' },
      'DAT_TAG_FORMAT',
      'tag',
    );
    const flexible = apply(tie.doc, 'define_plant_class', { name: 'TieInPoint', tagFormat: 'TP-{seq}', properties: [] });
    const adopted = apply(flexible, 'assign_plant_object', { target: tie.id, className: 'TieInPoint', hierarchy: 'U10' });
    expect(Object.values(getPlantData(adopted).objects)[0]).toMatchObject({
      tag: 'TP-1',
      tagFields: {},
      target: { kind: 'provider', provider: 'tieIn' },
    });
  });

  it('a read-only provider blocks a retag, naming it, and the whole change is refused', () => {
    const scene = valveScene();
    let doc = withLibrary(scene.doc);
    doc = apply(doc, 'define_plant_class', { name: 'MyValve', parent: 'IsolationValve' });
    doc = apply(doc, 'assign_plant_object', { target: scene.valveId, className: 'MyValve', hierarchy: 'U10' });
    const refusal = expectRefusal(
      doc,
      'set_tag_format',
      { className: 'MyValve', tagFormat: '{valveCode}/{seq:4}', retag: true },
      'DAT_TARGET_TAG_READONLY',
    );
    expect(refusal.summary).toContain('cannot rename');
  });

  it('a retag that cannot be generated names the object', () => {
    const scene = valveScene();
    let doc = withLibrary(scene.doc);
    doc = apply(doc, 'define_plant_class', { name: 'MyValve', parent: 'IsolationValve' });
    doc = apply(doc, 'assign_plant_object', { target: scene.valveId, className: 'MyValve', hierarchy: 'U10' });
    const refusal = expectRefusal(
      doc,
      'set_tag_format',
      { className: 'MyValve', tagFormat: '{valveCode}-{rating}', retag: true },
      'DAT_TAG_FIELD_MISSING',
    );
    expect(refusal.error?.ids).toHaveLength(1);
  });

  it('a line reference by tag that exists in two plants must be the id', () => {
    let doc = apply(libraryDocument(), 'define_plant_hierarchy', {
      nodes: [{ code: 'U20', kind: 'unit', parent: 'P2', properties: { areaNumber: '1' } }],
    });
    for (const hierarchy of ['U10', 'U20'])
      doc = apply(doc, 'assign_plant_object', {
        target: 'reserved',
        className: 'ProcessLine',
        hierarchy,
        tagFields: { nominalSize: 50, fluidCode: 'P', seq: 1, spec: 'A1' },
      });
    const refusal = expectRefusal(
      doc,
      'assign_plant_object',
      { target: 'reserved', className: 'CentrifugalPump', hierarchy: 'U10', nextSequence: true, line: '50-P-0001-A1' },
      'DAT_OBJECT_UNKNOWN',
      'line',
    );
    expect(refusal.summary).toContain('pass the id');
    const ids = getPlantData(doc).objectOrder;
    const linked = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      nextSequence: true,
      line: ids[0] as string,
      properties: { Description: 'x', DesignPressure: 1 },
    });
    expect(Object.values(getPlantData(linked).objects).at(-1)?.lineId).toBe(ids[0]);
  });
});

describe('a provider registered by a sibling plugin', () => {
  const nozzles: PlantObjectProvider = {
    id: 'testNozzle',
    element: (_doc, id) =>
      id === 'N-1' ? { id, category: 'nozzle', label: 'nozzle N-1', tag: 'N-1', tagUnique: false, needsClass: true } : undefined,
    elements: () => [{ id: 'N-1', category: 'nozzle', label: 'nozzle N-1', tag: 'N-1', tagUnique: false, needsClass: true }],
  };

  afterEach(() => {
    unregisterPlantObjectProvider('testNozzle');
  });

  it('is reached by { provider, id }, by a bare id, reported unclassified until assigned, and read-only', () => {
    registerPlantObjectProvider(nozzles);
    let doc = apply(libraryDocument(), 'define_plant_class', { name: 'Nozzle', tagFormat: 'N-{seq}', properties: [] });
    expect(data<{ findings: Array<{ code: string; ids: string[] }> }>(doc, 'check_plant_data', {}).findings).toEqual([
      expect.objectContaining({ code: 'DAT_UNCLASSIFIED_ELEMENT', ids: ['N-1'] }),
    ]);
    doc = apply(doc, 'assign_plant_object', { target: { provider: 'testNozzle', id: 'N-1' }, className: 'Nozzle', hierarchy: 'U10' });
    expect(Object.values(getPlantData(doc).objects)[0]).toMatchObject({
      tag: 'N-1',
      target: { kind: 'provider', provider: 'testNozzle', id: 'N-1' },
    });
    expect(data<{ findings: unknown[] }>(doc, 'check_plant_data', {}).findings).toEqual([]);
    expectRefusal(
      doc,
      'assign_plant_object',
      { target: 'N-1', className: 'Nozzle', hierarchy: 'U10' },
      'DAT_TARGET_ALREADY_TAGGED',
      'target',
    );
  });

  it('an unregistered provider name is a DAT_TARGET_UNKNOWN naming the installed ones', () => {
    const refusal = expectRefusal(
      libraryDocument(),
      'assign_plant_object',
      { target: { provider: 'missing', id: 'x' }, className: 'Tank', hierarchy: 'U10', nextSequence: true },
      'DAT_TARGET_UNKNOWN',
      'target',
    );
    expect(refusal.summary).toContain('buildingElement');
  });
});

describe('write-back failures', () => {
  it('a provider that cannot write the tag refuses the assignment with its reason, and nothing changes', () => {
    registerPlantObjectProvider({
      id: 'testWriter',
      element: (_doc, id) =>
        id === 'W-1' ? { id, category: 'thing', label: 'thing W-1', tag: 'old', tagUnique: false, needsClass: false } : undefined,
      elements: () => [],
      writeTags: () => 'the file is locked',
    });
    const doc = apply(libraryDocument(), 'define_plant_class', { name: 'Thing', tagFormat: 'W-{seq}', properties: [] });
    const refusal = expectRefusal(
      doc,
      'assign_plant_object',
      { target: { provider: 'testWriter', id: 'W-1' }, className: 'Thing', hierarchy: 'U10', tagFields: { seq: 1 } },
      'DAT_TARGET_TAG_READONLY',
      'target',
    );
    expect(refusal.summary).toContain('the file is locked');
    unregisterPlantObjectProvider('testWriter');
  });

  it('a routed line is not tagged twice, and set_plant_properties re-tags it through update_pipeline', () => {
    const base = routedPumpToVessel();
    const doc = apply(withLibrary(base.doc), 'assign_plant_object', {
      target: base.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    const result = execute(doc, 'set_plant_properties', { edits: [{ object: '100-P-1001-CS150', property: 'fluidCode', value: 'HO' }] });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.document.plant?.piping?.lines[base.line]?.lineNumber).toBe('100-HO-1001-CS150');
    const pump = addEquipment(libraryDocument());
    expect(assignPump(pump.doc, pump.id).objectId).toMatch(/^plantobj-/);
  });
});
