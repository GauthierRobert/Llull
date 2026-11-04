/** ISO-M6 (VC-ISO-23): compareToIssue draws revision clouds and delta triangles for what changed since the last issued revision. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { deltaOf } from '@aec/plant/fabrication/compareIssue';
import type { IssueSnapshot } from '@aec/plant/fabrication/model';
import { fabricationErrors } from '@aec/plant/fabrication/validate';
import { cs150Document } from '../piping/rteFixtures';
import { loadedL101 } from './isoM2Fixtures';

const port: HumanSignaturePort = { verify: () => ({ signer: 'alice', signatureId: 'sig-1' }) };
const ctx: ExecutionContext = { ...defaultContext(), humanSignature: port };
const issueParams = {
  lineId: 'L-101',
  revision: 'A',
  purpose: 'for_construction',
  at: '2026-11-02T09:30:00Z',
  confirmation: { nonce: 'n1' },
};

const numbered = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
const issued = execute(numbered, 'issue_isometric', issueParams, ctx).document;
const edited = apply(issued, 'add_field_weld', { lineId: 'L-101', at: [1000, 0, 3000], type: 'site' });

interface Compared {
  files: Array<{ content: string }>;
  annotations: Array<{ kind: string; text: string; componentIds?: string[]; welds?: string[] }>;
  comparison?: {
    issueId: string;
    issuedRevision: string;
    unchanged: boolean;
    clouds: number;
    delta: {
      total: number;
      components: { added: string[]; removed: string[]; changed: string[] };
      welds: { added: string[]; changed: string[]; removed: string[] };
      bomChanges: unknown[];
    };
  };
}
const compare = (doc: CadDocument, extra: Record<string, unknown> = {}): Compared =>
  data<Compared>(doc, 'export_isometric', { lineId: 'L-101', compareToIssue: true, ...extra });

describe('export_isometric compareToIssue', () => {
  it('stores a snapshot with the issue', () => {
    const [id] = Object.keys(issued.plant?.fabrication?.issues ?? {});
    expect(id).toBeDefined();
    const snapshot = issued.plant?.fabrication?.issueSnapshots?.[id as string];
    expect(Object.keys(snapshot?.components ?? {}).length).toBeGreaterThan(10);
    expect(Object.keys(snapshot?.welds ?? {})).toHaveLength(13);
    expect(fabricationErrors(issued.plant?.fabrication)).toEqual([]);
    expect(fabricationErrors(deserializeDocument(serializeDocument(issued)).plant?.fabrication)).toEqual([]);
  });

  it('an unchanged issued line has no differences and no clouds', () => {
    const result = compare(issued);
    expect(result.comparison).toMatchObject({ issuedRevision: 'A', unchanged: true, clouds: 0 });
    expect(result.files[0]?.content).not.toContain('class="iso-rev"');
  });

  it('a field weld after the issue: the split pipe is removed / added, the new weld is listed, clouds and a delta triangle are drawn', () => {
    const result = compare(edited, { revision: 'B' });
    const delta = result.comparison?.delta;
    expect(result.comparison?.unchanged).toBe(false);
    expect(delta?.welds.added).toHaveLength(1);
    expect((delta?.components.added.length ?? 0) + (delta?.components.changed.length ?? 0)).toBeGreaterThan(0);
    expect(delta?.components.removed).toEqual(['pcf:L-101:2']);
    expect(delta?.components.added).toEqual(expect.arrayContaining(['pcf:L-101:2.s1', 'pcf:L-101:2.s2']));
    const clouds = result.annotations.filter((annotation) => annotation.kind === 'revision');
    expect(clouds.length).toBeGreaterThan(0);
    expect(result.comparison?.clouds).toBe(clouds.length);
    const svg = result.files[0]?.content ?? '';
    expect(svg).toContain('class="iso-rev"');
    expect(svg).toContain('>B</text>');
    expect(svg).toContain('REVISION CLOUDS: CHANGES SINCE REV A');
    expect(clouds.flatMap((cloud) => cloud.welds ?? [])).toEqual(delta?.welds.added);
  });

  it('is deterministic and does not change the document; a plain export draws no cloud', () => {
    expect(compare(edited).files[0]?.content).toBe(compare(edited).files[0]?.content);
    const before = JSON.stringify(edited);
    execute(edited, 'export_isometric', { lineId: 'L-101', compareToIssue: true });
    expect(JSON.stringify(edited)).toBe(before);
    const plain = data<Compared>(edited, 'export_isometric', { lineId: 'L-101' });
    expect(plain.comparison).toBeUndefined();
    expect(plain.files[0]?.content).not.toContain('class="iso-rev"');
  });

  it('draws the clouds in DXF on the ISO-REV layer', () => {
    const result = compare(edited, { formats: ['dxf'] });
    expect(result.files[0]?.content).toContain('ISO-REV');
  });

  it('refuses without an issue, without a snapshot, and a revision label without compareToIssue', () => {
    expectRefusal(numbered, 'export_isometric', { lineId: 'L-101', compareToIssue: true }, 'ISO_ISSUE_NOT_FOUND');
    const fabrication = issued.plant?.fabrication;
    const bare = { ...issued, plant: { ...issued.plant, fabrication: { ...fabrication, issueSnapshots: {} } } } as CadDocument;
    expectRefusal(bare, 'export_isometric', { lineId: 'L-101', compareToIssue: true }, 'ISO_ISSUE_SNAPSHOT_MISSING');
    expectRefusal(issued, 'export_isometric', { lineId: 'L-101', revision: 'B' }, 'ISO_PARAM_INVALID');
  });

  it('delete_pcf_line removes the snapshot with the issue', () => {
    const gone = apply(issued, 'delete_pcf_line', { lineId: 'L-101' });
    expect(gone.plant?.fabrication?.issueSnapshots ?? {}).toEqual({});
  });
});

describe('deltaOf', () => {
  const base: IssueSnapshot = {
    components: { a: { type: 'PIPE', fp: '1', at: [0, 0, 0] }, b: { type: 'ELBOW', fp: '2', at: [1, 0, 0] } },
    welds: { W1: { kind: 'shop', at: [0, 0, 0] }, W2: { kind: 'shop', at: [1, 0, 0] } },
    dimensions: { '+E@0,0,0': { overallMm: 100, to: '100,0,0' } },
    bom: { P: { quantity: 1.5, unit: 'm' }, E: { quantity: 2, unit: 'ea' } },
  };

  it('reports added, removed and changed per kind, sorted, with BOM quantities', () => {
    const now: IssueSnapshot = {
      components: { a: { type: 'PIPE', fp: '9', at: [0, 0, 0] }, c: { type: 'TEE', fp: '3', at: [2, 0, 0] } },
      welds: { W1: { kind: 'site', at: [0, 0, 0] }, W3: { kind: 'shop', at: [2, 0, 0] } },
      dimensions: { '+E@0,0,0': { overallMm: 120, to: '120,0,0' }, '+N@0,0,0': { overallMm: 5, to: '0,5,0' } },
      bom: { P: { quantity: 2, unit: 'm' }, T: { quantity: 1, unit: 'ea' } },
    };
    const delta = deltaOf(base, now);
    expect(delta.components).toEqual({ added: ['c'], removed: ['b'], changed: ['a'] });
    expect(delta.welds).toEqual({ added: ['W3'], removed: ['W2'], changed: ['W1'] });
    expect(delta.dimensions).toEqual({ added: ['+N@0,0,0'], removed: [], changed: ['+E@0,0,0'] });
    expect(delta.bomChanges).toEqual([
      { itemCode: 'E', issued: 2, current: null, unit: 'ea' },
      { itemCode: 'P', issued: 1.5, current: 2, unit: 'm' },
      { itemCode: 'T', issued: null, current: 1, unit: 'ea' },
    ]);
    expect(delta.total).toBe(3 + 3 + 2 + 3);
  });

  it('identical snapshots have no difference', () => {
    expect(deltaOf(base, base).total).toBe(0);
  });
});

describe('compareToIssue: review follow-ups', () => {
  it('keeps one snapshot per line: a second issue replaces the first', () => {
    const renumbered = apply(edited, 'number_welds', { lineId: 'L-101' });
    const second = execute(renumbered, 'issue_isometric', { ...issueParams, revision: 'B', confirmation: { nonce: 'n2' } }, ctx);
    expect(second.error, second.summary).toBeUndefined();
    const fabrication = second.document.plant?.fabrication;
    expect(Object.keys(fabrication?.issues ?? {})).toHaveLength(2);
    expect(Object.keys(fabrication?.issueSnapshots ?? {})).toEqual([second.affected[0]]);
    expect(compare(second.document).comparison).toMatchObject({ issuedRevision: 'B', unchanged: true });
  });

  it('compareToIssue works after replay_history (the snapshot is recomputed with the issue)', () => {
    const replayed = execute(edited, 'replay_history', {}).document;
    expect(compare(replayed).comparison?.delta.welds.added).toEqual(compare(edited).comparison?.delta.welds.added);
    expect(Object.keys(replayed.plant?.fabrication?.issueSnapshots ?? {})).toEqual(
      Object.keys(issued.plant?.fabrication?.issueSnapshots ?? {}),
    );
  });

  it('the legend counts removed components', () => {
    const result = compare(edited);
    expect(result.comparison?.delta.components.removed).toHaveLength(1);
    expect(result.files[0]?.content).toContain('1 REMOVED');
  });

  it('load validation: a snapshot of no issue and a malformed fingerprint are reported', () => {
    const fabrication = issued.plant?.fabrication;
    const [id] = Object.keys(fabrication?.issueSnapshots ?? {});
    const snapshot = fabrication?.issueSnapshots?.[id as string];
    expect(fabricationErrors({ ...fabrication, issueSnapshots: { ...fabrication?.issueSnapshots, 'iso-issue-99.1': snapshot } })).toEqual([
      'plant.fabrication.issueSnapshots.iso-issue-99.1: no issue with this id',
    ]);
    const first = Object.keys(snapshot?.components ?? {})[0] as string;
    const bad = { ...snapshot, components: { ...snapshot?.components, [first]: { type: 'PIPE', fp: 'XYZ', at: [0, 0, 0] } } };
    expect(fabricationErrors({ ...fabrication, issueSnapshots: { [id as string]: bad } }).length).toBeGreaterThan(0);
  });

  it('record keys named like Object.prototype members are plain keys', () => {
    const origin = [0, 0, 0] as const;
    const snapshot = (components: IssueSnapshot['components']): IssueSnapshot => ({ components, welds: {}, dimensions: {}, bom: {} });
    const delta = deltaOf(snapshot({}), snapshot({ constructor: { type: 'PIPE', fp: '0123456789abcdef', at: origin } }));
    expect(delta.components.added).toEqual(['constructor']);
    expect(deltaOf(snapshot({ toString: { type: 'PIPE', fp: '0123456789abcdef', at: origin } }), snapshot({})).components.removed).toEqual([
      'toString',
    ]);
    const grade = apply(cs150Document(), 'add_level', { name: 'Grade', elevation: 0 });
    const points = [
      [0, 0, 1000],
      [3000, 0, 1000],
    ];
    expect(apply(grade, 'add_pipe_run', { points, dn: 100, line: 'constructor' })).not.toBe(grade);
    const created = apply(cs150Document(), 'create_pipeline', {
      service: 'P',
      sequence: '1',
      spec: 'CS150',
      dn: 100,
      lineNumber: 'constructor',
    });
    expect(created.plant?.piping?.lineOrder).toHaveLength(1);
  });
});
