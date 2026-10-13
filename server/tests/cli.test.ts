/**
 * `llull` CLI end to end through `runCli` with an in-memory I/O port: local document files
 * (exec, run, new, undo/redo, --save, --dry-run) and the --server backend over a fake fetch.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  readonly fetched: { url: string; body: unknown; auth: string | null }[];
}

function capture(options: { stdin?: string; env?: Record<string, string>; reply?: unknown; status?: number } = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const fetched: Captured['fetched'] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    env: options.env ?? {},
    prepareKernel: () => Promise.resolve(),
    fetchImpl: (url, init) => {
      const headers = new Headers(init.headers);
      fetched.push({ url, body: JSON.parse(String(init.body)) as unknown, auth: headers.get('Authorization') });
      if (options.reply === 'throw') return Promise.reject(new Error('ECONNREFUSED'));
      const text = typeof options.reply === 'string' ? options.reply : JSON.stringify(options.reply);
      return Promise.resolve(new Response(text, { status: options.status ?? 200 }));
    },
  };
  return { io, out, err, fetched };
}

let workDir = '';
let docPath = '';
const docFlag = (): string[] => ['--doc', docPath];
const entityIds = (): string[] => Object.keys(deserializeDocument(readFileSync(docPath, 'utf8')).entities);

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'llull-cli-'));
  docPath = path.join(workDir, 'part.llull.json');
});

describe('llull CLI — discovery', () => {
  it('prints usage for no args / help / --help', async () => {
    for (const argv of [[], ['help'], ['list', '--help']]) {
      const c = capture();
      expect(await runCli(argv, c.io)).toBe(EXIT_OK);
      expect(c.out.join('')).toMatch(/^llull — /);
    }
  });

  it('lists, searches, describes and prints toolsets and the guide', async () => {
    const list = capture();
    expect(await runCli(['list', '2d'], list.io)).toBe(EXIT_OK);
    expect(list.out[0]).toMatch(/^draw_\w+ \[2d\]/m);

    const json = capture();
    await runCli(['list', '--toolset', 'measure', '--json'], json.io);
    expect(JSON.parse(json.out[0] ?? '')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'mass_properties', readOnly: true })]),
    );

    const search = capture();
    await runCli(['search', 'polar', 'array', '--limit', '2'], search.io);
    expect(search.out[0]).toMatch(/^array_polar/);

    const describeBoth = capture();
    await runCli(['describe', 'add_box', 'add_sphere', '--json'], describeBoth.io);
    expect(JSON.parse(describeBoth.out[0] ?? '')).toHaveLength(2);

    const toolsets = capture();
    await runCli(['toolsets'], toolsets.io);
    expect(toolsets.out[0]).toMatch(/^core: \d+ command\(s\)/);

    const guide = capture();
    await runCli(['guide'], guide.io);
    expect(guide.out[0]).toMatch(/Conventions/);
  });

  it('rejects unknown subcommands, toolsets and commands with hints (exit 2)', async () => {
    const cases: [string[], RegExp][] = [
      [['frobnicate'], /unknown subcommand/],
      [['list', 'nope'], /unknown toolset/],
      [['describe', 'add_bx'], /Did you mean: .*add_box/],
      [['describe'], /needs a command name/],
      [['search'], /needs words/],
      [['exec'], /needs a command name/],
      [['run'], /needs a plan/],
    ];
    for (const [argv, message] of cases) {
      const c = capture();
      expect(await runCli(argv, c.io)).toBe(EXIT_USAGE);
      expect(c.err.join('\n')).toMatch(message);
    }
  });

  it('reports a search with no match without failing', async () => {
    const c = capture();
    expect(await runCli(['search', 'zzzqqq'], c.io)).toBe(EXIT_OK);
    expect(c.out[0]).toMatch(/No command matches/);
  });
});

describe('llull CLI — local document', () => {
  it('creates the document on the first change and appends to it', async () => {
    const first = capture();
    expect(await runCli(['exec', 'add_box', 'size=[10,10,10]', ...docFlag()], first.io)).toBe(EXIT_OK);
    expect(first.out[0]).toMatch(/Added box box-1\.1/);
    const shorthand = capture();
    expect(await runCli(['add_sphere', '{"radius":3}', ...docFlag()], shorthand.io)).toBe(EXIT_OK);
    expect(entityIds()).toEqual(['box-1.1', 'sph-2.1']);
  });

  it('reads params from @file and stdin, and uses $LLULL_DOC', async () => {
    const paramsFile = path.join(workDir, 'p.json');
    writeFileSync(paramsFile, '{"radius":2,"height":4}');
    await runCli(['exec', 'add_cylinder', `@${paramsFile}`, ...docFlag()], capture().io);
    const viaStdin = capture({ stdin: '{"size":[1,2,3]}', env: { LLULL_DOC: docPath } });
    expect(await runCli(['exec', 'add_box', '-'], viaStdin.io)).toBe(EXIT_OK);
    expect(entityIds()).toHaveLength(2);
  });

  it('loads key=@img:<file> as an image data URL (add_image_underlay)', async () => {
    const scan = path.join(workDir, 'scan.png');
    const size = (n: number): number[] => [0, 0, n >> 8, n & 255];
    const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...size(300), ...size(150), 8, 6, 0, 0, 0];
    writeFileSync(scan, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr]));
    const added = capture();
    const argv = ['exec', 'add_image_underlay', `dataUrl=@img:${scan}`, 'pixelSize=1.5'];
    expect(await runCli([...argv, ...docFlag()], added.io)).toBe(EXIT_OK);
    expect(added.out[0]).toMatch(/\(300×150 px\) as 450×225 units/);
    const notImage = path.join(workDir, 'notes.txt');
    writeFileSync(notImage, 'hello');
    const rejected = capture();
    const bad = ['exec', 'add_image_underlay', `dataUrl=@img:${notImage}`, ...docFlag()];
    expect(await runCli(bad, rejected.io)).toBe(EXIT_USAGE);
    expect(rejected.err[0]).toMatch(/not a PNG or JPEG/);
    const missing = capture();
    const gone = ['exec', 'add_image_underlay', 'dataUrl=@img:gone.png', ...docFlag()];
    expect(await runCli(gone, missing.io)).toBe(EXIT_USAGE);
    expect(missing.err[0]).toMatch(/cannot read gone\.png/);
  });

  it('exits 1 on a rejected command and 2 on unreadable params', async () => {
    const rejected = capture();
    expect(await runCli(['exec', 'add_box', 'size=[-1,1,1]', ...docFlag()], rejected.io)).toBe(EXIT_COMMAND_ERROR);
    expect(rejected.out[0]).toMatch(/add_box failed: size must be/);
    expect(existsSync(docPath)).toBe(false);

    const badJson = capture();
    expect(await runCli(['exec', 'add_box', '{oops', ...docFlag()], badJson.io)).toBe(EXIT_USAGE);
    const missing = capture();
    expect(await runCli(['exec', 'add_box', '@nowhere.json', ...docFlag()], missing.io)).toBe(EXIT_USAGE);
    expect(missing.err[0]).toMatch(/cannot read nowhere\.json/);
    const pairs = capture();
    expect(await runCli(['exec', 'add_box', 'width', ...docFlag()], pairs.io)).toBe(EXIT_USAGE);
  });

  it('runs, validates and continues build_project plans with a per-step report', async () => {
    const planPath = path.join(workDir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify([
        { command: 'add_box', params: { size: [20, 20, 20] }, as: 'body' },
        { command: 'add_cylinder', params: { radius: 4, height: 30 }, as: 'hole' },
        { command: 'boolean', params: { op: 'subtract', a: '$body', b: '$hole' } },
      ]),
    );
    const validate = capture();
    expect(await runCli(['run', planPath, '--validate', ...docFlag()], validate.io)).toBe(EXIT_OK);
    expect(existsSync(docPath)).toBe(false);

    const apply = capture();
    expect(await runCli(['run', planPath, ...docFlag()], apply.io)).toBe(EXIT_OK);
    expect(apply.out[0]).toMatch(/#2 ok {3}boolean/);
    expect(entityIds()).toEqual(['mesh-3.1']);

    const failing = capture({
      stdin: JSON.stringify({
        actions: [
          { command: 'add_box', params: {} },
          { command: 'add_sphere', params: { radius: 1 } },
        ],
      }),
    });
    expect(await runCli(['run', '-', '--continue', '--json', ...docFlag()], failing.io)).toBe(EXIT_COMMAND_ERROR);
    const report = JSON.parse(failing.out[0] ?? '') as { data: { steps: { ok: boolean }[] } };
    expect(report.data.steps.map((step) => step.ok)).toEqual([false, true]);

    const notAPlan = capture({ stdin: '{"steps":[]}' });
    expect(await runCli(['run', '-', ...docFlag()], notAPlan.io)).toBe(EXIT_USAGE);
  });

  it('ends a run report with the plan aliases that survive in the document', async () => {
    const plan = [
      { command: 'add_box', params: { size: [20, 20, 20] }, as: 'body' },
      { command: 'add_cylinder', params: { radius: 4, height: 30 }, as: 'hole' },
      { command: 'boolean', params: { op: 'subtract', a: '$body', b: '$hole' }, as: 'part' },
    ];
    const text = capture({ stdin: JSON.stringify(plan) });
    expect(await runCli(['run', '-', ...docFlag()], text.io)).toBe(EXIT_OK);
    expect(text.out[0]).toMatch(/\nAliases: part=mesh-3\.1\nConsumed: body, hole$/);

    const json = capture({ stdin: JSON.stringify(plan) });
    await runCli(['run', '-', '--json', '--force', ...docFlag()], json.io);
    const report = JSON.parse(json.out[0] ?? '') as { aliases: Record<string, string[]>; consumedAliases: string[] };
    expect(report.aliases).toEqual({ part: expect.any(Array) });
    expect(report.consumedAliases).toEqual(['body', 'hole']);
  });

  it('prints the per-step report with issues for an invalid plan', async () => {
    const c = capture({ stdin: '[{"command":"no_such_command"}]' });
    expect(await runCli(['run', '-', '--validate', ...docFlag()], c.io)).toBe(EXIT_COMMAND_ERROR);
    expect(c.out[0]).toMatch(/no_such_command/);
  });

  it('--dry-run reports the change without writing the file', async () => {
    const c = capture();
    expect(await runCli(['exec', 'add_box', 'size=[1,1,1]', '--dry-run', ...docFlag()], c.io)).toBe(EXIT_OK);
    expect(c.out[0]).toMatch(/Added box/);
    expect(existsSync(docPath)).toBe(false);
  });

  it('--save writes export payloads and keeps only metadata in the output', async () => {
    await runCli(['exec', 'add_box', 'size=[5,5,5]', ...docFlag()], capture().io);
    const stlPath = path.join(workDir, 'out', 'part.stl');
    const stl = capture();
    expect(await runCli(['exec', 'export_stl', 'format=binary', '--save', stlPath, '--json', ...docFlag()], stl.io)).toBe(EXIT_OK);
    const printed = JSON.parse(stl.out[0] ?? '') as { data: { stlBase64: string }; saved: { path: string; bytes: number }[] };
    expect(printed.data.stlBase64).toMatch(/chars, saved>$/);
    expect(printed.saved[0]).toEqual({ path: stlPath, bytes: 84 + 12 * 50 });
    expect(readFileSync(stlPath)).toHaveLength(84 + 12 * 50);

    const png = capture();
    expect(await runCli(['render_view', '--save', path.join(workDir, 'v.png'), ...docFlag()], png.io)).toBe(EXIT_OK);
    expect(png.out[0]).toMatch(/Saved .*v\.png/);

    const nothing = capture();
    expect(await runCli(['describe_scene', '--save', path.join(workDir, 'x.txt'), ...docFlag()], nothing.io)).toBe(EXIT_COMMAND_ERROR);
    expect(nothing.err.join('\n')).toMatch(/no file payload/);
  });

  it('--quiet prints nothing on success but still prints errors', async () => {
    const ok = capture();
    await runCli(['add_box', 'size=[1,1,1]', '--quiet', ...docFlag()], ok.io);
    expect(ok.out).toEqual([]);
    const failed = capture();
    await runCli(['add_box', '--quiet', ...docFlag()], failed.io);
    expect(failed.out[0]).toMatch(/rejected/);
  });

  it('new refuses to overwrite without --force; undo/redo swap with the .bak copy', async () => {
    expect(await runCli(['new', ...docFlag()], capture().io)).toBe(EXIT_OK);
    expect(await runCli(['new', ...docFlag()], capture().io)).toBe(EXIT_USAGE);
    await runCli(['add_box', 'size=[1,1,1]', ...docFlag()], capture().io);
    expect(entityIds()).toHaveLength(1);

    const undo = capture();
    expect(await runCli(['undo', ...docFlag()], undo.io)).toBe(EXIT_OK);
    expect(entityIds()).toHaveLength(0);
    await runCli(['redo', ...docFlag()], capture().io);
    expect(entityIds()).toHaveLength(1);
    expect(await runCli(['new', '--force', ...docFlag()], capture().io)).toBe(EXIT_OK);
    expect(entityIds()).toHaveLength(0);

    const dryUndo = capture();
    await runCli(['undo', '--dry-run', ...docFlag()], dryUndo.io);
    expect(entityIds()).toHaveLength(0);

    const fresh = capture();
    await runCli(['undo', '--doc', path.join(workDir, 'other.json')], fresh.io);
    expect(fresh.out[0]).toMatch(/Nothing to undo/);
  });
});

describe('llull CLI — reviewer regressions', () => {
  it('rejects a value flag without its value instead of ignoring it', async () => {
    for (const argv of [
      ['add_box', 'size=[1,1,1]', '--server'],
      ['export_stl', '--save'],
    ]) {
      const c = capture();
      expect(await runCli([...argv, ...docFlag()], c.io)).toBe(EXIT_USAGE);
      expect(c.err[0]).toMatch(/needs a value/);
    }
    expect(existsSync(docPath)).toBe(false);
  });

  it('keeps string params as strings in key=value form', async () => {
    await runCli(['add_box', 'size=[1,1,1]', ...docFlag()], capture().io);
    const named = capture();
    expect(await runCli(['set_entity_name', 'id=box-1.1', 'name=123', ...docFlag()], named.io)).toBe(EXIT_OK);
    const doc = deserializeDocument(readFileSync(docPath, 'utf8'));
    expect(doc.entities['box-1.1']?.name).toBe('123');
  });

  it('exempts idempotent setters from the changed-nothing failure', async () => {
    await runCli(['new', ...docFlag()], capture().io);
    expect(await runCli(['set_units', 'units=mm', ...docFlag()], capture().io)).toBe(EXIT_OK);
    expect(await runCli(['set_units', 'units=mm', ...docFlag()], capture().io)).toBe(EXIT_OK);
  });

  it('still reports the result when --save fails', async () => {
    await runCli(['add_box', 'size=[1,1,1]', ...docFlag()], capture().io);
    const c = capture();
    expect(await runCli(['measure_bounding_box', 'id=box-1.1', '--save', path.join(workDir, 'b.txt'), ...docFlag()], c.io)).toBe(
      EXIT_COMMAND_ERROR,
    );
    expect(c.err.join('\n')).toMatch(/--save: .*no file payload/);
    expect(c.err[0]).not.toMatch(/^llull:/);
  });

  it('runs through the real launcher (esbuild bundle + path aliases)', async () => {
    const launcher = path.resolve(__dirname, '..', 'bin', 'llull.cjs');
    const { stdout } = await promisify(execFile)(process.execPath, [launcher, 'add_box', 'size=[2,2,2]', '--doc', docPath]);
    expect(stdout).toMatch(/Added box box-1\.1/);
    expect(entityIds()).toEqual(['box-1.1']);
  }, 60_000);
});

describe('llull CLI — --server backend', () => {
  const server = ['--server', 'http://cad.local:3001/'];

  it('posts commands to /command with the bearer token and prints the bus result', async () => {
    const c = capture({
      reply: { summary: 'Added box box-1.1.', affected: ['box-1.1'], isError: false, changed: true },
      env: { LLULL_TOKEN: 'secret' },
    });
    expect(await runCli(['add_box', 'size=[1,1,1]', ...server], c.io)).toBe(EXIT_OK);
    expect(c.fetched[0]).toEqual({
      url: 'http://cad.local:3001/command',
      body: { name: 'add_box', params: { size: [1, 1, 1] } },
      auth: 'Bearer secret',
    });
    expect(c.out[0]).toMatch(/Affected entity ids: box-1\.1/);
  });

  it('routes undo/redo to the server and surfaces HTTP and network errors', async () => {
    const undo = capture({ reply: { summary: 'Undid last change.', affected: [], changed: true } });
    await runCli(['undo', '--server', 'http://h', '--token', 't'], undo.io);
    await runCli(['redo', '--server', 'http://h'], undo.io);
    expect(undo.fetched.map((f) => f.url)).toEqual(['http://h/undo', 'http://h/redo']);

    const denied = capture({ reply: { error: 'Unauthorized' }, status: 401 });
    expect(await runCli(['add_box', 'size=[1,1,1]', ...server], denied.io)).toBe(EXIT_COMMAND_ERROR);
    expect(denied.out[0]).toMatch(/HTTP 401: Unauthorized/);

    const html = capture({ reply: '<html>gateway</html>', status: 502 });
    expect(await runCli(['add_box', 'size=[1,1,1]', ...server], html.io)).toBe(EXIT_COMMAND_ERROR);

    const down = capture({ reply: 'throw', env: { LLULL_SERVER: 'http://down' } });
    expect(await runCli(['add_box', 'size=[1,1,1]'], down.io)).toBe(EXIT_COMMAND_ERROR);
    expect(down.out[0]).toMatch(/Cannot reach the llull server at http:\/\/down/);
  });

  it('refuses local-only operations against a server', async () => {
    const dry = capture();
    expect(await runCli(['add_box', 'size=[1,1,1]', '--dry-run', ...server], dry.io)).toBe(EXIT_USAGE);
    const fresh = capture();
    expect(await runCli(['new', ...server], fresh.io)).toBe(EXIT_USAGE);
    expect(dry.fetched).toEqual([]);
  });
});
