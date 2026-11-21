/**
 * Plant 08 DAT-VIS-FU3: import_bcf / import_bcf_viewpoint resolve a Component that carries an IfcGuid but no (or an unknown) AuthoringToolId to
 * entities through the export_ifc GlobalId derivation, and name the GlobalIds that resolve to nothing.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { documentProjection } from '@core/plugins/host';
import { uint8ArrayToBase64 } from '@lib/base64';
import { zipStore, type ZipEntry } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import type { CadDocument } from '@core/model/types';
import { foreignGuid, viewpointWith } from '../../helpers/hostile/bcfReaders';
import { apply, data } from '../../helpers/commandAssertions';
import { scDat02Document } from '../plant/data/dataFixtures';

const CAMERA = { projection: 'perspective', eye: [0, -8000, 3000], direction: [0, 1, -0.3], fovDeg: 50 };
const TOPIC = '11111111-1111-4111-8111-111111111111';
const VP = '22222222-2222-4222-8222-222222222222';
const FOREIGN = 'ZZZZZZZZZZZZZZZZZZZZZZ';

/** SC-DAT-02 (pump, vessel, routed pipes with valves) + a steel frame with moment connections. */
function baseDocument(): CadDocument {
  let doc = scDat02Document();
  const add = (params: Record<string, unknown>): void => {
    doc = apply(doc, 'add_steel_member', params);
  };
  add({ profile: 'HEA300', role: 'column', start: [30000, 0, 0], end: [30000, 0, 6000] });
  add({ profile: 'IPE400', role: 'rafter', start: [30000, 0, 6000], end: [36000, 0, 6600] });
  doc = apply(doc, 'add_moment_connections', {});
  return doc;
}

const selectable = (doc: CadDocument): string[] => [
  ...Object.values(doc.building?.elements ?? {}).flatMap((element) => element.entityIds),
  ...Object.values(doc.plant?.piping?.entityIds ?? {}).flat(),
];

function withIssue(doc: CadDocument): CadDocument {
  const withView = apply(doc, 'save_viewpoint', { name: 'v', camera: CAMERA });
  return apply(withView, 'create_review_issue', { title: 'All', viewpointIds: ['vp-1'], entityIds: selectable(doc) });
}

/** The BCF of `doc` with every AuthoringToolId replaced (`rewrite`), so only the IfcGuid names the entity. */
function bcfOf(doc: CadDocument, schema: 'IFC4' | 'IFC4X3_ADD2', rewrite: (id: string, index: number) => string, extra = ''): string {
  const exported = data<{ base64: string }>(doc, 'export_bcf', { snapshots: false, ifcSchema: schema });
  const entries: ZipEntry[] = unzip(Buffer.from(exported.base64, 'base64')).map((entry) => {
    if (!entry.name.endsWith('.bcfv')) return { name: entry.name, data: entry.data };
    let index = 0;
    const xml = new TextDecoder()
      .decode(entry.data)
      .replace(
        /<AuthoringToolId>([^<]*)<\/AuthoringToolId>/g,
        (_, id: string) => `<AuthoringToolId>${rewrite(id, index++)}</AuthoringToolId>`,
      )
      .replace('</Selection>', `${extra}</Selection>`);
    return { name: entry.name, data: new TextEncoder().encode(xml) };
  });
  return uint8ArrayToBase64(zipStore(entries));
}

describe('import_bcf resolves IfcGuid components', () => {
  const base = baseDocument();
  const source = withIssue(base);
  const expected = [...new Set(selectable(base))].sort();

  it.each(['IFC4', 'IFC4X3_ADD2'] as const)('round trip %s: export then import (ids scrambled) selects the same entities', (schema) => {
    const unmappedIds = data<{ warnings: Array<{ code: string; ids: string[] }> }>(source, 'export_bcf', {
      snapshots: false,
    }).warnings.flatMap((warning) => (warning.code === 'VIS_BCF_GUID_UNMAPPED' ? warning.ids : []));
    const resolvable = expected.filter((id) => !unmappedIds.includes(id));
    expect(resolvable.length).toBeGreaterThan(5);
    const result = execute(base, 'import_bcf', { bcf: bcfOf(source, schema, (id) => `gone-${id}`) });
    expect(result.rejected).toBeUndefined();
    const selection = [...(result.document.review?.viewpoints['vp-1']?.selection ?? [])].sort();
    expect(selection).toEqual(resolvable);
    expect((result.data as { unresolvedGuids: string[] }).unresolvedGuids).toEqual([]);
  });

  it('a Component with no AuthoringToolId and a foreign IfcGuid is reported by name', () => {
    const extra = `<Component IfcGuid="${FOREIGN}"/>`;
    const bcf = bcfOf(source, 'IFC4', (id) => id, extra);
    const result = execute(base, 'import_bcf', { bcf });
    const imported = result.data as { unresolvedGuids: string[]; warnings: Array<{ code: string; message: string }> };
    expect(imported.unresolvedGuids).toEqual([FOREIGN]);
    const warning = imported.warnings.find((entry) => entry.code === 'VIS_BCF_GUID_UNRESOLVED');
    expect(warning?.message).toContain(FOREIGN);
    expect(imported.warnings.some((entry) => entry.code === 'VIS_BCF_GUID_UNMAPPED')).toBe(true);
  });

  it('an unknown AuthoringToolId with a known IfcGuid resolves; with a foreign IfcGuid it is unresolved', () => {
    const equipmentId = Object.values(base.building?.elements ?? {}).find((element) => element.category === 'equipment')
      ?.entityIds[0] as string;
    const guid = documentProjection('ifcGuids')?.(base, equipmentId, 'IFC4')[0] as string;
    expect(guid).toHaveLength(22);
    const xml = (ifcGuid: string): string =>
      '<?xml version="1.0"?><VisualizationInfo Guid="g"><Components><Selection>' +
      `<Component IfcGuid="${ifcGuid}"><OriginatingSystem>llull</OriginatingSystem><AuthoringToolId>no-such-id</AuthoringToolId></Component>` +
      '</Selection></Components><PerspectiveCamera><CameraViewPoint><X>0</X><Y>-8</Y><Z>3</Z></CameraViewPoint><CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>' +
      '<CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>50</FieldOfView></PerspectiveCamera></VisualizationInfo>';
    const known = execute(base, 'import_bcf_viewpoint', { visualizationInfo: xml(guid), name: 'k' });
    expect(known.data).toMatchObject({ unmapped: 0, unresolvedGuids: [] });
    expect(known.document.review?.viewpoints['vp-1']?.selection).toContain(equipmentId);
    const foreign = execute(base, 'import_bcf_viewpoint', { visualizationInfo: xml(FOREIGN), name: 'f' });
    expect(foreign.data).toMatchObject({ unmapped: 1, unresolvedGuids: [FOREIGN] });
    expect(foreign.summary).toContain(FOREIGN);
  });

  it('is pure: the target document is not modified', () => {
    const before = JSON.stringify(base);
    execute(base, 'import_bcf', { bcf: bcfOf(source, 'IFC4', (id) => `gone-${id}`) });
    expect(JSON.stringify(base)).toBe(before);
  });

  it('hostile IfcGuid text: malformed values are unmapped and never echoed; listings are bounded', () => {
    const huge = 'A'.repeat(1_000_000);
    const one = execute(base, 'import_bcf_viewpoint', {
      visualizationInfo: viewpointWith([`<Component IfcGuid="${huge}"></Component>`]),
      name: 'h',
    });
    expect(one.data).toMatchObject({ unmapped: 1, unresolvedGuids: [], unresolvedCount: 0 });
    expect(one.summary.length).toBeLessThan(400);
    const malformed = execute(base, 'import_bcf_viewpoint', {
      visualizationInfo: viewpointWith(['<Component IfcGuid="short-and-odd"></Component>']),
      name: 'm',
    });
    expect(malformed.data).toMatchObject({ unmapped: 1, unresolvedGuids: [] });
    expect(malformed.summary).not.toContain('short-and-odd');
    const many = execute(base, 'import_bcf_viewpoint', {
      visualizationInfo: viewpointWith(Array.from({ length: 20_000 }, (_, k) => `<Component IfcGuid="${foreignGuid(k)}"></Component>`)),
      name: 'many',
    });
    const manyData = many.data as { unresolvedGuids: string[]; unresolvedCount: number };
    expect(manyData.unresolvedCount).toBe(20_000);
    expect(manyData.unresolvedGuids).toHaveLength(100);
    expect(JSON.stringify(many.data).length).toBeLessThan(5000);
    expect(many.summary.length).toBeLessThan(500);
  });

  it('import_bcf bounds the warning and data for 20,000 foreign IfcGuid values', () => {
    const xml = viewpointWith(Array.from({ length: 20_000 }, (_, k) => `<Component IfcGuid="${foreignGuid(k)}"></Component>`));
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const entries: ZipEntry[] = [
      { name: 'bcf.version', data: encode('<?xml version="1.0"?><Version VersionId="3.0" />') },
      {
        name: `${TOPIC}/markup.bcf`,
        data: encode(
          `<?xml version="1.0"?><Markup><Topic Guid="${TOPIC}" TopicType="Issue"><Title>t</Title><Viewpoints><ViewPoint Guid="${VP}"><Viewpoint>v.bcfv</Viewpoint></ViewPoint></Viewpoints></Topic></Markup>`,
        ),
      },
      { name: `${TOPIC}/v.bcfv`, data: encode(xml) },
    ];
    const result = execute(base, 'import_bcf', { bcf: uint8ArrayToBase64(zipStore(entries)) });
    const imported = result.data as { unresolvedGuids: string[]; warnings: Array<{ code: string; message: string }> };
    expect(imported.unresolvedGuids).toHaveLength(100);
    const warning = imported.warnings.find((entry) => entry.code === 'VIS_BCF_GUID_UNRESOLVED');
    expect(warning?.message).toContain('20000 component(s)');
    expect(warning?.message.length).toBeLessThan(3000);
    expect(JSON.stringify(result.data).length).toBeLessThan(8000);
    expect(result.summary.length).toBeLessThan(500);
  });
});
