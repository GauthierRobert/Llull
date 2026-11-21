/**
 * PERF1 §5 row 10: the persistent scene raster (`llull-compute raster-serve` behind `ctx.raster`). Framing, reuse of one process, restart
 * of a crashed process with one retry, the per-frame timeout, a clean shutdown with no process left, and the job-runner fallback run against
 * a fake server (a node script speaking the same framing); with llull-compute built, the persistent path draws exactly the pixels, PNG bytes
 * and SVG of the per-frame job path and the reference.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { getRasterPort, setRasterPort } from '@core/commands/rasterPort';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { RasterPort, RasterScene } from '@core/model/raster';
import { rasterScenePixels } from '@core/commands/render/raster';
import { encodePng } from '@lib/png';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createRasterReplyReader, encodeRasterRequest, NotRasterServeError } from '../src/native/rasterFrames';
import { createRasterProcess, type RasterProcess } from '../src/native/rasterProcess';
import { closeRasterPort, createNativeRasterPort, createPersistentRasterPort, installRasterPort } from '../src/native/rasterPort';
import { requireTool } from '../../tests/requireTool';

const BINARY = nativeBinaryPath('llull-compute');
const native = it.skipIf(requireTool('native:llull-compute', BINARY !== null));
const folder = mkdtempSync(path.join(tmpdir(), 'llull-raster-process-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/**
 * Fake `raster-serve`: answers each frame with RGBA of 7s (no PNG). Width 13 crashes (once when FAKE_ONCE names a file not yet written),
 * width 17 never answers, width 19 answers a broken header.
 */
const FAKE = path.join(folder, 'fakeServe.cjs');
writeFileSync(
  FAKE,
  `const fs = require('fs');
let pending = Buffer.alloc(0);
let header = null;
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  for (;;) {
    if (header === null) {
      const end = pending.indexOf(10);
      if (end < 0) return;
      header = JSON.parse(pending.subarray(0, end).toString());
      pending = pending.subarray(end + 1);
    }
    if (pending.length < header.bytes) return;
    pending = pending.subarray(header.bytes);
    const { width, height } = header;
    const wantsPng = header.png === true;
    header = null;
    if (width === 13 && (process.env.FAKE_ONCE === undefined || !fs.existsSync(process.env.FAKE_ONCE))) {
      if (process.env.FAKE_ONCE !== undefined) fs.writeFileSync(process.env.FAKE_ONCE, 'x');
      process.exit(3);
    }
    if (width === 17) return;
    if (width === 19) { process.stdout.write('garbage\\n'); return; }
    const rgba = Buffer.alloc(width * height * 4, 7);
    const png = Buffer.from(wantsPng ? [1, 2, 3] : []);
    process.stdout.write(JSON.stringify({ ok: true, warnings: [], rgba: rgba.length, png: png.length, bytes: rgba.length + png.length }) + '\\n');
    process.stdout.write(Buffer.concat([rgba, png]));
  }
});
process.stdin.on('end', () => process.exit(0));
`,
);
/** An old llull-compute: no raster-serve, so it answers an unknown-job event and exits. */
const OLD = path.join(folder, 'oldCompute.cjs');
writeFileSync(OLD, `process.stdout.write('{"type":"error","code":"NATIVE_JOB_UNKNOWN","message":"unknown job"}\\n'); process.exit(2);`);

/** Reply payload limit of the framing tests (the port derives it from the image size). */
const LIMIT = 1 << 20;

const node = (script: string): { executable: string; args: string[] } => ({ executable: process.execPath, args: [script] });
const fakeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, NODE_OPTIONS: '', ...extra });

function scene(width: number, height = 3): RasterScene {
  return {
    width,
    height,
    samples: 1,
    projection: 'orthographic',
    depthJump: 1,
    creaseCos: 0.5,
    faces: new Float64Array([200, 100, 50, 0, 0, 1, 0, 0]),
    fills: new Float64Array([0, 0, 1]),
    loops: new Float64Array([0, 3]),
    points: new Float64Array([0, 0, 0, width, 0, 0, 0, height, 0]),
    strokes: new Float64Array(0),
  };
}

/** Whether `pid` runs (a zombie counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = `/proc/${pid}/stat`;
  return !(existsSync(stat) && /\) Z /.test(readFileSync(stat, 'utf8')));
}

function plant(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): void => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
  };
  run('add_box', { size: [40, 20, 12], color: '#c05030' });
  run('add_cylinder', { radius: 5, height: 30, position: [30, 0, 5], color: '#3070c0' });
  run('add_sphere', { radius: 6, position: [-20, 10, 6], color: '#30a050' });
  run('draw_polyline', {
    points: [
      [-40, -30],
      [40, 25],
    ],
  });
  run('save_viewpoint', { name: 'a', camera: { projection: 'perspective', eye: [0, -90, 30], direction: [0, 1, -0.3], fovDeg: 45 } });
  return doc;
}

describe('raster-serve framing', () => {
  it('a request is the header line with the buffer counts, then the five buffers as little-endian f64', () => {
    const bytes = encodeRasterRequest(scene(4), 'cpu', true);
    const end = bytes.indexOf(0x0a);
    const header = JSON.parse(bytes.toString('utf8', 0, end)) as Record<string, unknown>;
    expect(header).toEqual({
      width: 4,
      height: 3,
      samples: 1,
      projection: 'orthographic',
      depthJump: 1,
      creaseCos: 0.5,
      engine: 'cpu',
      png: true,
      buffers: [8, 3, 2, 9, 0],
      bytes: 22 * 8,
    });
    expect(bytes.length).toBe(end + 1 + 22 * 8);
    expect(bytes.readDoubleLE(end + 1)).toBe(200);
    expect(bytes.readDoubleLE(bytes.length - 16)).toBe(3);
  });

  it('replies are read across any chunking, several in one chunk, refusals included; a broken header throws', () => {
    const image = Buffer.concat([
      Buffer.from('{"ok":true,"warnings":[{"code":"W","message":"m"},1],"rgba":4,"png":2,"bytes":6}\n'),
      Buffer.from([1, 2, 3, 4, 9, 8]),
    ]);
    const refusal = Buffer.from('{"ok":false,"code":"NATIVE_JOB_INPUT","message":"bad","bytes":0}\n');
    const stream = Buffer.concat([image, refusal, image]);
    for (const size of [1, 5, stream.length]) {
      const reader = createRasterReplyReader(LIMIT);
      const replies = [];
      for (let at = 0; at < stream.length; at += size) replies.push(...reader.push(stream.subarray(at, at + size)));
      expect(replies).toEqual([
        { ok: true, warnings: [{ code: 'W', message: 'm' }], rgba: new Uint8Array([1, 2, 3, 4]), png: new Uint8Array([9, 8]) },
        { ok: false, code: 'NATIVE_JOB_INPUT', message: 'bad' },
        { ok: true, warnings: [{ code: 'W', message: 'm' }], rgba: new Uint8Array([1, 2, 3, 4]), png: new Uint8Array([9, 8]) },
      ]);
    }
    expect(createRasterReplyReader(LIMIT).push(Buffer.from('{"ok":false,"bytes":0}\n'))).toEqual([
      { ok: false, code: 'NATIVE_PROTOCOL', message: 'the raster process refused the frame' },
    ]);
    expect(() => createRasterReplyReader(LIMIT).push(Buffer.from('nope\n'))).toThrow();
    expect(() => createRasterReplyReader(LIMIT).push(Buffer.from('{"bytes":-1}\n'))).toThrow(/unreadable/);
    expect(() => createRasterReplyReader(LIMIT).push(Buffer.from('{"ok":true,"rgba":9,"png":0,"warnings":[],"bytes":1}\nx'))).toThrow(
      /describe/,
    );
    expect(() => createRasterReplyReader(LIMIT).push(Buffer.alloc(70_000, 0x20))).toThrow(/longer/);
    expect(() => createRasterReplyReader(100).push(Buffer.from('{"ok":true,"rgba":101,"png":0,"warnings":[],"bytes":101}\n'))).toThrow(
      /over the 100-byte limit/,
    );
    expect(() => createRasterReplyReader(LIMIT).push(Buffer.from('{"type":"error","code":"NATIVE_JOB_UNKNOWN","message":"x"}\n'))).toThrow(
      NotRasterServeError,
    );
  });
});

describe('persistent raster process (fake server)', () => {
  const fake = (extra: Record<string, string> = {}, frameTimeoutMs = 10_000): RasterProcess =>
    createRasterProcess({ command: process.execPath, args: [FAKE], env: fakeEnv(extra), frameTimeoutMs });

  it('is started on the first frame and reused for the next ones; close ends it and leaves no process', () => {
    const server = fake();
    expect(server.pid()).toBeNull();
    const first = server.request(encodeRasterRequest(scene(4), 'cpu', true), LIMIT);
    const pid = server.pid();
    const second = server.request(encodeRasterRequest(scene(5), 'cpu', true), LIMIT);
    expect(first).toMatchObject({ ok: true, rgba: new Uint8Array(48).fill(7) });
    expect(second).toMatchObject({ ok: true });
    expect(server.pid()).toBe(pid);
    expect(server.starts()).toBe(1);
    expect(pid !== null && alive(pid)).toBe(true);
    server.close();
    expect(server.pid()).toBeNull();
    expect(pid !== null && alive(pid)).toBe(false);
    server.close();
  });

  it('a process that crashes during a frame is restarted and the frame is sent once more', () => {
    const server = fake({ FAKE_ONCE: path.join(folder, 'crashed-once') });
    expect(server.request(encodeRasterRequest(scene(4), 'cpu', false), LIMIT)).toMatchObject({ ok: true });
    const crashedPid = server.pid();
    expect(server.request(encodeRasterRequest(scene(13), 'cpu', false), LIMIT)).toMatchObject({
      ok: true,
      rgba: new Uint8Array(13 * 12).fill(7),
    });
    expect(server.starts()).toBe(2);
    expect(server.pid()).not.toBe(crashedPid);
    expect(crashedPid !== null && alive(crashedPid)).toBe(false);
    server.close();
  });

  it('a frame that crashes the process twice fails with NATIVE_DIED; the next frame starts a new process', () => {
    const server = fake();
    expect(server.request(encodeRasterRequest(scene(13), 'cpu', false), LIMIT)).toMatchObject({ ok: false, code: 'NATIVE_DIED' });
    expect(server.starts()).toBe(2);
    expect(server.request(encodeRasterRequest(scene(4), 'cpu', false), LIMIT)).toMatchObject({ ok: true });
    expect(server.starts()).toBe(3);
    server.close();
  });

  it('a frame over its timeout fails with NATIVE_TIMEOUT and kills the process; a broken reply kills it too', () => {
    const server = fake({}, 400);
    expect(server.request(encodeRasterRequest(scene(4), 'cpu', false), LIMIT)).toMatchObject({ ok: true });
    const hungPid = server.pid();
    expect(server.request(encodeRasterRequest(scene(17), 'cpu', false), LIMIT)).toMatchObject({ ok: false, code: 'NATIVE_TIMEOUT' });
    expect(hungPid !== null && alive(hungPid)).toBe(false);
    expect(server.request(encodeRasterRequest(scene(19), 'cpu', false), LIMIT)).toMatchObject({ ok: false, code: 'NATIVE_PROTOCOL' });
    expect(server.pid()).toBeNull();
    expect(server.request(encodeRasterRequest(scene(4), 'cpu', false), LIMIT)).toMatchObject({ ok: true });
    expect(server.starts()).toBe(3);
    server.close();
  });

  it('a command that cannot start fails the frame with NATIVE_DIED', () => {
    const server = createRasterProcess({ command: path.join(folder, 'missing'), args: [], env: process.env, frameTimeoutMs: 5_000 });
    expect(server.request(encodeRasterRequest(scene(4), 'cpu', false), LIMIT)).toMatchObject({ ok: false, code: 'NATIVE_DIED' });
    server.close();
  });

  it('a relay that never reports its process counts as dead within the start timeout, not the frame timeout', () => {
    for (const relaySource of ['setInterval(() => undefined, 1000);', 'throw new Error("relay broken");']) {
      const server = createRasterProcess({
        command: process.execPath,
        args: [FAKE],
        env: fakeEnv(),
        frameTimeoutMs: 60_000,
        startTimeoutMs: 300,
        relaySource,
      });
      const started = performance.now();
      expect(server.request(encodeRasterRequest(scene(4), 'cpu', false), LIMIT)).toMatchObject({ ok: false, code: 'NATIVE_DIED' });
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(server.starts()).toBe(2);
      server.close();
    }
  });

  it('the port asks for the PNG only when the caller embeds the pixels as they are', () => {
    const port = createPersistentRasterPort(process.execPath, fakeEnv(), { command: node(FAKE), version: 'fake 1' });
    const outcome = port.render(scene(4), 'cpu');
    expect(outcome).toMatchObject({ ok: true, image: { engine: 'native-cpu', device: 'cpu', version: 'fake 1' } });
    expect(outcome.ok && outcome.image.png).toBeUndefined();
    expect(port.render(scene(4), 'cpu', { png: true })).toMatchObject({ ok: true, image: { png: new Uint8Array([1, 2, 3]) } });
    port.close();
  });

  it('a capable binary that crashes twice on its first frame fails the frame and keeps the persistent path', () => {
    const port = createPersistentRasterPort(process.execPath, fakeEnv(), { command: node(FAKE), version: 'fake 1' });
    expect(port.render(scene(13), 'cpu')).toMatchObject({ ok: false, code: 'NATIVE_DIED' });
    expect(port.usesJobRunner()).toBe(false);
    expect(port.render(scene(4), 'cpu')).toMatchObject({ ok: true });
    expect(port.process.starts()).toBe(3);
    port.close();
  });

  it('a binary answering with a job event (no raster-serve) switches to the job runner for good', () => {
    const port = createPersistentRasterPort(path.join(folder, 'no-such-compute'), fakeEnv(), { command: node(OLD), version: 'old' });
    expect(port.render(scene(4), 'cpu')).toMatchObject({ ok: false, code: 'NATIVE_TOOL_MISSING' });
    expect(port.usesJobRunner()).toBe(true);
    expect(port.process.pid()).toBeNull();
    port.close();
  });

  it('the port reports the fake image with provenance; close ends the process', () => {
    const port = createPersistentRasterPort(process.execPath, fakeEnv(), { command: node(FAKE), version: 'fake 1' });
    expect(port.render(scene(4), 'cpu')).toMatchObject({ ok: true });
    const pid = port.process.pid();
    port.close();
    expect(pid !== null && alive(pid)).toBe(false);
  });
});

describe('persistent raster port (llull-compute raster-serve)', () => {
  native('two frames, one process; the same pixels, PNG bytes and SVG as the per-frame job and the reference', () => {
    const port = createPersistentRasterPort(BINARY ?? '');
    const job = createNativeRasterPort(BINARY ?? '');
    const doc = plant();
    try {
      for (const params of [
        { width: 320, height: 200 },
        { viewpointId: 'vp-1', width: 240, height: 160 },
        { width: 200, height: 120 },
      ]) {
        const scenes: RasterScene[] = [];
        const recorder: RasterPort = {
          render: (frame, engine, request) => {
            scenes.push(frame);
            expect(request).toEqual({ png: true });
            return port.render(frame, engine, request);
          },
        };
        const persistent = execute(doc, 'render_view', { ...params, renderer: 'native' }, { ...defaultContext(), raster: recorder });
        const viaJob = execute(doc, 'render_view', { ...params, renderer: 'native' }, { ...defaultContext(), raster: job });
        expect(persistent.error, persistent.summary).toBeUndefined();
        const data = persistent.data as Record<string, unknown>;
        expect(data).toMatchObject({ renderer: 'native', engine: 'native-cpu', version: expect.stringMatching(/^llull-compute \d/) });
        expect(data['svg']).toBe((viaJob.data as Record<string, unknown>)['svg']);
        expect(data['svg']).toBe((execute(doc, 'render_view', params).data as Record<string, unknown>)['svg']);
        const [frame] = scenes;
        if (frame === undefined) throw new Error('no scene');
        const outcome = port.render(frame, 'cpu', { png: true });
        if (!outcome.ok) throw new Error(outcome.message);
        const reference = rasterScenePixels(frame);
        expect(Buffer.from(outcome.image.rgba).equals(Buffer.from(reference))).toBe(true);
        expect(Buffer.from(outcome.image.png ?? []).equals(Buffer.from(encodePng(frame.width, frame.height, reference, true)))).toBe(true);
      }
      expect(port.process.starts()).toBe(1);
      expect(port.usesJobRunner()).toBe(false);
      const pid = port.process.pid();
      port.close();
      expect(pid !== null && alive(pid)).toBe(false);
    } finally {
      port.close();
    }
  });

  native('a refused scene answers its code and keeps the process', () => {
    const port = createPersistentRasterPort(BINARY ?? '');
    try {
      expect(port.render({ ...scene(4), fills: new Float64Array([5, 0, 1]) }, 'cpu')).toMatchObject({
        ok: false,
        code: 'NATIVE_JOB_INPUT',
      });
      expect(port.render(scene(4), 'cpu')).toMatchObject({ ok: true });
      expect(port.process.starts()).toBe(1);
    } finally {
      port.close();
    }
  });

  native('a binary without raster-serve falls back to one job per frame', () => {
    const port = createPersistentRasterPort(BINARY ?? '', process.env, { command: node(OLD) });
    try {
      const frame = scene(6, 4);
      const outcome = port.render(frame, 'cpu');
      expect(port.usesJobRunner()).toBe(true);
      if (!outcome.ok) throw new Error(outcome.message);
      expect(Buffer.from(outcome.image.rgba).equals(Buffer.from(rasterScenePixels(frame)))).toBe(true);
      expect(port.render(frame, 'cpu')).toMatchObject({ ok: true });
    } finally {
      port.close();
    }
  });

  native('the installed port is the persistent one; LLULL_RASTER_PROCESS=0 installs the job runner; closing ends the process', () => {
    const previous = getRasterPort();
    try {
      expect(installRasterPort()).toBe(true);
      const installed = getRasterPort() as ReturnType<typeof createPersistentRasterPort>;
      expect(installed.process.starts()).toBe(0);
      expect(execute(plant(), 'render_view', { width: 160, height: 100, renderer: 'native' }).error).toBeUndefined();
      const pid = installed.process.pid();
      expect(pid !== null && alive(pid)).toBe(true);
      expect(installRasterPort({ ...process.env, LLULL_RASTER_PROCESS: '0' })).toBe(true);
      expect(pid !== null && alive(pid)).toBe(false);
      expect('process' in (getRasterPort() ?? {})).toBe(false);
      expect(execute(plant(), 'render_view', { width: 160, height: 100, renderer: 'native' }).error).toBeUndefined();
      installRasterPort();
      closeRasterPort();
    } finally {
      setRasterPort(previous);
    }
  });
});

describe('without llull-compute', () => {
  it('nothing is installed and render_view keeps the reference path (native refuses with NATIVE_TOOL_MISSING)', () => {
    const previous = getRasterPort();
    try {
      expect(installRasterPort({ LLULL_COMPUTE: path.join(folder, 'no-such-llull-compute') })).toBe(false);
      expect(getRasterPort()).toBeNull();
      expect(execute(plant(), 'render_view', { width: 120, height: 80 }).error).toBeUndefined();
      expect(execute(plant(), 'render_view', { width: 120, height: 80, renderer: 'native' }).error?.code).toBe('NATIVE_TOOL_MISSING');
      closeRasterPort();
    } finally {
      setRasterPort(previous);
    }
  });
});
