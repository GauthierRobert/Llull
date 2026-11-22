/**
 * VC-VIS-15 (plant 09 VIS-M5, 08 DAT-VIS-FU3): every BCF file llull writes validates against the unmodified buildingSMART schemas
 * (docs/plant/09-.../validation/data/bcf_3_0 and bcf_2_1, CC BY-ND 4.0) with `xmllint --noout --schema`. Skipped by tool when xmllint is missing;
 * no network. The structural checks of tests/unit/review/bcfImport.test.ts always run.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execute } from '@core/commands/registry';
import { unzip } from '@lib/zipRead';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { drawHouseWalls } from '../../tests/helpers/runFixtures';
import { optionalFixture21, optionalFixture30 } from '../../tests/helpers/bcfOptionalFixture';
import { requireTool } from '../../tests/requireTool';

const DATA = resolve(__dirname, '../../docs/plant/09-plant-visualization-review/validation/data');
const hasXmllint = spawnSync('xmllint', ['--version']).error === undefined;
const schemaIt = it.skipIf(requireTool('oracle:xmllint', hasXmllint));

type Version = '3.0' | '2.1';
const schemaDir = (version: Version): string => join(DATA, version === '3.0' ? 'bcf_3_0' : 'bcf_2_1');

function reviewed(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): string[] => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
    return result.affected;
  };
  run('add_box', { size: [20, 10, 8], color: '#d04020' });
  run('add_cylinder', { radius: 4, height: 15, position: [-20, 0, 0], color: '#20d040' });
  run('save_viewpoint', { name: 'south', camera: { projection: 'perspective', eye: [0, -60, 20], direction: [0, 1, -0.3], fovDeg: 50 } });
  run('save_viewpoint', {
    name: 'plan',
    camera: { projection: 'orthographic', eye: [0, 0, 100], direction: [0, 0, -1], up: [0, 1, 0], viewHeight: 60 },
  });
  run('define_colour_profile', {
    id: 'by-kind',
    name: 'By kind',
    rules: [{ id: 'boxes', when: { property: 'kind', equals: 'box' }, colour: '#336699', legend: 'Boxes' }],
  });
  run('set_active_colour_profile', { profileId: 'by-kind' });
  const issueIds = run('create_review_issue', {
    title: 'Clearance <a&b>',
    type: 'Clash',
    labels: ['piping', 'a&b'],
    description: 'd',
    assignedTo: 'jo@example.com',
    dueDate: '2026-12-01',
    viewpointIds: ['vp-1', 'vp-2'],
    entityIds: [doc.order[0] ?? ''],
  });
  run('add_review_comment', { issueId: issueIds[0] ?? '', text: 'remark', viewpointId: 'vp-2' });
  run('create_review_issue', { title: 'Plain topic, no viewpoint, no label' });
  return doc;
}

function validate(dir: string, schema: string, name: string, data: Uint8Array | string): void {
  const file = join(dir, name);
  writeFileSync(file, data);
  const run = spawnSync('xmllint', ['--noout', '--schema', schema, file], { encoding: 'utf8' });
  expect(`${name}: ${run.stderr}`, `${name}: ${run.stderr}`).toBe(`${name}: ${file} validates\n`);
}

function validateArchive(version: Version, params: Record<string, unknown>): { parts: number } {
  const data = execute(reviewed(), 'export_bcf', { version, ...params }).data as { base64: string };
  const dir = mkdtempSync(join(tmpdir(), 'llull-bcf-'));
  const xsd = (name: string): string => join(schemaDir(version), `${name}.xsd`);
  try {
    let parts = 0;
    for (const entry of unzip(Buffer.from(data.base64, 'base64'))) {
      const base = entry.name.split('/').pop() ?? '';
      const schema =
        base === 'markup.bcf'
          ? 'markup'
          : base.endsWith('.bcfv')
            ? 'visinfo'
            : base === 'bcf.version'
              ? 'version'
              : base === 'extensions.xml'
                ? 'extensions'
                : null;
      if (schema === null) continue;
      validate(dir, xsd(schema), `part-${parts}.xml`, entry.data);
      parts += 1;
    }
    return { parts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('BCF files against the buildingSMART schemas (xmllint)', () => {
  for (const version of ['3.0', '2.1'] as const) {
    schemaIt(`export_bcf ${version}: version, extensions, every markup.bcf and *.bcfv validate (with snapshots and colouring)`, () => {
      // 3.0: version + extensions + 2 markups + 2 viewpoints; 2.1: no extensions.xml
      expect(validateArchive(version, { snapshotWidth: 64, snapshotHeight: 48 }).parts).toBe(version === '3.0' ? 6 : 5);
    });
    schemaIt(`export_bcf ${version} without snapshots or colours validates`, () => {
      expect(validateArchive(version, { snapshots: false, colours: false }).parts).toBe(version === '3.0' ? 6 : 5);
    });
  }

  schemaIt('control: a markup with swapped element order is rejected, so a pass means something', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llull-bcf-'));
    try {
      const file = join(dir, 'bad.xml');
      writeFileSync(file, '<Markup><Topic Guid="x"><Priority>a</Priority><Title>t</Title></Topic></Markup>');
      expect(spawnSync('xmllint', ['--noout', '--schema', join(schemaDir('3.0'), 'markup.xsd'), file]).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  schemaIt('the exported document carries Coloring and a selection (the validated files are not trivially empty)', () => {
    const data = execute(reviewed(), 'export_bcf', { snapshots: false }).data as { coloured: number; viewpoints: number };
    expect(data.coloured).toBeGreaterThan(0);
    expect(data.viewpoints).toBe(2);
  });

  schemaIt('building components carry a 22-character IfcGuid that validates (3.0 and 2.1, with colouring by kind)', () => {
    let doc = execute(createEmptyDocument(), 'add_level', { name: 'Ground' }).document;
    doc = drawHouseWalls(doc);
    const step = (name: string, params: Record<string, unknown>): void => {
      const result = execute(doc, name, params);
      expect(result.error, result.summary).toBeUndefined();
      doc = result.document;
    };
    step('save_viewpoint', { name: 'v', camera: { projection: 'perspective', eye: [0, -80, 30], direction: [0, 1, -0.3], fovDeg: 50 } });
    step('define_colour_profile', {
      id: 'walls',
      name: 'Walls',
      rules: [{ id: 'all', when: { property: 'kind', equals: 'box' }, colour: '#336699', legend: 'Boxes' }],
    });
    step('set_active_colour_profile', { profileId: 'walls' });
    const wall = Object.values(doc.building?.elements ?? {})[0]?.entityIds[0] ?? '';
    step('create_review_issue', { title: 'Wall', viewpointIds: ['vp-1'], entityIds: [wall] });
    const dir = mkdtempSync(join(tmpdir(), 'llull-bcf-'));
    try {
      for (const version of ['3.0', '2.1'] as const) {
        const exported = execute(doc, 'export_bcf', { version, snapshots: false }).data as { base64: string };
        const view = unzip(Buffer.from(exported.base64, 'base64')).find((entry) => entry.name.endsWith('.bcfv'));
        const xml = Buffer.from(view?.data ?? new Uint8Array()).toString('utf8');
        expect(xml).toMatch(/IfcGuid="[0-9A-Za-z_$]{22}"/);
        validate(dir, join(schemaDir(version), 'visinfo.xsd'), `ifc-${version}.xml`, xml);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  schemaIt('the optional-element import fixtures are themselves schema-valid (3.0 and 2.1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llull-bcf-'));
    try {
      for (const [version, fixture] of [
        ['3.0', optionalFixture30()],
        ['2.1', optionalFixture21()],
      ] as const) {
        for (const [name, text] of Object.entries(fixture.files)) {
          const schema = name.endsWith('markup.bcf') ? 'markup' : name.endsWith('.bcfv') ? 'visinfo' : 'version';
          validate(dir, join(schemaDir(version), `${schema}.xsd`), `fixture-${version}-${schema}.xml`, text);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  schemaIt('export_bcf_viewpoint validates against visinfo.xsd (perspective and orthogonal)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llull-bcf-'));
    try {
      for (const id of ['vp-1', 'vp-2']) {
        const result = execute(reviewed(), 'export_bcf_viewpoint', { id });
        const xml = (result.data as { visualizationInfo: string }).visualizationInfo;
        validate(dir, join(schemaDir('3.0'), 'visinfo.xsd'), `${id}.bcfv`, xml);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
