/** `llull ifc_summary / check_ifc_requirements / import_plant_data / import_tag_list file=<path>` read the file from disk (plant 08 DAT-M4: FILE_PARAMS rows). */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';

const PACK = path.resolve(__dirname, '../../docs/plant/08-plant-data-reports-interop/validation/data');

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  return {
    out,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    },
  };
}

describe('llull CLI: plant data files', () => {
  it('ifc_summary file= summarises the buildingSMART sample and check_ifc_requirements file= reads the IDS', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-plant-data-'));
    const doc = path.join(dir, 'a.llull');
    const summary = capture();
    expect(await runCli(['ifc_summary', `file=${path.join(PACK, 'bsi/IFC4X3_ADD2_Infra-Plumbing.ifc')}`, '--doc', doc], summary.io)).toBe(
      EXIT_OK,
    );
    expect(summary.out.join('')).toMatch(/IFC4X3_ADD2, \d+ entities/);
    const checked = capture();
    await runCli(['check_ifc_requirements', `file=${path.join(PACK, 'reference/plant-handover.ids')}`, '--doc', doc], checked.io);
    expect(checked.out.join('')).toMatch(/check_ifc_requirements/);
  });

  it('import_plant_data and import_tag_list read a CSV / xlsx file as base64 (the refusal of an empty document is a coded answer)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-plant-data-'));
    const doc = path.join(dir, 'b.llull');
    const csv = path.join(dir, 'tags.csv');
    writeFileSync(csv, 'Tag,Description\nP-101,pump\n');
    const imported = capture();
    await runCli(['import_plant_data', `file=${csv}`, '--doc', doc], imported.io);
    expect(imported.out.join('')).toMatch(/import_plant_data csv: 0 of 1 row\(s\) matched/);
    const xlsx = capture();
    await runCli(['import_plant_data', `file=${path.join(PACK, 'reference/equipment-list-sc-dat-01-edited.xlsx')}`, '--doc', doc], xlsx.io);
    expect(xlsx.out.join('')).toMatch(/import_plant_data Equipment: 0 of 2 row\(s\) matched/);
    const tags = capture();
    await runCli(['import_tag_list', `file=${csv}`, 'className=Tank', 'hierarchy=U10', '--doc', doc], tags.io);
    expect(tags.out.join('')).toMatch(/import_tag_list/);
  });
});
