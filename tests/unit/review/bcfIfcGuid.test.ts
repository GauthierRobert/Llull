/**
 * Plant 08 DAT-VIS-FU2 / 09 §12.19: components of building elements carry the IFC GlobalId the IFC export writes for the element, so a BCF topic /
 * viewpoint and the IFC file name the same objects. Oracle: the GlobalId read back from the exported IFC text, not recomputed.
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { readXml, xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { unzip } from '@lib/zipRead';
import { readStep, stepString } from '@lib/stepRead';
import { documentProjection } from '@core/plugins/host';
import { apply, data } from '../../helpers/commandAssertions';
import { drawHouseWalls } from '../../helpers/runFixtures';

function houseWithIssue(): CadDocument {
  let doc = apply(createEmptyDocument(), 'add_level', { name: 'Ground' });
  doc = drawHouseWalls(doc);
  doc = apply(doc, 'add_box', { size: [10, 10, 10] });
  doc = apply(doc, 'save_viewpoint', {
    name: 'south',
    camera: { projection: 'perspective', eye: [0, -80, 30], direction: [0, 1, -0.3], fovDeg: 50 },
  });
  const wallEntity = Object.values(doc.building?.elements ?? {}).find((element) => element.id === 'wall-1')?.entityIds[0] ?? '';
  const box = doc.order.find((id) => id.startsWith('box-')) ?? '';
  return apply(doc, 'create_review_issue', { title: 'Wall', viewpointIds: ['vp-1'], entityIds: [wallEntity, box] });
}

function viewpointComponents(doc: CadDocument, version: '3.0' | '2.1'): XmlElement[] {
  const exported = data<{ base64: string; warnings: Array<{ code: string; ids: string[] }> }>(doc, 'export_bcf', {
    snapshots: false,
    version,
  });
  const entries = unzip(Buffer.from(exported.base64, 'base64'));
  const entry = entries.find((item) => item.name.endsWith('.bcfv'));
  const parsed = readXml(new TextDecoder().decode(entry?.data ?? new Uint8Array()));
  if (!parsed.ok) throw new Error('bad xml');
  const holder = xmlChildren(parsed.root, 'Components')[0] as XmlElement;
  const selection = xmlChildren(holder, 'Selection')[0] as XmlElement;
  return xmlChildren(selection, 'Component');
}

describe('export_bcf IfcGuid', () => {
  it('writes the GlobalId of the IFC export for building components and none for plain solids', () => {
    const doc = houseWithIssue();
    const ifc = data<{ ifc: string }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00' }).ifc;
    const walls = [...readStep(ifc).entities.values()].filter((entity) => entity.type === 'IFCWALL');
    const wallGuids = walls.map((entity) => stepString(entity.args[0] as string));
    for (const version of ['3.0', '2.1'] as const) {
      const components = viewpointComponents(doc, version);
      expect(components).toHaveLength(2);
      const guid = xmlAttr(components[0] as XmlElement, 'IfcGuid');
      expect(guid).toHaveLength(22);
      expect(wallGuids).toContain(guid);
      expect(xmlAttr(components[1] as XmlElement, 'IfcGuid')).toBeUndefined();
    }
  });

  it('lists only the entities without a GlobalId in VIS_BCF_GUID_UNMAPPED and is deterministic', () => {
    const doc = houseWithIssue();
    const first = data<{ sha256: string; warnings: Array<{ code: string; ids: string[] }> }>(doc, 'export_bcf', { snapshots: false });
    const unmapped = first.warnings.find((warning) => warning.code === 'VIS_BCF_GUID_UNMAPPED');
    expect(unmapped?.ids).toHaveLength(1);
    expect(unmapped?.ids[0]).toBe(doc.order.find((id) => id.startsWith('box-')));
    expect(data<{ sha256: string }>(doc, 'export_bcf', { snapshots: false }).sha256).toBe(first.sha256);
  });

  it('a document without a building keeps AuthoringToolId only and is not modified', () => {
    let doc = apply(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    doc = apply(doc, 'save_viewpoint', {
      name: 'v',
      camera: { projection: 'perspective', eye: [0, -80, 30], direction: [0, 1, -0.3], fovDeg: 50 },
    });
    doc = apply(doc, 'create_review_issue', { title: 'Box', viewpointIds: ['vp-1'], entityIds: [doc.order[0] ?? ''] });
    const before = JSON.stringify(doc);
    const components = viewpointComponents(doc, '3.0');
    expect(xmlAttr(components[0] as XmlElement, 'IfcGuid')).toBeUndefined();
    expect(JSON.stringify(doc)).toBe(before);
    expect(documentProjection('ifcGuids')?.(doc, 'nothing', 'IFC4')).toEqual([]);
    expect(execute(doc, 'export_bcf', { snapshots: false }).rejected).toBeUndefined();
  });
});
