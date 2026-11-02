/** `llull import_pcf file=<path>` reads the PCF text from disk (plant 05 ISO M1: one FILE_PARAMS row) and `export_pcf --save` writes the file back byte-equal. */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';

const PCF = [
  'ISOGEN-FILES ISOGEN.FLS',
  'UNITS-BORE MM',
  'UNITS-CO-ORDS MM',
  'UNITS-BOLT-DIA MM',
  'UNITS-BOLT-LENGTH MM',
  'PIPELINE-REFERENCE CLI-1',
  'PIPE',
  '    COMPONENT-IDENTIFIER 1',
  '    END-POINT 0.0 0.0 0.0 100 BW',
  '    END-POINT 1000.0 0.0 0.0 100 BW',
  '',
].join('\n');

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

describe('llull CLI: PCF files', () => {
  it('import_pcf file= stores the line, export_pcf --save writes the same bytes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-pcf-'));
    const pcf = path.join(dir, 'line.pcf');
    const doc = path.join(dir, 'a.llull');
    writeFileSync(pcf, PCF);
    const imported = capture();
    expect(await runCli(['import_pcf', `file=${pcf}`, '--doc', doc], imported.io)).toBe(EXIT_OK);
    expect(imported.out[0]).toMatch(/stored line CLI-1/);
    expect(deserializeDocument(readFileSync(doc, 'utf8')).plant?.fabrication?.pcfLines['CLI-1']?.components).toHaveLength(1);
    const outDir = `${path.join(dir, 'out')}/`;
    expect(await runCli(['export_pcf', '--save', outDir, '--doc', doc], capture().io)).toBe(EXIT_OK);
    expect(readFileSync(path.join(outDir, 'CLI-1.pcf'), 'utf8')).toBe(PCF);
  });

  it('import_pcf file= as=route reaches the route mode: a document without the spec is refused with the RTE code', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-pcf-route-'));
    const pcf = path.join(dir, 'line.pcf');
    const doc = path.join(dir, 'a.llull');
    writeFileSync(pcf, PCF);
    const refused = capture();
    expect(await runCli(['import_pcf', `file=${pcf}`, 'as=route', 'spec=CS150', '--doc', doc], refused.io)).toBe(EXIT_COMMAND_ERROR);
    expect(refused.out.join('')).toMatch(/RTE_SPEC_UNKNOWN/);
  });
});
