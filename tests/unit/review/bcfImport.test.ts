/** import_bcf / import_bcf_viewpoint / export_bcf_viewpoint (VIS-M5): round trip, merge policies, BCF 2.1, the human gate, hostile archives, VC-VIS-15 structure. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { uint8ArrayToBase64 } from '@lib/base64';
import { readXml, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { type ZipEntry, zipStore } from '@lib/zip';
import { unzip } from '@lib/zipRead';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_VP = '22222222-2222-4222-8222-222222222222';
const GUID_B = '33333333-3333-4333-8333-333333333333';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = execute(doc, name, params);
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result.document;
}

function reviewed(): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'add_box', { size: [20, 10, 8] });
  doc = run(doc, 'add_cylinder', { radius: 4, height: 15, position: [20, 0, 0] });
  doc = run(doc, 'save_viewpoint', {
    name: 'south',
    camera: { projection: 'perspective', eye: [0, -60, 20], direction: [0, 1, -0.3], fovDeg: 50 },
  });
  doc = run(doc, 'save_viewpoint', {
    name: 'plan',
    camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 60 },
  });
  doc = run(doc, 'create_review_issue', {
    title: 'Clearance < 50 & nozzle',
    type: 'Clash',
    priority: 'high',
    labels: ['piping', 'a&b'],
    description: 'see <view>',
    assignedTo: 'jo@example.com',
    dueDate: '2026-12-01',
    viewpointIds: ['vp-1', 'vp-2'],
    entityIds: [doc.order[0] ?? ''],
  });
  doc = run(doc, 'add_review_comment', { issueId: 'iss-3', text: 'Moved <the> pump', viewpointId: 'vp-2' });
  return run(doc, 'add_review_comment', { issueId: 'iss-3', text: 'Second remark' });
}

const exported = (doc: CadDocument, params: Record<string, unknown> = {}): string =>
  (execute(doc, 'export_bcf', { snapshots: false, ...params }).data as { base64: string }).base64;

interface Imported {
  topics: number;
  created: number;
  updated: number;
  skipped: number;
  viewpoints: number;
  comments: number;
  issueIds: string[];
  warnings: { code: string; message: string }[];
}

const stripped = (doc: CadDocument): CadDocument => ({ ...doc, review: undefined }) as unknown as CadDocument;

const markup = (topicAttrs: string, body: string): string =>
  `${HEAD}<Markup><Topic Guid="${GUID_A}" ${topicAttrs}>${body}</Topic></Markup>`;
const visinfo = (camera: string, components = ''): string =>
  `${HEAD}<VisualizationInfo Guid="${GUID_VP}">${components}${camera}</VisualizationInfo>`;
const CAMERA = `<PerspectiveCamera><CameraViewPoint><X>1</X><Y>-2</Y><Z>3</Z></CameraViewPoint><CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection><CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector><FieldOfView>60</FieldOfView></PerspectiveCamera>`;

function archive(entries: ZipEntry[], version = '3.0'): string {
  return uint8ArrayToBase64(zipStore([{ name: 'bcf.version', data: enc(`${HEAD}<Version VersionId="${version}" />`) }, ...entries]));
}

describe('import_bcf round trip with export_bcf', () => {
  it('reads back the topics, viewpoints in document units, entity selection and comments', () => {
    const source = reviewed();
    const target = stripped(source);
    const result = execute(target, 'import_bcf', { bcf: exported(source) });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Imported;
    expect(data).toMatchObject({ topics: 1, created: 1, updated: 0, skipped: 0, viewpoints: 2, comments: 2 });
    expect(data.warnings).toEqual([]);
    expect(result.affected).toEqual(['iss-3']);
    const before = source.review?.issues['iss-3'];
    const after = result.document.review?.issues['iss-3'];
    expect(after).toMatchObject({
      guid: before?.guid,
      title: before?.title,
      type: 'Clash',
      priority: 'high',
      status: 'open',
      labels: ['piping', 'a&b'],
      description: 'see <view>',
      assignedTo: 'jo@example.com',
      dueDate: '2026-12-01',
      entityIds: before?.entityIds,
      history: [],
    });
    const cameras = (doc: CadDocument, ids: readonly string[] | undefined): unknown[] =>
      (ids ?? []).map((id) => doc.review?.viewpoints[id]?.camera);
    const original = cameras(source, before?.viewpointIds) as unknown as { projection: string; eye: number[] }[];
    const restored = cameras(result.document, after?.viewpointIds) as { eye: number[] }[];
    expect(restored).toHaveLength(2);
    original.forEach((camera, index) => {
      expect(restored[index]).toMatchObject({ projection: camera.projection });
      camera.eye.forEach((value, axis) => expect(restored[index]?.eye[axis]).toBeCloseTo(value, 9));
    });
    expect(restored[0]).toMatchObject({ fovDeg: 50 });
    expect(restored[1]).toMatchObject({ viewHeight: 60 });
    const comments = Object.values(result.document.review?.comments ?? {});
    expect(comments.map((comment) => comment.text)).toEqual(['Moved <the> pump', 'Second remark']);
    expect(comments[0]?.viewpointId).toBe(after?.viewpointIds[1]);
    expect(comments[1]?.viewpointId).toBeUndefined();
  });

  it('exports again to the same topic content (export, import, export)', () => {
    const source = reviewed();
    const imported = execute(stripped(source), 'import_bcf', { bcf: exported(source) }).document;
    const topicXml = (doc: CadDocument): string => {
      const bytes = Buffer.from(exported(doc), 'base64');
      return Buffer.from(unzip(bytes).find((entry) => entry.name.endsWith('/markup.bcf'))?.data ?? []).toString();
    };
    const normalise = (text: string): string => text.replace(/Guid="[^"]+"/g, 'Guid=""').replace(/[0-9a-f-]{36}.bcfv/g, 'vp.bcfv');
    expect(normalise(topicXml(imported))).toBe(normalise(topicXml(source)));
  });

  it('is pure and changes only the review section', () => {
    const source = reviewed();
    const target = stripped(source);
    const before = JSON.stringify(target);
    const result = execute(target, 'import_bcf', { bcf: exported(source) });
    expect(JSON.stringify(target)).toBe(before);
    expect({ ...result.document, review: undefined }).toEqual(target);
  });
});

describe('import_bcf merge policy and the human gate', () => {
  it('skips a known topic by default and updates its fields with "update", keeping status and history', () => {
    const source = reviewed();
    const bcf = exported(source);
    const skipped = execute(source, 'import_bcf', { bcf });
    expect(skipped.data).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(skipped.document).toBe(source);
    expect(skipped.affected).toEqual([]);
    let edited = source;
    edited = {
      ...edited,
      review: {
        ...edited.review!,
        issues: { ...edited.review!.issues, 'iss-3': { ...edited.review!.issues['iss-3']!, title: 'renamed' } },
      },
    };
    const updated = execute(edited, 'import_bcf', { bcf, mergePolicy: 'update' });
    expect(updated.data).toMatchObject({ created: 0, updated: 1, comments: 0 });
    expect(updated.document.review?.issues['iss-3']).toMatchObject({ title: 'Clearance < 50 & nozzle', status: 'open' });
    expect(updated.document.review?.issues['iss-3']?.history).toHaveLength(0);
    expect(Object.keys(updated.document.review?.viewpoints ?? {})).toEqual(Object.keys(edited.review?.viewpoints ?? {}));
  });

  it('never imports a Closed or Resolved topic as anything but open with an empty history', () => {
    for (const status of ['Closed', 'Resolved']) {
      const bcf = archive([{ name: `${GUID_A}/markup.bcf`, data: enc(markup(`TopicStatus="${status}"`, '<Title>done</Title>')) }]);
      const result = execute(createEmptyDocument(), 'import_bcf', { bcf });
      expect(result.rejected, result.summary).toBeUndefined();
      expect(result.document.review?.issues['iss-1']).toMatchObject({ status: 'open', history: [] });
      expect((result.data as Imported).warnings.map((warning) => warning.code)).toContain('VIS_BCF_STATUS_RESET');
    }
  });

  it('keeps an imported issue behind the gate: closing it without a signature is refused', () => {
    const bcf = archive([{ name: `${GUID_A}/markup.bcf`, data: enc(markup('TopicStatus="Closed"', '<Title>done</Title>')) }]);
    const doc = execute(createEmptyDocument(), 'import_bcf', { bcf }).document;
    expect(execute(doc, 'set_issue_status', { issueId: 'iss-1', status: 'closed', reason: 'x' }).error?.code).toBe('VIS_HUMAN_GATE');
  });
});

describe('import_bcf reads BCF 2.1 and reports what it cannot map', () => {
  it('reads a 2.1 topic: markup-level Comment and Viewpoints, IfcGuid-only components, millisecond dates', () => {
    const topic =
      `${HEAD}<Markup><Topic Guid="${GUID_A}" TopicType="Issue" TopicStatus="Closed"><Title>Beam</Title><Priority>Major</Priority><Labels>Steel</Labels><Labels>L2</Labels>` +
      `<CreationDate>2020-01-01T00:00:00Z</CreationDate><DueDate>2026-02-03T10:00:00Z</DueDate><AssignedTo>x@y.z</AssignedTo></Topic>` +
      `<Comment Guid="${GUID_B}"><Date>2020-01-01T00:00:00Z</Date><Author>a@b.c</Author><Comment>hello</Comment><Viewpoint Guid="${GUID_VP}" /></Comment>` +
      `<Viewpoints Guid="${GUID_VP}"><Viewpoint>vp.bcfv</Viewpoint></Viewpoints></Markup>`;
    const components = `<Components><Selection><Component IfcGuid="0abc"><OriginatingSystem>Revit</OriginatingSystem></Component></Selection></Components>`;
    const bcf = archive(
      [
        { name: `${GUID_A}/markup.bcf`, data: enc(topic) },
        { name: `${GUID_A}/vp.bcfv`, data: enc(visinfo(CAMERA, components)) },
        { name: `${GUID_A}/snapshot.png`, data: new Uint8Array([1, 2, 3]) },
      ],
      '2.1',
    );
    const result = execute(createEmptyDocument(), 'import_bcf', { bcf });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Imported & { version: string };
    expect(data).toMatchObject({ version: '2.1', created: 1, viewpoints: 1, comments: 1 });
    expect(data.warnings.map((warning) => warning.code)).toEqual(['VIS_BCF_STATUS_RESET', 'VIS_BCF_GUID_UNMAPPED']);
    const issue = result.document.review?.issues['iss-2'];
    expect(issue).toMatchObject({ priority: 'high', labels: ['Steel', 'L2'], dueDate: '2026-02-03', assignedTo: 'x@y.z', entityIds: [] });
    const camera = result.document.review?.viewpoints['vp-1']?.camera;
    expect(camera).toMatchObject({ projection: 'perspective', fovDeg: 60, eye: [1000, -2000, 3000] });
    expect(Object.values(result.document.review?.comments ?? {})[0]).toMatchObject({ text: 'hello', viewpointId: 'vp-1', author: 'agent' });
  });

  it('skips a viewpoint with a bad camera or a missing file, keeping the topic', () => {
    const topic = markup(
      '',
      `<Title>t</Title><Viewpoints><ViewPoint Guid="${GUID_VP}"><Viewpoint>gone.bcfv</Viewpoint></ViewPoint><ViewPoint Guid="${GUID_B}"><Viewpoint>bad.bcfv</Viewpoint></ViewPoint></Viewpoints>`,
    );
    const bad = visinfo(CAMERA.replace('<FieldOfView>60</FieldOfView>', '<FieldOfView>400</FieldOfView>'));
    const result = execute(createEmptyDocument(), 'import_bcf', {
      bcf: archive([
        { name: `${GUID_A}/markup.bcf`, data: enc(topic) },
        { name: `${GUID_A}/bad.bcfv`, data: enc(bad) },
      ]),
    });
    const data = result.data as Imported;
    expect(data).toMatchObject({ created: 1, viewpoints: 0 });
    expect(data.warnings.filter((warning) => warning.code === 'VIS_BCF_VIEWPOINT_SKIPPED')).toHaveLength(2);
  });

  it('skips topics without a valid Guid or title, and duplicate topics', () => {
    const bcf = archive([
      { name: `${GUID_A}/markup.bcf`, data: enc(markup('', '<Title>ok</Title>')) },
      { name: `${GUID_B}/markup.bcf`, data: enc(markup('', '<Title>twin</Title>')) },
      { name: 'x/markup.bcf', data: enc(`${HEAD}<Markup><Topic Guid="nope"><Title>t</Title></Topic></Markup>`) },
      { name: 'y/markup.bcf', data: enc(`${HEAD}<Markup><Topic Guid="${GUID_B}"><Title> </Title></Topic></Markup>`) },
      { name: 'z/markup.bcf', data: enc(`${HEAD}<Markup />`) },
      { name: 'w/markup.bcf', data: enc('<Markup') },
    ]);
    const data = execute(createEmptyDocument(), 'import_bcf', { bcf }).data as Imported;
    expect(data).toMatchObject({ created: 1, topics: 1 });
    expect(data.warnings.filter((warning) => warning.code === 'VIS_BCF_TOPIC_SKIPPED').length).toBe(5);
  });
});

describe('import_bcf refuses hostile input', () => {
  const code = (bcf: string): string | undefined => execute(createEmptyDocument(), 'import_bcf', { bcf }).error?.code;
  const topic = { name: `${GUID_A}/markup.bcf`, data: enc(markup('', '<Title>t</Title>')) };

  it('rejects what is not a BCF zip (VIS_BCF_PARSE)', () => {
    expect(code('not base64!')).toBe('VIS_BCF_PARSE');
    expect(code(uint8ArrayToBase64(enc('plain text, not a zip')))).toBe('VIS_BCF_PARSE');
    expect(code(uint8ArrayToBase64(zipStore([topic])))).toBe('VIS_BCF_PARSE');
    expect(code(archive([]))).toBe('VIS_BCF_PARSE');
    expect(code(archive([{ name: 'readme.txt', data: enc('x') }]))).toBe('VIS_BCF_PARSE');
  });

  it('rejects other BCF versions (VIS_BCF_VERSION)', () => {
    expect(code(archive([topic], '2.0'))).toBe('VIS_BCF_VERSION');
    expect(code(archive([topic], '9.9'))).toBe('VIS_BCF_VERSION');
  });

  it('rejects entry names that climb out of the archive', () => {
    for (const name of [
      `../${GUID_A}/markup.bcf`,
      `${GUID_A}/../../markup.bcf`,
      `/${GUID_A}/markup.bcf`,
      `C:/x/markup.bcf`,
      `${GUID_A}\\markup.bcf`,
    ]) {
      const result = execute(createEmptyDocument(), 'import_bcf', { bcf: archive([{ name, data: topic.data }]) });
      expect(result.error?.code, name).toBe('VIS_BCF_PARSE');
      expect(result.document.review).toBeUndefined();
    }
  });

  it('refuses a DOCTYPE (no entity is ever expanded) in version and markup files', () => {
    const bomb = `${HEAD}<!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><Markup><Topic Guid="${GUID_A}"><Title>&b;</Title></Topic></Markup>`;
    const inMarkup = execute(createEmptyDocument(), 'import_bcf', { bcf: archive([{ name: `${GUID_A}/markup.bcf`, data: enc(bomb) }]) });
    expect((inMarkup.data as Imported | undefined)?.topics ?? 0).toBe(0);
    expect(inMarkup.error?.code).toBeUndefined();
    const version = uint8ArrayToBase64(zipStore([{ name: 'bcf.version', data: enc(bomb) }, topic]));
    expect(code(version)).toBe('VIS_BCF_PARSE');
  });

  it('refuses an archive over the size limit before decoding it', () => {
    expect(code('A'.repeat(90_000_000))).toBe('VIS_BCF_PARSE');
  });

  it('never throws on a corrupted archive (byte-flip fuzz)', () => {
    const base = Buffer.from(exported(reviewed()), 'base64');
    let seed = 12345;
    const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let round = 0; round < 150; round++) {
      const bytes = Buffer.from(base);
      for (let flip = 0; flip < 1 + (round % 6); flip++) bytes[next() % bytes.length] = next() & 0xff;
      const cut = round % 5 === 0 ? bytes.subarray(0, next() % bytes.length) : bytes;
      const result = execute(createEmptyDocument(), 'import_bcf', { bcf: cut.toString('base64') });
      expect(typeof result.summary).toBe('string');
      if (result.rejected) expect(['VIS_BCF_PARSE', 'VIS_BCF_VERSION']).toContain(result.error?.code);
    }
  });
});

describe('single viewpoint BCF commands', () => {
  it('exports a viewpoint in metres and imports it back into the same camera', () => {
    const doc = run(reviewed(), 'set_units', { units: 'cm' });
    const out = execute(doc, 'export_bcf_viewpoint', { id: 'vp-1' });
    const data = out.data as { visualizationInfo: string; camera: { cameraViewPointM: number[]; fieldOfViewDeg: number } };
    expect(data.camera.cameraViewPointM[1]).toBeCloseTo(-0.6, 9);
    expect(data.camera.fieldOfViewDeg).toBe(50);
    expect(out.document).toBe(doc);
    const back = execute(doc, 'import_bcf_viewpoint', { visualizationInfo: data.visualizationInfo, name: 'again' });
    expect(back.rejected, back.summary).toBeUndefined();
    const id = back.affected[0] ?? '';
    expect(back.document.review?.viewpoints[id]?.camera).toMatchObject({ fovDeg: 50 });
    expect(back.document.review?.viewpoints[id]?.camera.eye[1]).toBeCloseTo(-60, 6);
    const orthographic = execute(doc, 'export_bcf_viewpoint', { id: 'vp-2' }).data as { camera: { viewToWorldScaleM: number } };
    expect(orthographic.camera.viewToWorldScaleM).toBeCloseTo(0.6, 9);
  });

  it('keeps selected entities, visibility exceptions and counts the unknown ones', () => {
    const box = reviewed().order[0] ?? '';
    const components =
      `<Components><Selection><Component><OriginatingSystem>llull</OriginatingSystem><AuthoringToolId>${box}</AuthoringToolId></Component>` +
      `<Component><OriginatingSystem>llull</OriginatingSystem><AuthoringToolId>ghost</AuthoringToolId></Component></Selection>` +
      `<Visibility DefaultVisibility="false"><Exceptions><Component><OriginatingSystem>llull</OriginatingSystem><AuthoringToolId>${box}</AuthoringToolId></Component></Exceptions></Visibility></Components>`;
    const result = execute(reviewed(), 'import_bcf_viewpoint', { visualizationInfo: visinfo(CAMERA, components), name: 'sel' });
    expect(result.data).toMatchObject({ unmapped: 1 });
    const viewpoint = result.document.review?.viewpoints[result.affected[0] ?? ''];
    expect(viewpoint?.selection).toEqual([box]);
    expect(viewpoint?.visibility).toEqual({ defaultVisible: false, exceptions: [box] });
  });

  it('refuses bad input without changing the document', () => {
    const doc = reviewed();
    expect(execute(doc, 'export_bcf_viewpoint', { id: 'vp-9' }).error?.code).toBe('VIS_VIEWPOINT_NOT_FOUND');
    for (const visualizationInfo of [
      '<VisualizationInfo',
      '<Other />',
      `${HEAD}<VisualizationInfo />`,
      visinfo(CAMERA.replace('<X>1</X>', '<X>one</X>')),
      visinfo(CAMERA.replace('60', '999')),
    ]) {
      const result = execute(doc, 'import_bcf_viewpoint', { visualizationInfo, name: 'x' });
      expect(result.error?.code, visualizationInfo).toBe('VIS_BCF_PARSE');
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
  });
});

/** The children of `element` in order, by local name. */
const order = (element: XmlElement): string[] => xmlChildren(element).map((child) => child.local);

/** True when `actual` is a subsequence of the schema `sequence` (each name in order, optional ones allowed to be absent). */
const inSchemaOrder = (actual: readonly string[], sequence: readonly string[]): boolean => {
  let at = 0;
  for (const name of actual) {
    const found = sequence.indexOf(name, at);
    if (found < 0) return false;
    at = found;
  }
  return true;
};

describe('VC-VIS-15: structural checks of the exported BCF 3.0 against markup.xsd / visinfo.xsd', () => {
  const TOPIC = [
    'ReferenceLink',
    'Title',
    'Priority',
    'Index',
    'Labels',
    'CreationDate',
    'CreationAuthor',
    'ModifiedDate',
    'ModifiedAuthor',
    'DueDate',
    'AssignedTo',
    'Description',
    'BimSnippet',
    'DocumentReferences',
    'RelatedTopics',
    'Comments',
    'Viewpoints',
  ];
  const COMMENT = ['Date', 'Author', 'Comment', 'Viewpoint', 'ModifiedDate', 'ModifiedAuthor'];
  const VISINFO = ['Components', 'PerspectiveCamera', 'OrthogonalCamera', 'Lines', 'ClippingPlanes', 'Bitmaps'];

  it('writes every part in schema order with the required attributes', () => {
    const entries = unzip(Buffer.from(exported(reviewed()), 'base64'));
    expect(entries.map((entry) => entry.name)[0]).toBe('bcf.version');
    const parse = (name: string): XmlElement => {
      const bytes = entries.find((entry) => entry.name === name)?.data ?? new Uint8Array();
      const read = readXml(new TextDecoder().decode(bytes));
      if (!read.ok) throw new Error(`${name}: ${read.error.message}`);
      return read.root;
    };
    const markupName = entries.find((entry) => entry.name.endsWith('/markup.bcf'))?.name ?? '';
    const root = parse(markupName);
    expect(root.local).toBe('Markup');
    const topic = xmlChildren(root, 'Topic')[0];
    expect(topic).toBeDefined();
    const attributes = (topic?.attributes ?? []).map((attribute) => attribute.name);
    expect(attributes).toEqual(expect.arrayContaining(['Guid', 'TopicType', 'TopicStatus']));
    expect(inSchemaOrder(order(topic as XmlElement), TOPIC)).toBe(true);
    for (const required of ['Title', 'CreationDate', 'CreationAuthor']) expect(order(topic as XmlElement)).toContain(required);
    const comments = xmlChildren(xmlChildren(topic as XmlElement, 'Comments')[0] as XmlElement, 'Comment');
    expect(comments).toHaveLength(2);
    for (const comment of comments) {
      expect(inSchemaOrder(order(comment), COMMENT)).toBe(true);
      expect(order(comment).slice(0, 3)).toEqual(['Date', 'Author', 'Comment']);
    }
    const views = xmlChildren(xmlChildren(topic as XmlElement, 'Viewpoints')[0] as XmlElement, 'ViewPoint');
    expect(views).toHaveLength(2);
    const folder = markupName.slice(0, markupName.lastIndexOf('/') + 1);
    for (const view of views) {
      const file = xmlChildren(view, 'Viewpoint')[0]
        ?.children.map((child) => (child.type === 'text' ? child.value : ''))
        .join('');
      const info = parse(`${folder}${file}`);
      expect(info.local).toBe('VisualizationInfo');
      expect(info.attributes.map((attribute) => attribute.name)).toContain('Guid');
      expect(inSchemaOrder(order(info), VISINFO)).toBe(true);
      const camera = xmlChildren(info, 'PerspectiveCamera')[0] ?? xmlChildren(info, 'OrthogonalCamera')[0];
      expect(order(camera as XmlElement).slice(0, 3)).toEqual(['CameraViewPoint', 'CameraDirection', 'CameraUpVector']);
      expect(order(camera as XmlElement)).toContain('AspectRatio');
    }
  });
});
