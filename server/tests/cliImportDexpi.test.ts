/** `llull import_dexpi file=<path>` reads the Proteus XML from disk (plant 04 PID M2: one FILE_PARAMS row) and stores the sheet in the document. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';

const PACK = path.resolve(__dirname, '../../docs/plant/04-pid-schematics/validation/data/dexpi13');

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

describe('llull CLI: DEXPI files', () => {
  it('import_dexpi file= stores a sheet and pid_report counts reads it back', async () => {
    const file = readdirSync(PACK).find((name) => name.endsWith('.xml'));
    expect(file).toBeDefined();
    const doc = path.join(mkdtempSync(path.join(tmpdir(), 'llull-dexpi-')), 'a.llull');
    const imported = capture();
    expect(await runCli(['import_dexpi', `file=${path.join(PACK, file as string)}`, '--doc', doc], imported.io)).toBe(EXIT_OK);
    const sheets = Object.keys(deserializeDocument(readFileSync(doc, 'utf8')).plant?.pid?.sheets ?? {});
    expect(sheets.length).toBe(1);
    const report = capture();
    expect(await runCli(['pid_report', 'kind=counts', '--doc', doc], report.io)).toBe(EXIT_OK);
    expect(report.out.join('')).toMatch(/counts/);
  });
});
