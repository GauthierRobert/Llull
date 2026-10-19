import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RasterOutcome, RasterPort } from '@core/model/raster';
import { rasterScenePixels } from '@core/commands/render/raster';

const PERSPECTIVE = { projection: 'perspective', eye: [0, -60, 20], direction: [0, 1, -0.3], fovDeg: 50 } as const;

function reviewed(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): void => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
  };
  run('add_box', { size: [20, 10, 8], color: '#d04020' });
  run('add_cylinder', { radius: 4, height: 15, position: [20, 0, 0], color: '#2060d0' });
  run('save_viewpoint', { name: 'south', camera: PERSPECTIVE });
  run('save_viewpoint', { name: 'east', camera: { ...PERSPECTIVE, eye: [60, 0, 20], direction: [-1, 0, -0.3], fovDeg: 40 } });
  run('save_viewpoint', {
    name: 'plan',
    camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 60 },
  });
  run('save_viewpoint', {
    name: 'plan 2',
    camera: { projection: 'orthographic', eye: [10, 0, 100], direction: [0, 0, -1], up: [1, 0, 0], viewHeight: 40 },
  });
  run('create_walkthrough', {
    name: 'orbit',
    keys: [
      { viewpointId: 'vp-1', seconds: 1 },
      { viewpointId: 'vp-2', seconds: 1 },
    ],
  });
  return doc;
}

interface Frames {
  frames: number;
  files: { fileName: string; base64: string }[];
  frameSha256?: string[];
  renderer: string;
  deterministic?: boolean;
}

const sha = (bytes: Buffer | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function fakePort(fail = false): RasterPort {
  return {
    render(scene, engine): RasterOutcome {
      if (fail) return { ok: false, code: 'NATIVE_PROTOCOL', message: 'bad event' };
      return {
        ok: true,
        image: { rgba: rasterScenePixels(scene), device: `fake ${engine}`, deterministic: false, engine: 'native-gpu', version: 'v' },
      };
    },
  };
}

describe('render_walkthrough', () => {
  it('renders floor(duration × fps) + 1 PNG frames with reproducible digests', () => {
    const doc = reviewed();
    const result = execute(doc, 'render_walkthrough', { id: 'wt-5', fps: 4, width: 96, height: 64 });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([]);
    const data = result.data as Frames;
    expect(data.frames).toBe(5);
    expect(data.files.map((f) => f.fileName)).toEqual([
      'frame-0001.png',
      'frame-0002.png',
      'frame-0003.png',
      'frame-0004.png',
      'frame-0005.png',
    ]);
    const bytes = data.files.map((f) => Buffer.from(f.base64, 'base64'));
    expect(bytes[0]?.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(data.frameSha256).toEqual(bytes.map(sha));
    expect(new Set(data.frameSha256).size).toBe(5);
    expect(result.summary).toContain('5 frame(s) at 4 fps');
    const again = execute(doc, 'render_walkthrough', { id: 'wt-5', fps: 4, width: 96, height: 64 }).data as Frames;
    expect(again.frameSha256).toEqual(data.frameSha256);
  });

  it('renders orthographic walkthroughs and a custom background', () => {
    let doc = reviewed();
    doc = execute(doc, 'create_walkthrough', {
      name: 'plan pan',
      keys: [
        { viewpointId: 'vp-3', seconds: 0.5 },
        { viewpointId: 'vp-4', seconds: 1 },
      ],
    }).document;
    const data = execute(doc, 'render_walkthrough', { id: 'wt-6', fps: 2, width: 64, height: 64, background: '#fff' }).data as Frames;
    expect(data.frames).toBe(2);
  });

  it('refuses unknown walkthroughs, too many frames, oversized renders, bad backgrounds and missing viewpoints', () => {
    const doc = reviewed();
    const code = (params: Record<string, unknown>, d = doc): string | undefined => execute(d, 'render_walkthrough', params).error?.code;
    expect(code({ id: 'wt-9' })).toBe('VIS_WALKTHROUGH_NOT_FOUND');
    expect(code({ id: 'wt-5', fps: 30, maxFrames: 10 })).toBe('VIS_WALKTHROUGH_INVALID');
    expect(code({ id: 'wt-5', fps: 30, width: 2000, height: 2000 })).toBe('VIS_RENDER_BUDGET');
    expect(code({ id: 'wt-5', background: 'red' })).toBe('VIS_RENDER_INVALID');
    const review = doc.review;
    if (review === undefined) throw new Error('no review');
    const broken = { ...doc, review: { ...review, viewpoints: { 'vp-2': review.viewpoints['vp-2'] } } } as CadDocument;
    expect(code({ id: 'wt-5' }, broken)).toBe('VIS_VIEWPOINT_NOT_FOUND');
  });

  it('draws frames natively through ctx.raster without digests, and fails without a port or on a failed job', () => {
    const doc = reviewed();
    const params = { id: 'wt-5', fps: 2, width: 64, height: 48 };
    expect(execute(doc, 'render_walkthrough', { ...params, renderer: 'native' }).error?.code).toBe('NATIVE_TOOL_MISSING');
    const native = execute(doc, 'render_walkthrough', { ...params, renderer: 'native' }, { ...defaultContext(), raster: fakePort() });
    const data = native.data as Frames;
    expect(data).toMatchObject({ renderer: 'native', deterministic: false, frames: 3 });
    expect(data.frameSha256).toBeUndefined();
    const reference = execute(doc, 'render_walkthrough', params).data as Frames;
    expect(data.files).toEqual(reference.files);
    const failed = execute(doc, 'render_walkthrough', { ...params, renderer: 'native' }, { ...defaultContext(), raster: fakePort(true) });
    expect(failed.error?.code).toBe('NATIVE_PROTOCOL');
  });
});

/** Entries of a stored (method 0) zip, checking each local header's CRC with node:zlib. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0);
    const crc = bytes.readUInt32LE(offset + 14);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size);
    expect(crc32(data)).toBe(crc);
    entries.set(name, data);
    offset += 30 + nameLength + size;
  }
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(end + 10)).toBe(entries.size);
  expect(bytes.readUInt32LE(end + 16)).toBe(offset);
  return entries;
}

interface Bcf {
  base64: string;
  sha256: string;
  bytes: number;
  topics: number;
  viewpoints: number;
  snapshots: number;
  warnings: { code: string; ids: string[] }[];
  snapshotRenderer: string;
  deterministic: boolean;
}

function withIssues(): CadDocument {
  let doc = reviewed();
  const box = doc.order[0] ?? '';
  doc = execute(doc, 'create_review_issue', {
    title: 'Clearance < 50 & nozzle',
    type: 'Clash',
    priority: 'high',
    labels: ['piping'],
    description: 'see <view>',
    viewpointIds: ['vp-1', 'vp-3'],
    entityIds: [box],
  }).document;
  return execute(doc, 'create_review_issue', { title: 'Access', viewpointIds: ['vp-1'] }).document;
}

describe('export_bcf', () => {
  it('writes a reproducible BCF 3.0 archive with topics, viewpoints in metres and PNG snapshots', () => {
    const doc = withIssues();
    const result = execute(doc, 'export_bcf', { snapshotWidth: 120, snapshotHeight: 90, author: 'reviewer@example.com' });
    expect(result.error, result.summary).toBeUndefined();
    const data = result.data as Bcf;
    expect(data).toMatchObject({ topics: 2, viewpoints: 3, snapshots: 3, snapshotRenderer: 'reference', deterministic: true });
    const archive = Buffer.from(data.base64, 'base64');
    expect(data.bytes).toBe(archive.length);
    expect(data.sha256).toBe(sha(archive));
    expect(data.warnings).toEqual([{ code: 'VIS_BCF_GUID_UNMAPPED', ids: [doc.order[0]] }]);
    const entries = unzip(archive);
    const names = [...entries.keys()];
    expect(names.slice(0, 2)).toEqual(['bcf.version', 'extensions.xml']);
    expect(entries.get('bcf.version')?.toString()).toContain('VersionId="3.0"');
    const issue = doc.review?.issues['iss-6'];
    const markup = entries.get(`${issue?.guid}/markup.bcf`)?.toString() ?? '';
    expect(markup).toContain('TopicType="Clash" TopicStatus="Open"');
    expect(markup).toContain('<Title>Clearance &lt; 50 &amp; nozzle</Title>');
    expect(markup).toContain('<CreationDate>1970-01-01T00:00:00Z</CreationDate><CreationAuthor>reviewer@example.com</CreationAuthor>');
    expect(markup.match(/<ViewPoint /g)).toHaveLength(2);
    const visinfos = names
      .filter((name) => name.startsWith(`${issue?.guid}/`) && name.endsWith('.bcfv'))
      .map((n) => entries.get(n)?.toString() ?? '');
    const perspective = visinfos.find((xml) => xml.includes('<PerspectiveCamera>')) ?? '';
    expect(perspective).toContain('<CameraViewPoint><X>0</X><Y>-0.06</Y><Z>0.02</Z></CameraViewPoint>');
    expect(perspective).toContain('<FieldOfView>50</FieldOfView><AspectRatio>1.3333333333333333</AspectRatio>');
    expect(perspective).toContain(`<AuthoringToolId>${doc.order[0]}</AuthoringToolId>`);
    const ortho = visinfos.find((xml) => xml.includes('<OrthogonalCamera>')) ?? '';
    expect(ortho).toContain('<ViewToWorldScale>0.06</ViewToWorldScale>');
    expect(names.filter((name) => name.endsWith('.png')).every((name) => entries.get(name)?.subarray(1, 4).toString() === 'PNG')).toBe(
      true,
    );
    const again = execute(doc, 'export_bcf', { snapshotWidth: 120, snapshotHeight: 90, author: 'reviewer@example.com' }).data as Bcf;
    expect(again.sha256).toBe(data.sha256);
  });

  it('exports selected issues without snapshots', () => {
    const data = execute(withIssues(), 'export_bcf', { issueIds: ['iss-7'], snapshots: false, creationDate: '2026-10-19T12:00:00Z' })
      .data as Bcf;
    expect(data).toMatchObject({ topics: 1, viewpoints: 1, snapshots: 0, warnings: [] });
    const entries = unzip(Buffer.from(data.base64, 'base64'));
    expect([...entries.keys()].some((name) => name.endsWith('.png'))).toBe(false);
    expect([...entries.values()].some((bytes) => bytes.toString().includes('2026-10-19T12:00:00Z'))).toBe(true);
  });

  it('refuses 2.1, unknown or missing issues, bad dates and native snapshots without a port', () => {
    const doc = withIssues();
    const code = (params: Record<string, unknown>, d = doc): string | undefined => execute(d, 'export_bcf', params).error?.code;
    expect(code({ version: '2.1' })).toBe('VIS_BCF_VERSION');
    expect(code({ issueIds: ['iss-1'] })).toBe('VIS_ISSUE_NOT_FOUND');
    expect(code({}, reviewed())).toBe('VIS_ISSUE_NOT_FOUND');
    expect(code({ creationDate: 'yesterday' })).toBe('VIS_BCF_INVALID');
    expect(code({ snapshotRenderer: 'native' })).toBe('NATIVE_TOOL_MISSING');
  });

  it('draws snapshots natively through ctx.raster (a picture) and reports failures', () => {
    const doc = withIssues();
    const native = execute(
      doc,
      'export_bcf',
      { snapshotRenderer: 'native', snapshotWidth: 80, snapshotHeight: 60 },
      { ...defaultContext(), raster: fakePort() },
    );
    expect(native.data).toMatchObject({ snapshotRenderer: 'native', deterministic: false, device: 'fake gpu' });
    const failed = execute(doc, 'export_bcf', { snapshotRenderer: 'native' }, { ...defaultContext(), raster: fakePort(true) });
    expect(failed.error?.code).toBe('NATIVE_PROTOCOL');
  });

  it('is pure', () => {
    const doc = withIssues();
    const before = JSON.stringify(doc);
    execute(doc, 'export_bcf', { snapshotWidth: 64, snapshotHeight: 64 });
    execute(doc, 'render_walkthrough', { id: 'wt-5', fps: 1, width: 64, height: 64 });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('review fixes (cad-reviewer)', () => {
  it('draws sketch-only orthographic walkthrough frames (strokes are rasterised, not dropped)', () => {
    let doc = execute(createEmptyDocument(), 'draw_polyline', {
      points: [
        [-20, 0],
        [20, 0],
        [20, 10],
      ],
    }).document;
    const camera = { projection: 'orthographic', eye: [0, 0, 50], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 50 };
    doc = execute(doc, 'save_viewpoint', { name: 'a', camera }).document;
    doc = execute(doc, 'save_viewpoint', { name: 'b', camera: { ...camera, eye: [5, 0, 50] } }).document;
    doc = execute(doc, 'create_walkthrough', {
      name: 'w',
      keys: [
        { viewpointId: 'vp-1', seconds: 1 },
        { viewpointId: 'vp-2', seconds: 1 },
      ],
    }).document;
    const data = execute(doc, 'render_walkthrough', { id: 'wt-3', fps: 1, width: 64, height: 64 }).data as Frames;
    const blank = execute(createEmptyDocument(), 'save_viewpoint', { name: 'e', camera }).document;
    const empty = execute(execute(blank, 'save_viewpoint', { name: 'f', camera }).document, 'create_walkthrough', {
      name: 'w',
      keys: [
        { viewpointId: 'vp-1', seconds: 1 },
        { viewpointId: 'vp-2', seconds: 1 },
      ],
    }).document;
    const emptyData = execute(empty, 'render_walkthrough', { id: 'wt-3', fps: 1, width: 64, height: 64 }).data as Frames;
    expect(data.files[0]?.base64).not.toBe(emptyData.files[0]?.base64);
    const native = execute(
      doc,
      'render_walkthrough',
      { id: 'wt-3', fps: 1, width: 64, height: 64, renderer: 'native' },
      { ...defaultContext(), raster: fakePort() },
    );
    expect(native.error).toBeUndefined();
    expect((native.data as Frames).files).toEqual(data.files);
  });

  it('de-duplicates issue viewpoints / entities and exported issues, so archive entries stay unique', () => {
    let doc = reviewed();
    const box = doc.order[0] ?? '';
    doc = execute(doc, 'create_review_issue', { title: 't', viewpointIds: ['vp-1', 'vp-1'], entityIds: [box, box] }).document;
    expect(doc.review?.issues['iss-6']).toMatchObject({ viewpointIds: ['vp-1'], entityIds: [box] });
    const data = execute(doc, 'export_bcf', { issueIds: ['iss-6', 'iss-6'], snapshots: false }).data as Bcf;
    expect(data).toMatchObject({ topics: 1, viewpoints: 1 });
    const names = [...unzip(Buffer.from(data.base64, 'base64')).keys()];
    expect(new Set(names).size).toBe(names.length);
  });

  it('exports only entities that still exist', () => {
    let doc = withIssues();
    doc = execute(doc, 'delete_entities', { ids: [doc.order[0]] }).document;
    const data = execute(doc, 'export_bcf', { snapshots: false }).data as Bcf;
    expect(data.warnings).toEqual([]);
  });

  it('delete_review_issue removes an issue, then the viewpoint can be deleted; unknown ids are refused', () => {
    const doc = withIssues();
    const deleted = execute(doc, 'delete_review_issue', { id: 'iss-7' });
    expect(deleted.affected).toEqual(['iss-7']);
    expect(deleted.document.review?.issueOrder).toEqual(['iss-6']);
    expect(execute(doc, 'delete_review_issue', { id: 'iss-1' }).error?.code).toBe('VIS_ISSUE_NOT_FOUND');
    const before = JSON.stringify(doc);
    execute(doc, 'delete_review_issue', { id: 'iss-6' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
