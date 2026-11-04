/** `llull exec <command> --param-file FILE`: the params of a command from a JSON object file (or stdin), `key=value` pairs overriding its keys. */

import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function capture(stdin = ''): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(stdin),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  return { io, out, err };
}

let workDir = '';
let docPath = '';
const docFlag = (): string[] => ['--doc', docPath];
const write = (name: string, content: string): string => {
  const file = path.join(workDir, name);
  writeFileSync(file, content);
  return file;
};
const entities = (): Record<string, { kind: string; size?: number[]; radius?: number }> =>
  deserializeDocument(readFileSync(docPath, 'utf8')).entities as never;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'llull-param-file-'));
  docPath = path.join(workDir, 'part.llull.json');
});

describe('llull exec --param-file', () => {
  it('runs the command with the params of the file', async () => {
    const file = write('box.json', '{"size":[10,20,30]}');
    const run = capture();
    expect(await runCli(['exec', 'add_box', '--param-file', file, ...docFlag()], run.io)).toBe(EXIT_OK);
    expect(run.out[0]).toMatch(/Added box box-1\.1/);
    expect(Object.values(entities())[0]).toMatchObject({ kind: 'box', size: [10, 20, 30] });
  });

  it('works with the shorthand and the --param-file=FILE form, and reads stdin for -', async () => {
    const file = write('sphere.json', '{"radius":3}');
    expect(await runCli(['add_sphere', `--param-file=${file}`, ...docFlag()], capture().io)).toBe(EXIT_OK);
    const viaStdin = capture('{"size":[1,2,3]}');
    expect(await runCli(['exec', 'add_box', '--param-file', '-', ...docFlag()], viaStdin.io)).toBe(EXIT_OK);
    expect(Object.values(entities()).map((entity) => entity.kind)).toEqual(['sphere', 'box']);
  });

  it('key=value pairs override the keys of the file', async () => {
    const file = write('cylinder.json', '{"radius":2,"height":4}');
    expect(await runCli(['exec', 'add_cylinder', '--param-file', file, 'radius=5', ...docFlag()], capture().io)).toBe(EXIT_OK);
    expect(Object.values(entities())[0]).toMatchObject({ kind: 'cylinder', radius: 5 });
  });

  it('is a usage error (exit 2, nothing written) for a missing file, invalid JSON, a non-object, a missing value, or a JSON literal beside the flag', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['exec', 'add_box', '--param-file', path.join(workDir, 'nowhere.json')], /cannot read .*nowhere\.json/],
      [['exec', 'add_box', '--param-file', write('bad.json', '{oops')], /is not valid JSON/],
      [['exec', 'add_box', '--param-file', write('list.json', '[1,2]')], /must hold one JSON object/],
      [['exec', 'add_box', '--param-file'], /param-file/],
      [['exec', 'add_box', '{"size":[1,1,1]}', '--param-file', write('ok.json', '{}')], /only key=value overrides/],
    ];
    for (const [argv, message] of cases) {
      const run = capture();
      expect(await runCli([...argv, ...docFlag()], run.io), argv.join(' ')).toBe(EXIT_USAGE);
      expect(run.err.join('\n'), argv.join(' ')).toMatch(message);
    }
    expect(() => readFileSync(docPath, 'utf8')).toThrow();
  });

  it('a command failure is still exit 1 with the command message (the params came from the file)', async () => {
    const file = write('bad-size.json', '{"size":[-1,1,1]}');
    const run = capture();
    expect(await runCli(['exec', 'add_box', '--param-file', file, ...docFlag()], run.io)).toBe(EXIT_COMMAND_ERROR);
    expect(run.out[0]).toMatch(/add_box failed: size must be/);
  });
});
