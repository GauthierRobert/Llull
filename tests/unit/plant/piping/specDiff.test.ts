/** Plant 01 PSC M4: `diff_pipe_spec`: what changed between two revisions (header, status, components, branch cells, insulation), refusals. */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { HumanSignaturePort } from '@core/model/analysis';
import { humanGatePayload } from '@core/model/humanGate';
import { sha256Hex } from '@lib/sha256';
import { canonicalSpecText } from '@aec/plant/spec/file';
import { latestSpec } from '@aec/plant/spec/store';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { importedDoc } from './specFixture';

interface Diff {
  specId: string;
  fromRevision: number;
  toRevision: number;
  identical: boolean;
  changes: number;
  header: Array<{ field: string; from: unknown; to: unknown }>;
  status: { from: string; to: string } | null;
  components: {
    added: string[];
    removed: string[];
    changed: Array<{ id: string; fields: Array<{ field: string; from: unknown; to: unknown }> }>;
  };
  branchCells: Array<{ header: string; branch: string; from: string | null; to: string | null }>;
  insulation: { added: unknown[]; removed: unknown[] };
}

const AT = '2026-11-02T09:30:00Z';

/** A port whose signatures are { payload, nonce } and verify only for that exact payload. */
const port = (): HumanSignaturePort => ({
  verify: (signature: unknown, payload: string) =>
    (signature as { payload?: string }).payload === payload ? { signer: 'alice', signatureId: 'sig-1' } : null,
  spend: () => true,
});

/** Revision 1 = the fixture, approved by a (scripted) human; revision 2 = the new draft the operations make. */
function twoRevisions(ops: unknown[]): CadDocument {
  const doc = importedDoc();
  const spec = latestSpec(doc, 'CS150-A1');
  if (spec === undefined) throw new Error('no spec');
  const payload = humanGatePayload(
    'plant:approve_pipe_spec',
    ['CS150-A1'],
    { revision: 1, contentSha256: sha256Hex(canonicalSpecText(spec)) },
    'n1',
  );
  const approved = execute(
    doc,
    'approve_pipe_spec',
    { specId: 'CS150-A1', confirmation: { payload, nonce: 'n1' }, at: AT },
    { ...defaultContext(), humanSignature: port() },
  );
  expect(approved.rejected, approved.summary).toBeUndefined();
  return apply(approved.document, 'edit_pipe_spec', { specId: 'CS150-A1', ops });
}
const diff = (doc: CadDocument, params: Record<string, unknown> = {}): Diff =>
  data<Diff>(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1, ...params });

describe('diff_pipe_spec', () => {
  it('reports no difference between a revision and itself', () => {
    const doc = importedDoc();
    const result = diff(doc, { toRevision: 1 });
    expect(result).toMatchObject({ identical: true, changes: 0, fromRevision: 1, toRevision: 1, status: null });
    expect(result.components).toEqual({ added: [], removed: [], changed: [] });
    expect(execute(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1, toRevision: 1 }).summary).toContain('identical');
  });

  it('lists header, status, component, branch-cell and insulation differences, sorted, member by member', () => {
    const doc = twoRevisions([
      { op: 'setHeader', fields: { corrosionAllowance: { value: 4.5, unit: 'mm' }, millTolerance: null } },
      { op: 'removeComponent', id: 'WOL' },
      {
        op: 'addComponent',
        component: { id: 'G-SHEET', type: 'gasketSheet', fromNps: 0.5, toNps: 24, class: 150, catalogRef: 'asme-b16.21' },
      },
      { op: 'updateComponent', id: 'E90-LR', changes: { priority: 50, commodityCode: 'E90LR150' } },
      { op: 'setBranchCell', header: 6, branch: 4, fitting: 'W' },
      { op: 'clearBranchCell', header: 2, branch: 1 },
      { op: 'setInsulationRow', row: { code: 'H', dnMax: 100, tempMaxC: 200, thicknessMm: 50, material: 'mineral wool' } },
    ]);
    const result = diff(doc);
    expect(result).toMatchObject({ fromRevision: 1, toRevision: 2, identical: false, status: { from: 'approved', to: 'draft' } });
    expect(result.header.map((entry) => entry.field)).toEqual(['corrosionAllowance', 'millTolerance']);
    expect(result.header[0]).toMatchObject({ from: { value: 3, unit: 'mm' }, to: { value: 4.5, unit: 'mm' } });
    expect(result.header[1]).toMatchObject({ from: 0.125, to: null });
    expect(result.components.added).toEqual(['G-SHEET']);
    expect(result.components.removed).toEqual(['WOL']);
    expect(result.components.changed).toEqual([
      {
        id: 'E90-LR',
        fields: [
          { field: 'commodityCode', from: null, to: 'E90LR150' },
          { field: 'priority', from: null, to: 50 },
        ],
      },
    ]);
    expect(result.branchCells).toEqual([
      { header: '2', branch: '1', from: 'S', to: null },
      { header: '6', branch: '4', from: 'RT', to: 'W' },
    ]);
    expect(result.insulation.added).toHaveLength(1);
    expect(result.insulation.removed).toEqual([]);
    expect(result.changes).toBe(2 + 1 + 1 + 1 + 1 + 2 + 1);
  });

  it('defaults toRevision to the newest, reads backwards too, and reports a removed insulation row', () => {
    const doc = twoRevisions([{ op: 'setHeader', fields: { title: 'second' } }]);
    expect(diff(doc).toRevision).toBe(2);
    expect(diff(doc).header).toEqual([expect.objectContaining({ field: 'title', to: 'second' })]);
    expect(execute(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 2, toRevision: 1 }).data).toMatchObject({
      header: [expect.objectContaining({ field: 'title', from: 'second' })],
      status: { from: 'draft', to: 'approved' },
    });
    const row = { code: 'H', dnMax: 100, tempMaxC: 200, thicknessMm: 50, material: 'mineral wool' };
    const withRow = apply(doc, 'edit_pipe_spec', { specId: 'CS150-A1', ops: [{ op: 'setInsulationRow', row }] });
    const without = apply(withRow, 'edit_pipe_spec', {
      specId: 'CS150-A1',
      ops: [{ op: 'removeInsulationRow', code: 'H', dnMax: 100, tempMaxC: 200 }],
    });
    expect(data<Diff>(withRow, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1 }).insulation.added).toHaveLength(1);
    expect(data<Diff>(without, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1 }).insulation).toEqual({ added: [], removed: [] });
    const backwards = data<Diff>(withRow, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 2, toRevision: 1 });
    expect(backwards.insulation.removed).toHaveLength(1);
    expect(backwards.insulation.added).toEqual([]);
  });

  it('is read-only and pure', () => {
    const doc = twoRevisions([{ op: 'setHeader', fields: { service: 'steam' } }]);
    expectPure(doc, () => execute(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1 }));
    expect(execute(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1 }).document).toBe(doc);
  });

  it('refuses an unknown spec or revision, naming the revisions that exist', () => {
    const doc = twoRevisions([{ op: 'setHeader', fields: { service: 'steam' } }]);
    expectRefusal(createEmptyDocument(), 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1 }, 'PSC_SPEC_UNKNOWN', 'specId');
    const missing = expectRefusal(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 7 }, 'PSC_REVISION_UNKNOWN', 'fromRevision');
    expect(missing.summary).toContain('revisions: 1, 2');
    expectRefusal(doc, 'diff_pipe_spec', { specId: 'CS150-A1', fromRevision: 1, toRevision: 9 }, 'PSC_REVISION_UNKNOWN', 'toRevision');
  });
});
