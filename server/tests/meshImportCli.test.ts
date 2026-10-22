/**
 * 07 MSH through the `llull` CLI: `file=PATH` fills `import_mesh_file`, plans resolve `file` in every action (loops included), and the host
 * installs the Manifold mesh engine next to the B-rep kernel.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { getMeshProcessingEngine, setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { withPlanFileContent } from '../src/cli/exchange';
import { installGeometryKernel } from '../src/geometryKernel';

const STL = path.join(
  import.meta.dirname,
  '..',
  '..',
  'docs',
  'design',
  '07-mesh-modeling',
  'validation',
  'data',
  'icosphere_r10_l1_binary.stl',
);

interface CliJson {
  readonly data: {
    readonly triangles?: number;
    readonly volume?: number;
    readonly unverified?: boolean;
    readonly steps?: ReadonlyArray<{ readonly command: string; readonly ok: boolean }>;
  };
  readonly isError?: boolean;
}

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: async () => {
      await installGeometryKernel({ env: { LLULL_KERNEL: 'manifold' } });
    },
  };
  return { io, out };
}

async function run(args: string[]): Promise<{ code: number; json: CliJson }> {
  const { io, out } = capture();
  const code = await runCli([...args, '--json'], io);
  const text = out.join('');
  return { code, json: (text.trim().startsWith('{') ? JSON.parse(text) : { data: {} }) as CliJson };
}

afterAll(() => {
  setGeometryKernel(null);
  setMeshProcessingEngine(null);
});

describe('mesh import through the CLI', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'llull-msh-'));

  it('reads the STL with file=, converts nothing for mm and installs the Manifold mesh engine', async () => {
    const doc = path.join(dir, 'single.llull');
    const result = await run(['import_mesh_file', `file=${STL}`, 'units=mm', '--doc', doc]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.json.data.triangles).toBe(80);
    expect(result.json.data.volume).toBeCloseTo(3658.71216465, 6);
    expect(result.json.data.unverified).toBe(true);
    expect(readFileSync(doc, 'utf8')).toContain('"kind":"mesh"');
    expect(getMeshProcessingEngine()?.name).toBe('manifold');
  });

  it('exits 1 with the stable code when units are missing', async () => {
    const result = await run(['import_mesh_file', `file=${STL}`, '--doc', path.join(dir, 'nounits.llull')]);
    expect(result.code).toBe(EXIT_COMMAND_ERROR);
  });

  it('resolves file in plan actions, loop bodies included, and a plan imports then analyses', async () => {
    const plan = path.join(dir, 'plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        actions: [
          { command: 'import_mesh_file', params: { file: STL, units: 'mm' }, as: 'scan' },
          { command: 'analyze_mesh', params: { id: '$scan' } },
          { repeat: { count: 1 }, actions: [{ command: 'import_mesh_file', params: { file: STL, units: 'mm' } }] },
        ],
      }),
    );
    const result = await run(['run', plan, '--doc', path.join(dir, 'plan.llull')]);
    expect(result.code).toBe(EXIT_OK);
    expect(result.json.data.steps?.map((step) => step.command)).toEqual(['import_mesh_file', 'analyze_mesh', 'import_mesh_file']);
  });

  it('withPlanFileContent leaves other actions, steps and non-record entries untouched and reads files for file-taking commands', () => {
    const actions = [
      'not an action',
      { command: 'add_box', params: { file: 'ignored' } },
      { step: { command: 'import_mesh_file', params: { file: STL, units: 'mm' } } },
      { actions: [{ command: 'import_mesh_file', params: { file: STL } }] },
    ];
    const resolved = withPlanFileContent(actions) as Array<Record<string, unknown>>;
    expect(resolved[0]).toBe('not an action');
    expect(resolved[1]).toEqual(actions[1]);
    const step = resolved[2]?.['step'] as { params: Record<string, unknown> };
    expect(typeof step.params['base64']).toBe('string');
    expect(step.params['file']).toBeUndefined();
    const nested = (resolved[3]?.['actions'] as Array<{ params: Record<string, unknown> }>)[0];
    expect(typeof nested?.params['base64']).toBe('string');
  });
});
