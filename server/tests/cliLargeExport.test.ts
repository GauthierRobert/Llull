/**
 * @layer server/tests
 * Large text exports through the CLI never truncate silently: without --save the output names
 * --save and the full size; with --save the whole file is written.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CadExchangePort } from '@mcp/index';
import type { ExchangeOptions } from '../src/pythonExchange';
import { EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { withoutPayloads, elideLargePayloads } from '../src/cli/saveFiles';

const big = `ISO-10303-21;\n${'#1 = CARTESIAN_POINT;\n'.repeat(4000)}END-ISO-10303-21;\n`;
const bigBase64 = Buffer.from(big).toString('base64');
const port: CadExchangePort = {
  runProgram: () => Promise.resolve({ trace: null, traced: false, stepBase64: bigBase64, log: '' }),
  importStep: () => Promise.resolve({ bodies: [] }),
};
const options: ExchangeOptions = { port, dwg: null, allowCodeExecution: false };

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
      exchangeOptions: () => options,
    },
  };
}

async function docWithBox(): Promise<{ dir: string; doc: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-large-'));
  const doc = path.join(dir, 'a.llull');
  await runCli(['add_box', 'size=[1,1,1]', '--doc', doc], capture().io);
  return { dir, doc };
}

describe('large text exports through the CLI', () => {
  it('without --save: says to use --save and the full size instead of truncating', async () => {
    const { doc } = await docWithBox();
    const c = capture();
    expect(await runCli(['export_step', '--doc', doc], c.io)).toBe(EXIT_OK);
    const printed = c.out.join('\n');
    expect(printed).not.toMatch(/truncated/);
    expect(printed).toMatch(/--save/);
    expect(printed).toContain(`${bigBase64.length} chars`);
  });

  it('with --save: the full STEP round-trips to disk', async () => {
    const { dir, doc } = await docWithBox();
    const target = path.join(dir, 'big.step');
    const c = capture();
    expect(await runCli(['export_step', '--save', target, '--doc', doc], c.io)).toBe(EXIT_OK);
    expect(readFileSync(target, 'utf8')).toBe(big);
    expect(c.out.join('\n')).toContain(`Saved ${target} (${Buffer.byteLength(big)} bytes)`);
  });

  it('elideLargePayloads leaves small payloads and non-payload strings alone', () => {
    const small = { step: 'ISO-10303-21;', note: 'x'.repeat(50_000), files: [{ content: big }] };
    expect(elideLargePayloads(small)).toEqual({
      step: 'ISO-10303-21;',
      note: small.note,
      files: [
        {
          content: `<${big.length} chars; not shown, rerun with --save <path> to write the full file>`,
        },
      ],
    });
    expect(withoutPayloads({ step: 'abc' })).toEqual({ step: '<3 chars, saved>' });
  });
});
