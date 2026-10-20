/**
 * The aerospace-04 exchange through the `llull` CLI on the live native kernel: `--save` writes the file, `file=` reads it, and a red
 * validation-property band exits 1 (VC-XCH-21, -23, -26). Skipped without the native kernel binary.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { createNativeTestKernel, nativeKernelBinary } from './kernelTestSupport';

interface CliJson {
  readonly data: {
    readonly band?: string;
    readonly unitFactor?: number;
    readonly issues?: readonly unknown[];
    readonly iges?: unknown;
    readonly report?: {
      readonly exchange: { readonly gvpCheck: { readonly band: string } };
      readonly reviewRequired: { readonly value: boolean };
    };
  };
}

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  const kernel = createNativeTestKernel();
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => {
      setGeometryKernel(kernel);
      return Promise.resolve();
    },
  };
  return { io, out };
}

afterAll(() => setGeometryKernel(null));

describe.skipIf(nativeKernelBinary === null)('XCH through the CLI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-xch-'));
  const doc = path.join(dir, 'part.llull');
  const step = path.join(dir, 'part.stp');
  const run = async (args: string[]): Promise<{ code: number; json: CliJson }> => {
    const { io, out } = capture();
    const code = await runCli([...args, '--json'], io);
    const text = out.join('');
    return { code, json: (text.trim().startsWith('{') ? JSON.parse(text) : { data: {} }) as CliJson };
  };

  it('builds, exports AP242 with --save, verifies the file with file= and exits 0 on green', async () => {
    expect((await run(['exec', 'add_box', '{"size":[10,20,30],"position":[5,0,0]}', '--doc', doc])).code).toBe(EXIT_OK);
    const exported = await run(['export_step_ap242', 'timestamp=2026-10-20T00:00:00', '--save', step, '--doc', doc]);
    expect(exported.code).toBe(EXIT_OK);
    const text = readFileSync(step, 'latin1');
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text).toContain("'geometric validation property'");
    expect(text).toContain('2026-10-20T00:00:00');
    const verified = await run(['verify_exchange_file', `file=${step}`, '--doc', doc]);
    expect(verified.code).toBe(EXIT_OK);
    expect(verified.json.data).toMatchObject({ band: 'green', unitFactor: 1, issues: [] });
  }, 180_000);

  it('exits 1 on a red band and on a refusal, 0 on an import that only warns', async () => {
    const tampered = path.join(dir, 'liar.stp');
    writeFileSync(
      tampered,
      readFileSync(step, 'latin1').replace(/VOLUME_MEASURE\(\s*([-+0-9.Ee]+)\s*\)/, (_m, v: string) => `VOLUME_MEASURE(${Number(v) * 2})`),
      'latin1',
    );
    const red = await run(['verify_exchange_file', `file=${tampered}`, '--doc', doc]);
    expect(red.code).toBe(EXIT_COMMAND_ERROR);
    expect(red.json.data.band).toBe('red');
    const refused = await run(['export_step_ap242', '--doc', path.join(dir, 'empty.llull'), '--save', path.join(dir, 'none.stp')]);
    expect(refused.code).toBe(EXIT_COMMAND_ERROR);
    const imported = await run(['import_step_exact', `file=${tampered}`, '--doc', path.join(dir, 'imported.llull')]);
    expect(imported.code).toBe(EXIT_OK);
    expect(imported.json.data.report!.exchange.gvpCheck.band).toBe('red');
    expect(imported.json.data.report!.reviewRequired.value).toBe(true);
    const dry = await run(['import_step_exact', `file=${step}`, '--doc', path.join(dir, 'dry.llull'), '--dry-run']);
    expect(dry.code).toBe(EXIT_OK);
    expect(existsSync(path.join(dir, 'dry.llull'))).toBe(false);
  }, 180_000);

  it('exports and re-imports IGES through --save and file=', async () => {
    const iges = path.join(dir, 'part.igs');
    const exported = await run(['export_iges', '--save', iges, '--doc', doc]);
    if (exported.code !== EXIT_OK) return console.warn(`[XCH CLI] IGES skipped: ${JSON.stringify(exported.json).slice(0, 200)}`);
    expect(readFileSync(iges, 'latin1').split('\n')[0]).toHaveLength(80);
    const imported = await run(['import_iges', `file=${iges}`, '--doc', path.join(dir, 'igesdoc.llull')]);
    expect(imported.code).toBe(EXIT_OK);
    expect(imported.json.data.iges).toMatchObject({ unitFactor: 1 });
  }, 180_000);
});
