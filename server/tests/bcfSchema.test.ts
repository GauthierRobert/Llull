/**
 * VC-VIS-15 (plant 09 VIS-M5): the BCF 3.0 files export_bcf writes validate against the buildingSMART `markup.xsd` / `visinfo.xsd` with `xmllint --schema`.
 * The schemas are CC BY-ND 4.0 and kept unmodified outside this repo's source: point `LLULL_BCF_XSD_DIR` at the folder holding `markup.xsd` and
 * `visinfo.xsd` (their includes beside them). Skipped with a logged reason when xmllint or the schemas are missing; the structural checks of
 * tests/unit/review/bcfImport.test.ts always run.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '@core/commands/registry';
import { unzip } from '@lib/zipRead';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const XSD_DIR = process.env['LLULL_BCF_XSD_DIR'] ?? '';
const hasXmllint = spawnSync('xmllint', ['--version']).error === undefined;
const hasSchemas = XSD_DIR !== '' && existsSync(join(XSD_DIR, 'markup.xsd')) && existsSync(join(XSD_DIR, 'visinfo.xsd'));
if (!hasXmllint || !hasSchemas)
  console.warn('bcfSchema: xmllint or LLULL_BCF_XSD_DIR (markup.xsd, visinfo.xsd) missing: schema validation skipped');
const schemaIt = hasXmllint && hasSchemas ? it : it.skip;

function reviewed(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): void => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
  };
  run('add_box', { size: [20, 10, 8] });
  run('save_viewpoint', { name: 'south', camera: { projection: 'perspective', eye: [0, -60, 20], direction: [0, 1, -0.3], fovDeg: 50 } });
  run('save_viewpoint', {
    name: 'plan',
    camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 60 },
  });
  run('create_review_issue', {
    title: 'Clearance',
    type: 'Clash',
    labels: ['piping'],
    description: 'd',
    assignedTo: 'jo@example.com',
    dueDate: '2026-12-01',
    viewpointIds: ['vp-1', 'vp-2'],
    entityIds: [doc.order[0] ?? ''],
  });
  run('add_review_comment', { issueId: 'iss-3', text: 'remark', viewpointId: 'vp-2' });
  return doc;
}

describe('export_bcf against the buildingSMART schemas', () => {
  schemaIt('every markup.bcf and *.bcfv validates', () => {
    const data = execute(reviewed(), 'export_bcf', { snapshots: false }).data as { base64: string };
    const dir = mkdtempSync(join(tmpdir(), 'llull-bcf-'));
    try {
      let checked = 0;
      for (const entry of unzip(Buffer.from(data.base64, 'base64'))) {
        const schema = entry.name.endsWith('markup.bcf') ? 'markup.xsd' : entry.name.endsWith('.bcfv') ? 'visinfo.xsd' : null;
        if (schema === null) continue;
        const file = join(dir, `part-${checked}.xml`);
        writeFileSync(file, entry.data);
        execFileSync('xmllint', ['--noout', '--schema', join(XSD_DIR, schema), file], { stdio: 'pipe' });
        checked += 1;
      }
      expect(checked).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
