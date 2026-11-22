/**
 * Plant 08 DAT-VIS-FU3: import_bcf of a schema-valid file that uses optional BCF elements llull does not write reports, by name, what it does not
 * import (`data.ignored`, warning VIS_BCF_ELEMENT_IGNORED); a file export_bcf wrote raises no such warning. The fixtures are valid against the
 * buildingSMART schemas (server/tests/bcfSchema.test.ts proves it with xmllint).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { uint8ArrayToBase64 } from '@lib/base64';
import { createEmptyDocument } from '@core/model/types';
import { optionalFixture21, optionalFixture30, type OptionalFixture } from '../../helpers/bcfOptionalFixture';

interface Imported {
  created: number;
  viewpoints: number;
  comments: number;
  ignored: Array<{ name: string; count: number }>;
  warnings: Array<{ code: string; message: string }>;
}

function importFixture(fixture: OptionalFixture): { data: Imported; summary: string } {
  const result = execute(createEmptyDocument(), 'import_bcf', { bcf: uint8ArrayToBase64(fixture.archive) });
  expect(result.rejected, result.summary).toBeUndefined();
  return { data: result.data as Imported, summary: result.summary };
}

describe('import_bcf reports the optional BCF content it does not import', () => {
  for (const [label, fixture] of [
    ['3.0', optionalFixture30()],
    ['2.1', optionalFixture21()],
  ] as const) {
    it(`BCF ${label}: keeps the fields it has and names every dropped element`, () => {
      const { data } = importFixture(fixture);
      expect(data.created).toBe(1);
      expect(data.viewpoints).toBe(1);
      expect(data.comments).toBe(1);
      const names = data.ignored.map((item) => item.name);
      for (const expected of fixture.expectedIgnored) expect(names, expected).toContain(expected);
      const warning = data.warnings.find((item) => item.code === 'VIS_BCF_ELEMENT_IGNORED');
      expect(warning).toBeDefined();
      for (const expected of fixture.expectedIgnored) expect(warning?.message, expected).toContain(expected);
    });
  }

  it('3.0: Coloring, the AspectRatio and the comment dates are listed in data.ignored too (they are written by export_bcf, so no warning names them)', () => {
    const { data } = importFixture(optionalFixture30());
    const names = data.ignored.map((item) => item.name);
    expect(names).toEqual(
      expect.arrayContaining(['Components/Coloring', 'Camera/AspectRatio', 'ViewPoint/Snapshot', 'Topic/CreationDate']),
    );
    const message = data.warnings.find((item) => item.code === 'VIS_BCF_ELEMENT_IGNORED')?.message ?? '';
    expect(message).not.toContain('Components/Coloring');
    expect(message).not.toContain('Topic/CreationDate');
  });

  it('a file export_bcf wrote imports with no VIS_BCF_ELEMENT_IGNORED warning', () => {
    let doc = createEmptyDocument();
    const step = (name: string, params: Record<string, unknown>): string => {
      const result = execute(doc, name, params);
      expect(result.rejected, result.summary).toBeUndefined();
      doc = result.document;
      return result.affected[0] ?? '';
    };
    step('add_box', { size: [10, 10, 10] });
    step('save_viewpoint', { name: 'v', camera: { projection: 'perspective', eye: [0, -50, 20], direction: [0, 1, -0.3], fovDeg: 50 } });
    const issueId = step('create_review_issue', { title: 'T', viewpointIds: ['vp-1'], entityIds: [doc.order[0] ?? ''], labels: ['a'] });
    step('add_review_comment', { issueId, text: 'c', viewpointId: 'vp-1' });
    for (const version of ['3.0', '2.1']) {
      const exported = execute(doc, 'export_bcf', { version, snapshotWidth: 64, snapshotHeight: 48 }).data as { base64: string };
      const result = execute(createEmptyDocument(), 'import_bcf', { bcf: exported.base64 });
      const data = result.data as Imported;
      expect(data.created, version).toBe(1);
      expect(
        data.warnings.filter((item) => item.code === 'VIS_BCF_ELEMENT_IGNORED'),
        version,
      ).toEqual([]);
    }
  });
});
