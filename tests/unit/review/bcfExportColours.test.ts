/**
 * Plant 09 VIS-FU: `export_bcf` BCF 2.1 export, the viewpoint colouring (profile + material-class colours as Coloring and in the snapshots) and
 * `VIS_BCF_COLOURING_LARGE` (over 1000 coloured components in a viewpoint: legend labels instead of Coloring).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { readXml, xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { unzip } from '@lib/zipRead';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { MAX_COLOURED_COMPONENTS } from '@core/commands/exchange/bcf/bcfColouring';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result.document;
}

interface Bcf {
  base64: string;
  version: string;
  topics: number;
  viewpoints: number;
  snapshots: number;
  coloured: number;
  sha256: string;
  warnings: Array<{ code: string; ids: string[]; counts?: number[] }>;
}

const PROFILE = {
  id: 'by-kind',
  name: 'By kind',
  rules: [{ id: 'boxes', when: { property: 'kind', equals: 'box' }, colour: '#336699', legend: 'Boxes' }],
};

/** Two boxes (red) and a cylinder, a viewpoint and one issue on it; the profile `by-kind` colours the boxes when `profiled`. */
function scene(profiled: boolean): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'add_box', { size: [20, 10, 8], color: '#d04020' });
  doc = run(doc, 'add_box', { size: [6, 6, 6], position: [30, 0, 0], color: '#d04020' });
  doc = run(doc, 'add_cylinder', { radius: 4, height: 15, position: [-20, 0, 0], color: '#20d040' });
  doc = run(doc, 'save_viewpoint', {
    name: 'south',
    camera: { projection: 'perspective', eye: [0, -80, 30], direction: [0, 1, -0.3], fovDeg: 50 },
  });
  doc = run(doc, 'save_viewpoint', {
    name: 'plan',
    camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 80 },
  });
  doc = run(doc, 'create_review_issue', {
    title: 'Clearance',
    labels: ['piping', 'a&b'],
    description: 'see <view>',
    assignedTo: 'jo@example.com',
    dueDate: '2026-12-01',
    viewpointIds: ['vp-1', 'vp-2'],
    entityIds: [doc.order[0] ?? ''],
  });
  doc = run(doc, 'add_review_comment', { issueId: 'iss-3', text: 'Moved the pump', viewpointId: 'vp-2' });
  if (!profiled) return doc;
  return run(run(doc, 'define_colour_profile', PROFILE), 'set_active_colour_profile', { profileId: 'by-kind' });
}

const exportBcf = (doc: CadDocument, params: Record<string, unknown> = {}): { data: Bcf; files: Map<string, string> } => {
  const result = execute(doc, 'export_bcf', { snapshotWidth: 64, snapshotHeight: 48, ...params });
  expect(result.rejected, result.summary).toBeUndefined();
  const data = result.data as Bcf;
  const files = new Map<string, string>();
  const entries = unzip(Buffer.from(data.base64, 'base64'));
  for (const entry of Array.isArray(entries) ? entries : []) files.set(entry.name, Buffer.from(entry.data).toString('latin1'));
  return { data, files };
};
const named = (files: Map<string, string>, suffix: string): string[] =>
  [...files].filter(([name]) => name.endsWith(suffix)).map(([, text]) => text);
const parsed = (text: string): XmlElement => {
  const out = readXml(text, { maxChars: 1e7, maxDepth: 64, maxElements: 1e6 });
  expect(out.ok).toBe(true);
  return (out as { ok: true; root: XmlElement }).root;
};

describe('export_bcf version 2.1', () => {
  const { data, files } = exportBcf(scene(false), { version: '2.1' });

  it('writes the 2.1 layout: DetailedVersion, no extensions.xml, unwrapped Labels / Comment, Viewpoints Guid, no AspectRatio', () => {
    expect(data).toMatchObject({ version: '2.1', topics: 1, viewpoints: 2, snapshots: 2 });
    expect(files.get('bcf.version')).toContain('<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>');
    expect(files.has('extensions.xml')).toBe(false);
    const markup = named(files, '/markup.bcf')[0] ?? '';
    expect(markup).toContain('<Labels>piping</Labels><Labels>a&amp;b</Labels>');
    expect(markup).not.toContain('<Comments>');
    expect(markup).toMatch(/<\/Topic><Comment Guid="[^"]+"><Date>/);
    expect(markup.match(/<Viewpoints Guid="/g)).toHaveLength(2);
    expect(markup).not.toContain('<ViewPoint ');
    for (const view of named(files, '.bcfv')) expect(view).not.toContain('AspectRatio');
    expect(parsed(markup).local).toBe('Markup');
  });

  it('is read back by import_bcf (topic, labels, both viewpoints, the comment)', () => {
    const source = scene(false);
    const imported = execute({ ...source, review: undefined } as unknown as CadDocument, 'import_bcf', {
      bcf: exportBcf(source, { version: '2.1' }).data.base64,
    });
    expect(imported.rejected, imported.summary).toBeUndefined();
    expect(imported.data).toMatchObject({ topics: 1, created: 1, viewpoints: 2, comments: 1, warnings: [] });
    const issue = Object.values(imported.document.review?.issues ?? {})[0];
    expect(issue).toMatchObject({ title: 'Clearance', labels: ['piping', 'a&b'], assignedTo: 'jo@example.com' });
  });

  it('is deterministic and the default stays 3.0', () => {
    expect(exportBcf(scene(false), { version: '2.1' }).data.sha256).toBe(data.sha256);
    expect(exportBcf(scene(false)).data.version).toBe('3.0');
    expect(exportBcf(scene(false)).files.has('extensions.xml')).toBe(true);
  });
});

describe('export_bcf viewpoint colouring', () => {
  it('writes the profile colours as Coloring (3.0: Color / Components / Component; 2.1: Color / Component) and counts them', () => {
    const doc = scene(true);
    const boxes = doc.order.filter((id) => doc.entities[id]?.kind === 'box');
    const v3 = exportBcf(doc);
    expect(v3.data.coloured).toBe(4);
    for (const view of named(v3.files, '.bcfv')) {
      const coloring = xmlChildren(xmlChildren(parsed(view), 'Components')[0] as XmlElement, 'Coloring')[0] as XmlElement;
      const color = xmlChildren(coloring, 'Color')[0] as XmlElement;
      expect(xmlAttr(color, 'Color')).toBe('336699');
      const members = xmlChildren(xmlChildren(color, 'Components')[0] as XmlElement, 'Component');
      expect(members).toHaveLength(2);
      expect(view).toContain(`<AuthoringToolId>${boxes[0]}</AuthoringToolId>`);
    }
    const v21 = exportBcf(doc, { version: '2.1' });
    for (const view of named(v21.files, '.bcfv')) {
      const color = xmlChildren(
        xmlChildren(xmlChildren(parsed(view), 'Components')[0] as XmlElement, 'Coloring')[0] as XmlElement,
        'Color',
      )[0] as XmlElement;
      expect(xmlChildren(color, 'Components')).toHaveLength(0);
      expect(xmlChildren(color, 'Component')).toHaveLength(2);
    }
  });

  it('draws the snapshots with the colours: the archive differs from colours: false, which equals an export without a profile', () => {
    const profiled = exportBcf(scene(true));
    const plain = exportBcf(scene(true), { colours: false });
    expect(profiled.data.sha256).not.toBe(plain.data.sha256);
    expect(plain.data.coloured).toBe(0);
    expect(named(plain.files, '.bcfv').every((view) => !view.includes('<Coloring>'))).toBe(true);
    expect(plain.data.sha256).toBe(exportBcf(scene(false)).data.sha256);
  });

  it('a material class colour is written as a Coloring Color and counted', () => {
    let doc = scene(false);
    doc = run(doc, 'define_material_class', { id: 'painted', colour: '#ffcc00', metalness: 0.2, roughness: 0.6 });
    doc = run(doc, 'assign_material_class', { classId: 'painted', entityIds: [doc.order[2] ?? ''] });
    const out = exportBcf(doc);
    expect(out.data.coloured).toBe(2);
    expect(named(out.files, '.bcfv')[0]).toContain('<Color Color="FFCC00">');
  });

  it('refuses a viewpoint whose profile no longer exists with VIS_PROFILE_NOT_FOUND', () => {
    const saved = execute(scene(true), 'save_viewpoint', {
      name: 'profiled',
      camera: { projection: 'perspective', eye: [0, -80, 30], direction: [0, 1, -0.3], fovDeg: 50 },
      colourProfileId: 'by-kind',
    });
    expect(saved.rejected, saved.summary).toBeUndefined();
    const withProfile = run(saved.document, 'create_review_issue', { title: 'Third', viewpointIds: [saved.affected[0] ?? ''] });
    const gone = {
      ...withProfile,
      display: { ...withProfile.display, colourProfiles: {}, activeProfileId: undefined },
    } as unknown as CadDocument;
    const result = execute(gone, 'export_bcf', { snapshots: false });
    expect(result.error?.code).toBe('VIS_PROFILE_NOT_FOUND');
    expect(result.document).toBe(gone);
    expect(execute(gone, 'export_bcf', { snapshots: false, colours: false }).rejected).toBeUndefined();
  });

  it('is pure', () => {
    const doc = scene(true);
    const before = structuredClone(doc);
    execute(doc, 'export_bcf', { snapshots: false });
    expect(doc).toEqual(before);
  });
});

describe('VIS_BCF_COLOURING_LARGE', () => {
  /** `count` boxes coloured by the profile, one viewpoint and one issue on it. */
  function crowded(count: number): CadDocument {
    let doc = createEmptyDocument();
    doc = run(doc, 'add_box', { size: [1, 1, 1] });
    const box = doc.entities[doc.order[0] ?? ''];
    expect(box).toBeDefined();
    const entities = { ...doc.entities };
    const order = [...doc.order];
    for (let i = 1; i < count; i++) {
      const id = `bulk-${i}`;
      entities[id] = { ...(box as NonNullable<typeof box>), id };
      order.push(id);
    }
    doc = { ...doc, entities, order };
    doc = run(doc, 'define_colour_profile', PROFILE);
    doc = run(doc, 'set_active_colour_profile', { profileId: 'by-kind' });
    doc = run(doc, 'save_viewpoint', {
      name: 'v',
      camera: { projection: 'perspective', eye: [0, -80, 30], direction: [0, 1, -0.3], fovDeg: 50 },
    });
    return run(doc, 'create_review_issue', { title: 'Many', viewpointIds: ['vp-1'] });
  }

  it(`${MAX_COLOURED_COMPONENTS} coloured components are still written; one more writes the profile as legend labels and warns`, () => {
    const exact = exportBcf(crowded(MAX_COLOURED_COMPONENTS), { snapshots: false });
    expect(exact.data.coloured).toBe(MAX_COLOURED_COMPONENTS);
    expect(exact.data.warnings).toEqual([]);
    expect(named(exact.files, '.bcfv')[0]).toContain('<Coloring>');
    const over = exportBcf(crowded(MAX_COLOURED_COMPONENTS + 1), { snapshots: false });
    expect(over.data.warnings).toEqual([{ code: 'VIS_BCF_COLOURING_LARGE', ids: ['vp-1'], counts: [MAX_COLOURED_COMPONENTS + 1] }]);
    expect(over.data.coloured).toBe(0);
    expect(named(over.files, '.bcfv')[0]).not.toContain('<Coloring>');
    expect(named(over.files, '/markup.bcf')[0]).toContain('<Labels><Label>Boxes (#336699)</Label></Labels>');
    expect(over.files.get('extensions.xml')).toContain('<TopicLabel>Boxes (#336699)</TopicLabel>');
    const old = exportBcf(crowded(MAX_COLOURED_COMPONENTS + 1), { snapshots: false, version: '2.1' });
    expect(named(old.files, '/markup.bcf')[0]).toContain('<Labels>Boxes (#336699)</Labels>');
    expect(execute(crowded(MAX_COLOURED_COMPONENTS + 1), 'export_bcf', { snapshots: false }).summary).toContain('VIS_BCF_COLOURING_LARGE');
  });
});
