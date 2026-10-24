/** Plant 01 PSC M2 review fixes: revision round trip, wall-less EN pipe, load validation, alias matching, DN-bound pipes, UTF-8 size. */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument } from '@core/model/types';
import { pipeSpecErrors } from '@aec/plant/spec/document';
import { getSpecModel, withSpecModel } from '@aec/plant/spec/store';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { importedDoc, mixSpec, smallSpec, withPipe, type Json } from './specFixture';

const exportText = (doc: ReturnType<typeof importedDoc>, id: string): { text: string; sha256: string; bytes: number } =>
  data<{ text: string; sha256: string; bytes: number }>(doc, 'export_pipe_spec', { specId: id });

describe('review fixes', () => {
  it('a spec imported at revision 2 survives save / load with the same sha256', () => {
    const doc = importedDoc({ ...smallSpec(), revision: 2 });
    expect(getSpecModel(doc).specs['SMALL']?.[0]?.revision).toBe(2);
    const before = exportText(doc, 'SMALL');
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(exportText(loaded, 'SMALL').sha256).toBe(before.sha256);
    const again = apply(createEmptyDocument(), 'import_pipe_spec', { spec: JSON.parse(before.text) });
    expect(exportText(again, 'SMALL').sha256).toBe(before.sha256);
  });

  it('an EN 10220 pipe component without wallMm is unverified (wall listed) and its scheduleFromPipe fittings inherit it', () => {
    const spec = mixSpec();
    const components = spec['components'] as Json[];
    const bare = importedDoc({
      ...spec,
      components: [
        { ...(components[0] as Json), wallMm: undefined },
        { ...(components[1] as Json), scheduleFromPipe: true },
      ],
    });
    const pipe = data<Json>(bare, 'resolve_spec_component', { specId: 'MIX-1', type: 'pipe', dn: 80 });
    expect(pipe['verified']).toBe(false);
    expect(pipe['unverifiedDims']).toContain('wall');
    const elbow = data<Json>(bare, 'resolve_spec_component', { specId: 'MIX-1', type: 'elbow90', dn: 80 });
    expect(elbow['verified']).toBe(false);
    expect(elbow['unverifiedDims']).toContain('pipe.wall');
  });

  it('load validation checks stored components and requires an approval block for approved / superseded specs', () => {
    const doc = importedDoc(smallSpec());
    const model = getSpecModel(doc);
    const spec = model.specs['SMALL']?.[0];
    if (spec === undefined) throw new Error('missing');
    const check = (over: Json): string[] => pipeSpecErrors({ specs: { SMALL: [{ ...spec, ...over }] }, specOrder: ['SMALL'] });
    expect(check({})).toEqual([]);
    expect(check({ components: [5] })[0]).toContain('component object');
    expect(check({ components: [{ ...spec.components[0], type: 'sprocket' }] })[0]).toContain('type');
    expect(check({ components: [{ ...spec.components[0], from: {} }] })[0]).toContain('from / to');
    expect(check({ status: 'approved' })[0]).toContain('approval');
    expect(check({ status: 'superseded', approval: { signer: 'a' } })[0]).toContain('approval');
    expect(check({ status: 'approved', approval: { signer: 'a', signatureId: 's', at: 't' } })).toEqual([]);
    const forged = JSON.parse(serializeDocument(withSpecModel(doc, model)));
    forged.document.plant.spec.specs['SMALL'][0].status = 'approved';
    expect(() => deserializeDocument(JSON.stringify(forged))).toThrow();
  });

  it('catalogRef matches whole ids or id + "-": asme-b16.2 and asme-b16.1 do not reach the B16.20 / B16.10 families', () => {
    const spec = smallSpec();
    const base = (spec['components'] as Json[]).slice(0, 1);
    const doc = importedDoc({
      ...spec,
      components: [
        ...base,
        { id: 'G', type: 'gasketSpiralWound', fromNps: 2, toNps: 6, class: 150, catalogRef: 'asme-b16.2' },
        { id: 'V', type: 'valveGate', fromNps: 2, toNps: 6, class: 150, ends: 'FL', catalogRef: 'asme-b16.1' },
        { id: 'G2', type: 'gasketSpiralWound', fromNps: 2, toNps: 6, class: 150, priority: 1, catalogRef: 'asme-b16.20' },
      ],
    });
    const run = (type: string): Json => data<Json>(doc, 'resolve_spec_component', { specId: 'SMALL', type, nps: 4 });
    expect(run('valveGate')['warnings']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PSC_CATALOG_FAMILY_MISSING' })]));
    expect(run('gasketSpiralWound')).toMatchObject({ componentId: 'G2', familyId: 'asme-b16.20-spiral-wound' });
  });

  it('a pipe bound by DN is protected by PSC_SPEC_IN_USE', () => {
    const base = importedDoc(smallSpec());
    const bound = withPipe(base, 'pipe-dn', 73, {
      specId: 'SMALL',
      revision: 1,
      nps: '50',
      odMm: 60.3,
      wallMm: 3.9,
      dimensionalStandard: 'ASME',
      verified: true,
    });
    expectRefusal(bound, 'edit_pipe_spec', { specId: 'SMALL', ops: [{ op: 'removeComponent', id: 'P' }] }, 'PSC_SPEC_IN_USE');
  });

  it('bytes counts UTF-8 bytes, not characters', () => {
    const doc = importedDoc(smallSpec({ title: 'Röhre ø 60 – Ü' }));
    const exported = exportText(doc, 'SMALL');
    expect(exported.bytes).toBe(new TextEncoder().encode(exported.text).length);
    expect(exported.bytes).toBeGreaterThan(exported.text.length);
  });

  it('a branch component (olet) is checked at every branch size up to the header, not only the first', () => {
    const spec = smallSpec();
    const doc = importedDoc({
      ...spec,
      components: [
        ...(spec['components'] as Json[]),
        { id: 'W', type: 'weldolet', fromNps: 2, toNps: 6, branchFromNps: 2, branchToNps: 4, catalogRef: 'asme-b16.9' },
      ],
    });
    const checked = data<{ issues: Array<{ code: string; ids: string[] }> }>(doc, 'check_pipe_spec', { specId: 'SMALL' });
    expect(checked.issues.some((issue) => issue.ids.includes('W'))).toBe(true);
  });
});
