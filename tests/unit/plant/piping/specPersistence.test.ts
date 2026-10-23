/** Plant 01 PSC M2: `export_pipe_spec` (VC-PSC-17 byte-stable round trip, spec sheet CSV) and the `plant.spec` document slice (save / load / replay). */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { pipingCatalogDocument } from '@aec/plant/catalog/document';
import { pipeSpecErrors } from '@aec/plant/spec/document';
import { getSpecModel, latestSpec, withSpecModel } from '@aec/plant/spec/store';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { fixtureSpec, importedDoc, mixSpec, smallSpec, type Json } from './specFixture';

interface Exported {
  text: string;
  sha256: string;
  bytes: number;
  components: number;
  format: string;
  branchCsv?: string;
}
const exportSpec = (doc: ReturnType<typeof importedDoc>, params: Json = {}): Exported =>
  data<Exported>(doc, 'export_pipe_spec', { specId: 'CS150-A1', ...params });

describe('export_pipe_spec (VC-PSC-17)', () => {
  it('export -> import -> export is byte-identical (sha256 of the canonical JSON), for the fixture and the mixed spec', () => {
    for (const [file, id] of [
      [fixtureSpec(), 'CS150-A1'],
      [mixSpec(), 'MIX-1'],
      [smallSpec(), 'SMALL'],
    ] as const) {
      const first = exportSpec(importedDoc(file), { specId: id });
      expect(first.sha256).toBe(sha256Hex(first.text));
      const again = exportSpec(apply(createEmptyDocument(), 'import_pipe_spec', { spec: JSON.parse(first.text) }), { specId: id });
      expect(again.text).toBe(first.text);
      expect(again.sha256).toBe(first.sha256);
    }
  });

  it('the canonical file is sorted, in mm, with sizes as keys and the kept extras', () => {
    const exported = exportSpec(importedDoc());
    const file = JSON.parse(exported.text) as Json;
    expect(file).toMatchObject({
      format: 'llull-pipe-spec',
      revision: 1,
      status: 'draft',
      corrosionAllowance: { value: 3, unit: 'mm' },
      sizeRange: { fromNps: '1/2', toNps: '24' },
    });
    expect((file['components'] as Json[]).find((component) => component['id'] === 'F-WN')).toMatchObject({
      boreFromPipe: true,
      class: 150,
    });
    expect(Object.keys(file)).toEqual([...Object.keys(file)].sort());
    expect(exported.components).toBe(15);
  });

  it('exports a chosen revision and refuses an unknown spec or revision', () => {
    const first = importedDoc(smallSpec());
    const second = apply(first, 'import_pipe_spec', { spec: smallSpec({ title: 'r2' }), replace: true });
    expect(second).not.toBe(first);
    const model = getSpecModel(first);
    const approved = withSpecModel(first, {
      ...model,
      specs: { SMALL: (model.specs['SMALL'] ?? []).map((spec) => ({ ...spec, status: 'approved' as const })) },
    });
    const revised = apply(approved, 'import_pipe_spec', { spec: smallSpec({ title: 'r2' }), replace: true });
    expect(JSON.parse(exportSpec(revised, { specId: 'SMALL', revision: 1 }).text)).toMatchObject({ revision: 1, status: 'approved' });
    expect(JSON.parse(exportSpec(revised, { specId: 'SMALL' }).text)).toMatchObject({ revision: 2, title: 'r2' });
    expectRefusal(revised, 'export_pipe_spec', { specId: 'SMALL', revision: 5 }, 'PSC_SPEC_UNKNOWN');
    expectRefusal(revised, 'export_pipe_spec', { specId: 'NOPE' }, 'PSC_SPEC_UNKNOWN');
  });

  it('the spec sheet CSV has a row per component with verified flags, and the branch table as a second CSV', () => {
    const exported = exportSpec(importedDoc(), { format: 'csv' });
    const lines = exported.text.split('\n');
    expect(lines[0]).toBe(
      'component,type,from,to,branchFrom,branchTo,ends,class,pn,facing,radius,schedule,scheduleFromPipe,wallMm,priority,catalogRef,commodityCode,description,material,verified',
    );
    expect(lines).toHaveLength(16);
    const row = (id: string): string[] => (lines.find((line) => line.startsWith(`${id},`)) ?? '').split(',');
    expect(row('E90-LR').slice(0, 4)).toEqual(['E90-LR', 'elbow90', 'NPS 2', 'NPS 24']);
    expect(row('F-WN').at(-1)).toBe('false');
    expect(row('E90-LR').at(-1)).toBe('false');
    expect(row('V-GATE')[0]).toBe('V-GATE');
    expect(exported.branchCsv?.split('\n')[0]).toBe('header,branch,fitting');
    expect(exported.branchCsv?.split('\n')).toHaveLength(10);
    const verified = exportSpec(
      importedDoc({
        ...smallSpec(),
        sizeRange: { fromNps: 4, toNps: 4 },
        components: [{ id: 'P', type: 'pipe', fromNps: 4, toNps: 4, schedule: '40', catalogRef: 'asme-b36.10m' }],
      }),
      { specId: 'SMALL', format: 'csv' },
    );
    expect(verified.text.split('\n')[1]?.endsWith(',true')).toBe(true);
  });

  it('is read-only and pure', () => {
    const doc = importedDoc();
    expectPure(doc, () => execute(doc, 'export_pipe_spec', { specId: 'CS150-A1' }));
    expect(ok(doc, 'export_pipe_spec', { specId: 'CS150-A1' }).document).toBe(doc);
  });
});

describe('the plant.spec document slice', () => {
  const source = importedDoc();

  it('survives save / load and the loaded document resolves the same component', () => {
    const loaded = deserializeDocument(serializeDocument(source));
    expect(loaded.plant?.spec).toEqual(source.plant?.spec);
    expect(data<Json>(loaded, 'resolve_spec_component', { specId: 'CS150-A1', type: 'elbow90', nps: 6 })['componentId']).toBe('E90-LR');
  });

  it('replaying the same commands twice gives the identical document and export', () => {
    const run = (): string => exportSpec(importedDoc(), { format: 'json' }).text + JSON.stringify(importedDoc().plant);
    expect(run()).toBe(run());
  });

  it('validates the slice on load: shape, order, revision numbers, status, sizes', () => {
    expect(pipeSpecErrors(source.plant?.spec)).toEqual([]);
    expect(pipeSpecErrors(5)).toEqual(['plant.spec must be { specs, specOrder }']);
    expect(pipeSpecErrors({ specs: {}, specOrder: ['x'] })[0]).toContain('specOrder');
    const spec = latestSpec(source, 'CS150-A1');
    const at = (revisions: unknown, order = ['CS150-A1']): string[] =>
      pipeSpecErrors({ specs: { 'CS150-A1': revisions }, specOrder: order });
    expect(at([])[0]).toContain('non-empty array');
    expect(at([5])[0]).toContain('llull-pipe-spec');
    expect(at([{ ...spec, revision: 2 }])[0]).toContain('revision 1');
    expect(at([{ ...spec, id: 'OTHER' }])[0]).toContain('id "CS150-A1"');
    expect(at([{ ...spec, status: 'nope' }])[0]).toContain('status');
    expect(at([{ ...spec, components: 5 }])[0]).toContain('components and catalogs');
    expect(at([{ ...spec, sizeRange: { from: 1, to: {} } }])[0]).toContain('sizeRange');
  });

  it('refuses a saved file whose spec slice is corrupt, through the document extension', () => {
    const good = JSON.parse(serializeDocument(source));
    good.document.plant.spec.specs['CS150-A1'][0].status = 'approvedish';
    expect(() => deserializeDocument(JSON.stringify(good))).toThrow();
    expect(pipingCatalogDocument.validate({ plant: { spec: { specs: {}, specOrder: ['x'] } } })).toHaveLength(1);
    expect(pipingCatalogDocument.validate({ plant: 5 })).toEqual([]);
    expect(pipingCatalogDocument.validate({})).toEqual([]);
    expect(deserializeDocument(serializeDocument(createEmptyDocument())).plant).toBeUndefined();
  });
});
