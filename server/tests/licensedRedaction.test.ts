/**
 * TR-MAT-32: licensed (licensed-no-redistribution) material values are redacted from answers to a non-local client over REST;
 * a loopback peer (CLI, desktop) still reads them. A relayed request (X-Forwarded-For) is not a local peer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { libraryHash } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';
import { app } from '../src/index';
import { getLiveDoc, setLiveDoc } from '../src/liveDocument';
import { applyCommand, _resetHistory } from '../src/commandBus';
import { _resetLiveDoc } from '../src/liveDocument';
import { createLibraryStorePort } from '../src/libraries/libraryStore';

const SENTINEL = 123.456789;
const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };
const model = (id: string, property: string, value: number, unit: string, basis: string): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis,
  provenance: { citation: 'synthetic', locator: 'Table 3.7.6.0(b)' },
});
const file = {
  format: 'llull-material-library',
  schemaVersion: 1,
  id: 'mmpds',
  version: '2024',
  title: 'Licensed',
  licence: 'licensed-no-redistribution',
  exportMarking: { regime: 'none' },
  storage: 'private',
  sources: {},
  materials: [
    {
      id: 'aa7075_t6',
      name: 'aa7075_t6',
      designation: '7075',
      specs: [],
      licence: 'licensed-no-redistribution',
      exportMarking: { regime: 'none' },
      propertyModels: [model('density', 'density', 2.81, 'g/cm^3', 'company'), model('Ftu.A', 'Ftu', SENTINEL, 'ksi', 'A')],
    },
    {
      id: 'bolt_lic',
      name: 'bolt_lic',
      designation: 'bolt',
      specs: [],
      licence: 'licensed-no-redistribution',
      exportMarking: { regime: 'none' },
      propertyModels: [model('density', 'density', 7.8, 'g/cm^3', 'company'), model('Fsu.A', 'Fsu', SENTINEL, 'ksi', 'A')],
    },
  ],
};
const ALLOWABLE = { material: 'aa7075_t6', property: 'Ftu', basis: 'A' };

let directory = '';
const previousDirectory = process.env['LLULL_LIBRARIES_DIR'];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-redact-'));
  process.env['LLULL_LIBRARIES_DIR'] = directory;
  _resetLiveDoc();
  _resetHistory();
  const library = file as unknown as MaterialLibrary;
  createLibraryStorePort().register(library, libraryHash(library));
  const imported = applyCommand('import_material_library', { libraryId: 'mmpds', version: '2024', sha256: libraryHash(library) });
  expect(imported.isError, imported.summary).toBe(false);
});

afterEach(() => {
  if (previousDirectory === undefined) delete process.env['LLULL_LIBRARIES_DIR'];
  else process.env['LLULL_LIBRARIES_DIR'] = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

const command = (name: string, params: Record<string, unknown>, headers: Record<string, string> = {}): request.Test =>
  request(app).post('/command').set(headers).send({ name, params });

describe('licensed values and non-local clients (TR-MAT-32)', () => {
  it('REST /command: a loopback peer reads the value, a relayed peer gets redacted data with basis and locator kept', async () => {
    const local = await command('get_material_allowable', ALLOWABLE);
    expect(local.body.data).toMatchObject({ available: true, value: SENTINEL, unit: 'ksi', basis: 'A' });
    const remote = await command('get_material_allowable', ALLOWABLE, REMOTE);
    expect(remote.status).toBe(200);
    expect(JSON.stringify(remote.body)).not.toContain(String(SENTINEL));
    expect(remote.body.data).toMatchObject({
      redacted: true,
      available: true,
      basis: 'A',
      unit: 'ksi',
      modelId: 'Ftu.A',
      provenance: { citation: 'synthetic', locator: 'Table 3.7.6.0(b)' },
    });
    expect(remote.body.data.value).toBeUndefined();
    expect(remote.body.summary).toContain('redacted: true');
  });

  it('REST /command: get_material and evaluate_property lose values (and the resolved density) for a remote peer', async () => {
    const material = await command('get_material', { material: 'aa7075_t6' }, REMOTE);
    expect(JSON.stringify(material.body)).not.toContain(String(SENTINEL));
    expect(JSON.stringify(material.body)).not.toContain('"kgPerM3"');
    expect(material.body.data.redacted).toBe(true);
    expect(material.body.data.values.map((entry: { id: string; basis: string }) => [entry.id, entry.basis])).toEqual([
      ['density', 'company'],
      ['Ftu.A', 'A'],
    ]);
    expect(material.body.data.record.licence).toBe('licensed-no-redistribution');
    const evaluated = await command('evaluate_property', { material: 'aa7075_t6', property: 'Ftu', at: {} }, REMOTE);
    expect(JSON.stringify(evaluated.body)).not.toContain(String(SENTINEL));
    expect(evaluated.body.data).toMatchObject({ redacted: true, basis: 'A' });
    const localMaterial = await command('get_material', { material: 'aa7075_t6' });
    expect(JSON.stringify(localMaterial.body)).toContain(String(SENTINEL));
  });

  it('a non-licensed record is not redacted for a remote peer', async () => {
    applyCommand('define_material_record', {
      id: 'open',
      designation: 'x',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    applyCommand('set_material_property', {
      material: 'open',
      property: 'Ftu',
      value: 77,
      unit: 'ksi',
      basis: 'A',
      source: { citation: 'synthetic' },
    });
    const remote = await command('get_material_allowable', { material: 'open', property: 'Ftu', basis: 'A' }, REMOTE);
    expect(remote.body.data).toMatchObject({ value: 77 });
    expect(remote.body.data.redacted).toBeUndefined();
  });

  /** Two plates (one open sheet material) and a hand-built stack in the live document; the bolt is the licensed library material. */
  function placeStack(): string {
    const plates = ['plate_a', 'plate_b'].map((name) => applyCommand('add_box', { size: [10, 10, 2], name }).affected[0] as string);
    applyCommand('define_material_record', {
      id: 'sheet',
      designation: 'sheet',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    applyCommand('set_material_property', {
      material: 'sheet',
      property: 'Fbru',
      value: 80,
      unit: 'ksi',
      basis: 'A',
      edOverD: 1.5,
      source: { citation: 'synthetic' },
    });
    expect(applyCommand('assign_material', { entityIds: plates, materialName: 'sheet' }).isError).toBe(false);
    const doc = getLiveDoc();
    const provenance = { citation: 'synthetic' };
    setLiveDoc({
      ...doc,
      fasteners: {
        catalogs: {
          F: {
            id: 'F',
            kind: 'bolt',
            standard: { body: 'x', id: 'x' },
            partNumber: [],
            sizes: [{ dash: '3', nominalDiameter: { value: 0.1875, unit: 'in' }, dims: {} }],
            licence: 'company-proprietary',
            provenance,
          },
        },
        stacks: {
          'fst-1.0': {
            id: 'fst-1.0',
            axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
            layers: plates.map((entityId) => ({ entityId, thickness: 2 })),
            fastener: { family: 'F', partNumber: 'F3', instanceId: 'i', diameterDash: '3' },
            washers: [],
            stackThickness: 4,
            holeMode: 'none',
            holeDiameter: 0,
          },
        },
      },
    });
    return 'fst-1.0';
  }
  const jointParams = (stackId: string): Record<string, unknown> => ({
    stackId,
    fastenerMaterial: 'bolt_lic',
    fastenerBasis: 'A',
    sheetBasis: 'A',
    edOverD: 1.5,
  });
  const shearLbf = Math.round(SENTINEL * 1000 * ((Math.PI * 0.1875 * 0.1875) / 4) * 1e6) / 1e6;

  it('joint_capacity with a licensed fastener material: a remote peer gets neither the Fsu, the capacities nor numbers in the summary', async () => {
    const stackId = placeStack();
    const local = await command('joint_capacity', jointParams(stackId));
    expect(local.body.data.inputs[0].value).toBe(SENTINEL);
    expect(local.body.data.shear.lbf).toBe(shearLbf);
    const remote = await command('joint_capacity', jointParams(stackId), REMOTE);
    const text = JSON.stringify(remote.body);
    expect(text).not.toContain(String(SENTINEL));
    expect(text).not.toContain(String(shearLbf));
    expect(remote.body.data.redacted).toBe(true);
    expect(remote.body.data.inputs[0].value).toBeUndefined();
    expect(remote.body.data.shear.lbf).toBeUndefined();
    expect(remote.body.data.basis).toBe('A');
    expect(remote.body.summary).not.toMatch(/\d/);
  });

  it('build_project: a read-only step on a licensed material is redacted per step for a remote peer; an unrelated step is not', async () => {
    const stackId = placeStack();
    const actions = [
      { command: 'get_material_allowable', params: ALLOWABLE },
      { command: 'joint_capacity', params: jointParams(stackId) },
      { command: 'get_material_allowable', params: { material: 'sheet', property: 'Fbru', basis: 'A', edOverD: 1.5 } },
    ];
    const local = await command('build_project', { actions });
    expect(JSON.stringify(local.body)).toContain(String(SENTINEL));
    const remote = await command('build_project', { actions }, REMOTE);
    expect(remote.status).toBe(200);
    expect(JSON.stringify(remote.body)).not.toContain(String(SENTINEL));
    expect(JSON.stringify(remote.body)).not.toContain(String(shearLbf));
    const steps = remote.body.data.steps as Array<{ ok: boolean; data?: { redacted?: boolean; value?: number } }>;
    expect(steps.map((step) => step.ok)).toEqual([true, true, true]);
    expect(steps[0]?.data?.redacted).toBe(true);
    expect(steps[1]?.data?.redacted).toBe(true);
    expect(steps[2]?.data?.redacted).toBeUndefined();
    expect(steps[2]?.data?.value).toBe(80);
  });
});
