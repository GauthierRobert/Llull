/**
 * `llull --progress` and Ctrl-C on a long native mesh job (TECHNICAL_SPEC 13.8), local (`--doc`) and against a backend (`--server`), with a fake engine
 * on the real host path: the reports go to stderr in order, stdout stays one clean JSON object, Ctrl-C cancels the command and kills the job.
 */

import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { cuboid, docWithMeshes } from '../../tests/helpers/meshFixtures';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { readDocumentFile, writeDocumentFile } from '../src/documentFile';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { _clearResultCache, _runningJobCount } from '../src/native/deferredRun';
import { createFakeEngine, type FakeEngine } from './fakeNativeEngine';

interface Captured {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  /** Ctrl-C listening: how often it was armed and how often disarmed. */
  readonly interrupt: { armed: number; disarmed: number };
}

const capture = (signal?: AbortSignal, stdin = '', tick?: number, env: Record<string, string> = {}): Captured => {
  const out: string[] = [];
  const err: string[] = [];
  const interrupt = { armed: 0, disarmed: 0 };
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    readStdin: () => Promise.resolve(stdin),
    ...(tick !== undefined
      ? {
          now: (
            (clock = 0) =>
            () =>
              (clock += tick)
          )(),
        }
      : {}),
    env,
    prepareKernel: () => Promise.resolve(),
    armInterrupt: () => {
      interrupt.armed += 1;
      return () => void (interrupt.disarmed += 1);
    },
    ...(signal !== undefined ? { signal } : {}),
  };
  return { io, out, err, interrupt };
};

let fake: FakeEngine;
let docPath = '';
let meshId = '';

beforeEach(() => {
  fake = createFakeEngine(600);
  setMeshProcessingEngine(fake.engine);
  _clearResultCache();
  const { doc, ids } = docWithMeshes(cuboid([-5, -5, -5], [5, 5, 5]));
  meshId = ids[0] as string;
  docPath = path.join(mkdtempSync(path.join(tmpdir(), 'llull-meshjobs-')), 'part.llull.json');
  writeDocumentFile(docPath, doc);
  _resetLiveDoc(doc);
  _resetHistory();
});

afterEach(() => {
  setMeshProcessingEngine(null);
});

const remesh = (): string[] => ['exec', 'quad_remesh', `id=${meshId}`, 'targetQuadCount=6'];
const stageLines = /^\[quad_remesh\] (stage \d|quad_remesh starting)/;

describe('llull exec quad_remesh --doc', () => {
  it('--progress prints the job reports to stderr in order and leaves stdout one JSON object', async () => {
    const c = capture();
    expect(await runCli([...remesh(), '--progress', '--json', '--doc', docPath], c.io)).toBe(EXIT_OK);
    expect(c.err.length).toBeGreaterThanOrEqual(4);
    expect(c.err.every((line) => stageLines.test(line))).toBe(true);
    const stages = c.err.filter((line) => /\(stage \d\/4\)/.test(line)).map((line) => /\(stage (\d)\/4\)/.exec(line)?.[1]);
    expect(stages).toEqual(['1', '2', '3', '4']);
    expect(c.out).toHaveLength(1);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: true, changed: true });
    expect(Object.keys(readDocumentFile(docPath).entities)).toHaveLength(2);
    expect(_runningJobCount()).toBe(0);
    expect(c.interrupt).toEqual({ armed: 1, disarmed: 1 });
  });

  it('a command that needs no job never listens for Ctrl-C: a blocking step must stay interruptible by the OS', async () => {
    const c = capture();
    expect(await runCli(['exec', 'add_box', 'size=[1,1,1]', '--json', '--doc', docPath], c.io)).toBe(EXIT_OK);
    expect(c.interrupt).toEqual({ armed: 0, disarmed: 0 });
  });

  it('a plan reports each step once, as it ended in the run that stands: the step that needed the job has its [k/N] line and durationMs', async () => {
    const plan = JSON.stringify([
      { command: 'add_box', params: { size: [1, 1, 1] } },
      { command: 'quad_remesh', params: { id: meshId, targetQuadCount: 6 } },
      { command: 'add_box', params: { size: [2, 2, 2] } },
    ]);
    const c = capture(undefined, plan, 1500);
    expect(await runCli(['run', '-', '--progress', '--json', '--doc', docPath], c.io)).toBe(EXIT_OK);
    const steps = c.err.filter((line) => /^\[\d\/3\]/.test(line));
    expect(steps).toEqual(['[1/3] add_box … 1.5s', '[2/3] quad_remesh … 1.5s', '[3/3] add_box … 1.5s']);
    const report = JSON.parse(c.out[0] as string) as { data: { steps: { durationMs?: number }[] } };
    expect(report.data.steps.map((step) => typeof step.durationMs)).toEqual(['number', 'number', 'number']);
    expect(Object.keys(readDocumentFile(docPath).entities)).toHaveLength(4);
  });

  it('--timeout stops a native job the child awaits: MESH_TIMEOUT, the job is killed, nothing is saved', async () => {
    const c = capture();
    expect(await runCli([...remesh(), '--timeout', '0.25', '--json', '--doc', docPath], c.io)).toBe(EXIT_COMMAND_ERROR);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: false, error: { code: 'MESH_TIMEOUT' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.killed()).toBe(1);
    expect(Object.keys(readDocumentFile(docPath).entities)).toHaveLength(1);
  });

  it('the supervisor absolute deadline counts from its start: a slow boot does not push the clean MESH_TIMEOUT past the kill', async () => {
    const c = capture(undefined, '', undefined, { LLULL_CLI_DEADLINE_MS: String(Date.now() + 250) });
    const started = performance.now();
    expect(await runCli([...remesh(), '--timeout', '60', '--json', '--doc', docPath], c.io)).toBe(EXIT_COMMAND_ERROR);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: false, error: { code: 'MESH_TIMEOUT' } });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Object.keys(readDocumentFile(docPath).entities)).toHaveLength(1);
  });

  it('an injected clock ignores the supervisor epoch deadline, as the step observer does', async () => {
    const c = capture(undefined, '', 1, { LLULL_CLI_DEADLINE_MS: String(Date.now() + 100) });
    expect(await runCli([...remesh(), '--timeout', '60', '--json', '--doc', docPath], c.io)).toBe(EXIT_OK);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: true });
  });

  it('without --progress nothing but the answer is printed', async () => {
    const c = capture();
    expect(await runCli([...remesh(), '--json', '--doc', docPath], c.io)).toBe(EXIT_OK);
    expect(c.err).toEqual([]);
    expect(c.out).toHaveLength(1);
  });

  it('Ctrl-C cancels the command: the job is killed, nothing is saved, the answer names MESH_CANCELLED', async () => {
    const interrupt = new AbortController();
    const c = capture(interrupt.signal);
    const running = runCli([...remesh(), '--progress', '--json', '--doc', docPath], c.io);
    await new Promise((resolve) => setTimeout(resolve, 200));
    interrupt.abort();
    expect(await running).toBe(EXIT_COMMAND_ERROR);
    expect(fake.killed()).toBe(1);
    expect(_runningJobCount()).toBe(0);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: false, error: { code: 'MESH_CANCELLED' } });
    expect(Object.keys(readDocumentFile(docPath).entities)).toHaveLength(1);
  });
});

describe('llull exec quad_remesh --server', () => {
  let server: Server;
  let url = '';

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('--progress prints what the backend streams, in order, and the answer is the command result', async () => {
    const c = capture();
    expect(await runCli([...remesh(), '--progress', '--json', '--server', url], c.io)).toBe(EXIT_OK);
    const stages = c.err.filter((line) => /\(stage \d\/4\)/.test(line)).map((line) => /\(stage (\d)\/4\)/.exec(line)?.[1]);
    expect(stages).toEqual(['1', '2', '3', '4']);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: true, changed: true });
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(2);
    expect(c.interrupt).toEqual({ armed: 1, disarmed: 1 });
  });

  it('Ctrl-C closes the connection: the backend kills the job and applies nothing', async () => {
    const interrupt = new AbortController();
    const c = capture(interrupt.signal);
    const running = runCli([...remesh(), '--json', '--server', url], c.io);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(_runningJobCount()).toBe(1);
    interrupt.abort();
    expect(await running).toBe(EXIT_COMMAND_ERROR);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.killed()).toBe(1);
    expect(_runningJobCount()).toBe(0);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(1);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({ ok: false });
    const summary = (JSON.parse(c.out[0] as string) as { summary: string }).summary;
    expect(summary).toContain('cancelled');
    // the command the message points to works against the server
    expect(summary).toContain('llull exec describe_scene --app');
    const check = capture();
    expect(await runCli(['exec', 'describe_scene', '--server', url, '--json'], check.io)).toBe(EXIT_OK);
    expect(JSON.parse(check.out[0] as string)).toMatchObject({ ok: true });
  });
});
