/**
 * PHY-22 MOV-M2: `ctx.media` behind `llull-compute media` (VC-MOV-10, 13, 14, 22). A real render_animation (clip spin, 21 frames) is encoded to an MP4
 * and a GIF by the real binary and read back by an independent box / block parser (and `check_media.py` when a Python 3 exists); a binary that is
 * missing, exits 1, or outlives its timeout gives the stable code with no file in `data` and the job folder removed. Native runs need
 * llull-compute (cargo build --profile compute -p llull-compute in solver/) and are skipped with a logged reason otherwise.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { getMediaPort, setMediaPort } from '@core/commands/mediaPort';
import { execute } from '@core/commands/registry';
import { base64ToUint8Array } from '@lib/base64';
import { createEmptyDocument } from '@core/model/types';
import type { MediaPort } from '@core/model/media';
import { requireTool } from '../../tests/requireTool';
import { createNativeMediaPort, installMediaPort } from '../src/native/mediaPort';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('mediaNative: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): native runs skipped');
const native = it.skipIf(requireTool('native:llull-compute', BINARY !== null));
const KEEP = { ...process.env, LLULL_NATIVE_KEEP: '1' };
const MISSING = path.join(tmpdir(), 'no-such-llull-compute.exe');

const jobFolders = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('llull-compute-'));
const newSince = (before: readonly string[]): string[] => jobFolders().filter((name) => !before.includes(name));
const removeNew = (before: readonly string[]): void =>
  newSince(before).forEach((name) => rmSync(path.join(tmpdir(), name), { recursive: true, force: true }));

// a private temporary folder: the job-folder checks below must not see the jobs of suites running in parallel
const TEMP_VARIABLES = ['TMPDIR', 'TEMP', 'TMP'] as const;
const savedTemp = TEMP_VARIABLES.map((name) => process.env[name]);
let privateTemp = '';
beforeAll(() => {
  privateTemp = mkdtempSync(path.join(tmpdir(), 'llull-media-test-'));
  for (const name of TEMP_VARIABLES) process.env[name] = privateTemp;
});
afterAll(() => {
  TEMP_VARIABLES.forEach((name, i) => {
    const value = savedTemp[i];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  rmSync(privateTemp, { recursive: true, force: true });
});
afterEach(() => setMediaPort(null));

interface AnimationData {
  files: { fileName: string; base64: string }[];
  width: number;
  height: number;
  format: string;
  fileSha256?: string;
  warnings: { code: string }[];
}

const fileBytes = (data: AnimationData, fileName: string): Uint8Array =>
  base64ToUint8Array(data.files.find((file) => file.fileName === fileName)?.base64 ?? '') ?? new Uint8Array(0);

/** The mov_clip_spin plan (validation/plans): a 100 x 20 box spinning about the origin, 2 s of clips at 10 fps = 21 frames. */
const SPIN = createEmptyDocument();
const spinDocument = execute(SPIN, 'build_project', {
  actions: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [100, 20, 10], position: [50, 0, 0], anchor: 'center' }, as: 'arm' },
    { command: 'animate', params: { targetId: '$arm', mode: 'spin', speed: 3.14159265359, axis: [0, 0, 1], pivot: [0, 0, 0] } },
  ],
}).document;

function render(port: MediaPort | null, extra: Record<string, unknown>): ReturnType<typeof execute> {
  const params = { source: { kind: 'clips', duration: 2 }, fps: 10, width: 160, height: 120, camera: { view: 'top' }, ...extra };
  return execute(spinDocument, 'render_animation', params, { ...defaultContext(), media: port });
}

const be32 = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
const text = (bytes: Uint8Array, start: number, end: number): string => Buffer.from(bytes.subarray(start, end)).toString('latin1');

/** Top-level box types of an MP4. */
function topBoxes(bytes: Uint8Array): string[] {
  const kinds: string[] = [];
  for (let at = 0; at < bytes.length; at += be32(bytes, at)) kinds.push(text(bytes, at + 4, at + 8));
  return kinds;
}

describe('the real encoder (VC-MOV-10)', () => {
  native('encodes 21 frames of a spinning box to an MP4: ftyp moov mdat, brand isom, av01, 21 samples, deterministic rav1e', () => {
    const port = createNativeMediaPort(BINARY as string);
    const result = render(port, { format: 'mp4', quality: 'draft' });
    expect(result.error).toBeUndefined();
    const data = result.data as AnimationData & { encoder?: { name: string; version: string; deterministic: boolean } };
    const mp4 = fileBytes(data, 'animation.mp4');
    expect(topBoxes(mp4)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(text(mp4, 8, 12)).toBe('isom');
    expect(text(mp4, 0, mp4.length)).toContain('av01');
    expect(text(mp4, 0, mp4.length)).toContain('av1C');
    const moovAt = be32(mp4, 0);
    const stsz = text(mp4, moovAt, moovAt + be32(mp4, moovAt)).indexOf('stsz');
    expect(be32(mp4, moovAt + stsz + 12)).toBe(21);
    expect(data.encoder).toMatchObject({ name: 'rav1e', version: '0.8.1', deterministic: true });
    expect(data.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    const again = render(port, { format: 'mp4', quality: 'draft' }).data as AnimationData;
    expect(again.fileSha256, 'byte-identical rerun').toBe(data.fileSha256);
    expect(data.files.map((f) => f.fileName)).toEqual(['animation.mp4', 'timeline.json']);
  });

  native('encodes the GIF: GIF89a, the frame size, a trailer, looping forever, a digest', () => {
    const result = render(createNativeMediaPort(BINARY as string), { format: 'gif' });
    expect(result.error).toBeUndefined();
    const data = result.data as AnimationData;
    const gif = fileBytes(data, 'animation.gif');
    expect(text(gif, 0, 6)).toBe('GIF89a');
    expect([gif[6], gif[7], gif[8], gif[9]]).toEqual([160, 0, 120, 0]);
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(text(gif, 0, gif.length)).toContain('NETSCAPE2.0');
    expect(data.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  native('rounds an odd mp4 size to even before the encoder sees it', () => {
    const result = render(createNativeMediaPort(BINARY as string), { format: 'mp4', quality: 'draft', width: 161, height: 121 });
    const data = result.data as AnimationData;
    expect(result.error).toBeUndefined();
    expect([data.width, data.height]).toEqual([160, 120]);
    expect(data.warnings.map((w) => w.code)).toContain('MOV_SIZE_ROUNDED');
  });

  native('leaves no job folder behind; LLULL_NATIVE_KEEP=1 keeps one with the manifest and the frames', () => {
    const before = jobFolders();
    render(createNativeMediaPort(BINARY as string), { format: 'gif' });
    expect(newSince(before)).toEqual([]);
    render(createNativeMediaPort(BINARY as string, KEEP), { format: 'gif' });
    const kept = newSince(before);
    expect(kept).toHaveLength(1);
    const folder = path.join(tmpdir(), kept[0] ?? '');
    expect(JSON.parse(readFileSync(path.join(folder, 'job.json'), 'utf8'))).toMatchObject({
      version: 1,
      format: 'gif',
      width: 160,
      height: 120,
      frames: 21,
    });
    expect(existsSync(path.join(folder, 'frame-00020.png'))).toBe(true);
    expect(existsSync(path.join(folder, 'out.gif'))).toBe(true);
    removeNew(before);
  });

  native('a session refuses a frame count that differs from the announced one, and a closed session', () => {
    const session = createNativeMediaPort(BINARY as string).open({
      format: 'gif',
      width: 4,
      height: 4,
      fps: 10,
      quality: 'draft',
      frames: 2,
    });
    if ('ok' in session) throw new Error(session.message);
    expect(session.finish()).toMatchObject({ ok: false, code: 'NATIVE_JOB_INPUT' });
    expect(session.add(new Uint8Array([1]))).toMatchObject({ ok: false, code: 'NATIVE_PROTOCOL' });
  });
});

const PYTHON = process.env['LLULL_PYTHON'] ?? 'python3';
const probe = spawnSync(PYTHON, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 30_000 });
const hasPython = probe.status === 0 && probe.stdout.trim() === '3';

describe.skipIf(requireTool('python', hasPython))('check_media.py oracle on the encoder output (VC-MOV-09, 10)', () => {
  const checker = path.resolve(process.cwd(), '..', 'docs/physics/22-motion-video/validation/check_media.py');
  const facts = (file: string): Record<string, unknown> => {
    const run = spawnSync(PYTHON, ['-I', checker, file], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as Record<string, unknown>;
  };

  native('reads the MP4 (isom, av01 + av1C, 21 samples, timescale 10) and the GIF (21 frames, loop, cumulative delays)', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'llull-media-oracle-'));
    try {
      const port = createNativeMediaPort(BINARY as string);
      const mp4 = render(port, { format: 'mp4', quality: 'draft' }).data as AnimationData;
      writeFileSync(path.join(directory, 'a.mp4'), fileBytes(mp4, 'animation.mp4'));
      expect(facts(path.join(directory, 'a.mp4'))).toMatchObject({
        brand: 'isom',
        codec: 'av01',
        codecConfig: true,
        frames: 21,
        timescale: 10,
        width: 160,
        height: 120,
      });
      const gif = render(port, { format: 'gif' }).data as AnimationData;
      writeFileSync(path.join(directory, 'a.gif'), fileBytes(gif, 'animation.gif'));
      expect(facts(path.join(directory, 'a.gif'))).toMatchObject({ format: 'gif', frames: 21, loop: true, width: 160, height: 120 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the encoder fails or is missing (VC-MOV-13, 14)', () => {
  it('a binary that does not exist: the port answers NATIVE_TOOL_MISSING-shaped failure and render_animation refuses with a code, no file', () => {
    const before = jobFolders();
    const result = render(createNativeMediaPort(MISSING), { format: 'mp4' });
    expect(['NATIVE_TOOL_MISSING', 'MOV_ENCODE_FAILED']).toContain(result.error?.code);
    expect(result.data).toBeUndefined();
    expect(newSince(before)).toEqual([]);
  });

  it('a host without the binary installs no port, and mp4 / gif refuse naming apng while apng succeeds', () => {
    expect(installMediaPort({ LLULL_COMPUTE: MISSING })).toBe(false);
    expect(getMediaPort()).toBeNull();
    const refused = render(getMediaPort(), { format: 'mp4' });
    expect(refused.error?.code).toBe('NATIVE_TOOL_MISSING');
    expect(refused.error?.remediation).toContain('apng');
    expect((render(getMediaPort(), { format: 'apng' }).data as AnimationData).format).toBe('apng');
  });

  it('an encoder that exits 1 without a final event: MOV_ENCODE_FAILED, nothing in data, job folder removed', () => {
    const before = jobFolders();
    // `node media <folder>` fails to load the script "media" and exits 1: the shape of a crashing encoder, portable (no shell script)
    const result = render(createNativeMediaPort(process.execPath), { format: 'mp4' });
    expect(result.error?.code).toBe('MOV_ENCODE_FAILED');
    expect(result.summary).toContain('NATIVE_PROTOCOL');
    expect(result.data).toBeUndefined();
    expect(newSince(before)).toEqual([]);
  });

  native('an encoder that outlives its timeout is killed: MOV_ENCODE_FAILED with NATIVE_TIMEOUT, nothing in data, folder removed', () => {
    const before = jobFolders();
    const started = Date.now();
    const result = render(createNativeMediaPort(BINARY as string, process.env, { timeoutMs: 1 }), { format: 'mp4', quality: 'high' });
    expect(result.error?.code).toBe('MOV_ENCODE_FAILED');
    expect(result.summary).toContain('NATIVE_TIMEOUT');
    expect(result.data).toBeUndefined();
    expect(Date.now() - started, 'the wait is bounded by the frames and the kill, not by the encode').toBeLessThan(60_000);
    expect(newSince(before)).toEqual([]);
  });
});
