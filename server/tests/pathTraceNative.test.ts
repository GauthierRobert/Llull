/**
 * RV1 RV-M3: `ctx.pathTrace` through `llull-compute pathtrace` (wire contract RV1 §5b) and `--save` of a render_realistic result.
 * Native runs need an llull-compute with the pathtrace job (cargo build --release -p llull-compute in solver/) and are skipped otherwise.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { getPathTracePort, setPathTracePort } from '@core/commands/pathTracePort';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PathTraceScene } from '@core/model/pathTrace';
import type { ExecutionContext } from '@core/commands/types';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { createPathTracePort, installPathTracePort, parsePathTraceStats, pathTraceJobFiles } from '../src/native/pathTracePort';
import { saveDataFiles } from '../src/cli/saveFiles';
import { requireTool } from '../../tests/requireTool';

const BINARY = nativeBinaryPath('llull-compute');
const usage = BINARY === null ? null : spawnSync(BINARY, [], { encoding: 'utf8' });
const HAS_PATHTRACE = usage !== null && `${usage.stdout}${usage.stderr}`.includes('pathtrace');
if (!HAS_PATHTRACE)
  console.warn('pathTraceNative: llull-compute with the pathtrace job not built (cargo build --release in solver/): native runs skipped');
const native = it.skipIf(requireTool('native:llull-compute', HAS_PATHTRACE));

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The Vulkan adapter llull-compute's wgpu path tracer would open (`vulkaninfo --summary`), or null (none, or LLULL_GPU=off). */
function vulkanDevice(): string | null {
  if (['off', '0', 'false'].includes(process.env.LLULL_GPU ?? '')) return null;
  const probe = spawnSync('vulkaninfo', ['--summary'], { encoding: 'utf8' });
  const match = /deviceName\s*=\s*(.+)/.exec(probe.stdout ?? '');
  return match?.[1]?.trim() ?? null;
}

function scene(): CadDocument {
  let doc = createEmptyDocument();
  const run = (name: string, params: Record<string, unknown>): void => {
    const result = execute(doc, name, params);
    expect(result.error, result.summary).toBeUndefined();
    doc = result.document;
  };
  run('add_box', { size: [40, 20, 12], color: '#c05030' });
  run('add_sphere', { radius: 8, position: [30, 0, 4], color: '#3070c0' });
  return doc;
}

const ctx = (): ExecutionContext => ({ ...defaultContext(), pathTrace: BINARY === null ? null : createPathTracePort(BINARY) });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-pathtrace-test-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('path trace job files', () => {
  it('writes job.json, the typed buffers and one file per texture', () => {
    const job = {
      kind: 'pathtrace',
      textures: [{ file: 'tex-0.png', format: 'png', colorSpace: 'srgb' }],
    } as unknown as PathTraceScene['job'];
    const files = pathTraceJobFiles({
      job,
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 0, 1]),
      uvs: new Float32Array([0.5, 0.5]),
      indices: new Uint32Array([0]),
      instances: new Float64Array([0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
      textureBytes: [new Uint8Array([9, 8, 7])],
    });
    expect(Object.keys(files).sort()).toEqual([
      'indices.u32',
      'instances.f64',
      'job.json',
      'normals.f32',
      'positions.f32',
      'tex-0.png',
      'uvs.f32',
    ]);
    expect((files['positions.f32'] as Buffer).length).toBe(12);
    expect((files['instances.f64'] as Buffer).length).toBe(14 * 8);
    expect([...(files['tex-0.png'] as Buffer)]).toEqual([9, 8, 7]);
    expect(JSON.parse(files['job.json'] as string)).toMatchObject({ kind: 'pathtrace' });
  });

  it('parses stats.json strictly', () => {
    const good = {
      samples: 4,
      seed: 1,
      device: 'cpu',
      deterministic: true,
      elapsedMs: 3,
      noise: 0.1,
      denoised: false,
      triangles: 2,
      instances: 1,
      stoppedBy: 'noise',
    };
    expect(parsePathTraceStats(JSON.stringify(good))).toEqual(good);
    expect(parsePathTraceStats(JSON.stringify({ ...good, fallbackReason: 'x' })).fallbackReason).toBe('x');
    expect(() => parsePathTraceStats(JSON.stringify({ ...good, stoppedBy: 'magic' }))).toThrow(/stoppedBy/);
    expect(() => parsePathTraceStats(JSON.stringify({ ...good, samples: 'x' }))).toThrow(/samples/);
    expect(() => parsePathTraceStats('[]')).toThrow(/object/);
  });

  it('installs nothing without the binary, and a broken binary is a named failure', () => {
    const previous = getPathTracePort();
    try {
      expect(installPathTracePort({ LLULL_COMPUTE: path.join(scratch, 'no-such-llull-compute') })).toBe(false);
      expect(getPathTracePort()).toBeNull();
    } finally {
      setPathTracePort(previous);
    }
    const broken = createPathTracePort(path.join(scratch, 'no-such-binary'));
    const doc = scene();
    const result = execute(doc, 'render_realistic', { width: 16, height: 16, samples: 1 }, { ...defaultContext(), pathTrace: broken });
    expect(result.document).toBe(doc);
    expect(result.error?.code).toMatch(/^NATIVE_/);
  });
});

describe('render_realistic --save', () => {
  const data = {
    illustration: true,
    image: Buffer.from('png-bytes').toString('base64'),
    files: [
      { name: 'render.png', base64: Buffer.from('png-bytes').toString('base64') },
      { name: 'render.exr', base64: Buffer.from('exr-bytes').toString('base64') },
    ],
  };

  it('writes the picture to a .png, the EXR to a .exr and both into a folder', () => {
    const png = path.join(scratch, 'a', 'out.png');
    expect(saveDataFiles(data, png)).toEqual([{ path: png, bytes: 9 }]);
    expect(fs.readFileSync(png, 'utf8')).toBe('png-bytes');
    const exr = path.join(scratch, 'a', 'out.exr');
    saveDataFiles(data, exr);
    expect(fs.readFileSync(exr, 'utf8')).toBe('exr-bytes');
    const folder = path.join(scratch, 'b') + path.sep;
    saveDataFiles(data, folder);
    expect(fs.readdirSync(folder).sort()).toEqual(['render.exr', 'render.png']);
  });

  it('moves a host-written EXR to an .exr target, refuses an .exr target without one', () => {
    const exportDir = path.join(scratch, 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    const hostFile = path.join(exportDir, 'render.exr');
    fs.writeFileSync(hostFile, 'big-exr');
    const hosted = {
      illustration: true,
      image: data.image,
      files: [data.files[0]],
      file: { path: hostFile, bytes: 7 },
      fileName: 'render.exr',
    };
    const target = path.join(scratch, 'c', 'big.exr');
    expect(saveDataFiles(hosted, target, exportDir)).toEqual([{ path: target, bytes: 7 }]);
    expect(fs.existsSync(hostFile)).toBe(false);
    fs.writeFileSync(hostFile, 'big-exr');
    const png = path.join(scratch, 'c', 'pic.png');
    expect(saveDataFiles(hosted, png, exportDir).map((file) => path.basename(file.path))).toEqual(['pic.png', 'pic.exr']);
    expect(fs.readFileSync(png, 'utf8')).toBe('png-bytes');
    expect(() => saveDataFiles(data, path.join(scratch, 'c', 'pic.jpg'))).toThrow(/not \.jpg/);
    expect(() => saveDataFiles({ illustration: true, image: data.image, files: [data.files[0]] }, path.join(scratch, 'd.exr'))).toThrow(
      /no EXR/,
    );
  });
});

describe('llull-compute pathtrace', () => {
  native(
    'renders a PNG and an EXR with the reported provenance',
    () => {
      const result = execute(scene(), 'render_realistic', { width: 64, height: 48, samples: 8, seed: 3 }, ctx());
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as { files: { name: string; base64: string }[]; deterministic: boolean; device: string; samples: number };
      const png = Buffer.from(data.files.find((file) => file.name === 'render.png')!.base64, 'base64');
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.readUInt32BE(16)).toBe(64);
      expect(png.readUInt32BE(20)).toBe(48);
      const exr = Buffer.from(data.files.find((file) => file.name === 'render.exr')!.base64, 'base64');
      expect(exr.readUInt32LE(0)).toBe(20000630); // OpenEXR magic
      expect(data).toMatchObject({ deterministic: true, device: 'cpu', samples: 8 });
    },
    120_000,
  );

  native(
    'the same seed renders the same picture; another seed differs',
    () => {
      const doc = scene();
      const pngOf = (seed: number): string => {
        const data = execute(doc, 'render_realistic', { width: 32, height: 32, samples: 4, seed, exr: false }, ctx()).data as {
          files: { name: string; base64: string }[];
        };
        return sha(Buffer.from(data.files[0]!.base64, 'base64'));
      };
      expect(pngOf(5)).toBe(pngOf(5));
      expect(pngOf(5)).not.toBe(pngOf(6));
    },
    120_000,
  );

  native(
    'textures, an HDR environment, lights, a camera with depth of field, the denoiser and a gpu request render',
    () => {
      let doc = scene();
      const run = (name: string, params: Record<string, unknown>, context?: ExecutionContext): void => {
        const result = execute(doc, name, params, context);
        expect(result.error, result.summary).toBeUndefined();
        doc = result.document;
      };
      run('add_light', { lightType: 'point', position: [0, -30, 40], intensity: 200, radius: 2 });
      run('add_light', { lightType: 'area', position: [0, 0, 60], target: [0, 0, 0], width: 20, height: 10, intensity: 100 });
      run('add_camera', { position: [60, -90, 40], target: [10, 0, 0], focalLength: 35, fStop: 4, focusDistance: 110 });
      run('set_environment', { source: 'sky', turbidity: 3 });
      const cameraId = doc.order[doc.order.length - 1]!;
      const result = execute(
        doc,
        'render_realistic',
        { camera: cameraId, width: 48, height: 32, samples: 8, denoise: true, engine: 'gpu', exr: false },
        ctx(),
      );
      expect(result.error, result.summary).toBeUndefined();
      expect(result.data).toMatchObject({ denoised: true, cameraId });
      const { device, fallbackReason } = result.data as { device: string; fallbackReason?: string };
      const adapter = vulkanDevice();
      if (adapter !== null) {
        expect({ device, fallbackReason }).toEqual({ device: adapter, fallbackReason: undefined });
      } else {
        expect(device).toBe('cpu');
        expect(fallbackReason ?? '').toMatch(/rendered on the CPU/);
      }
    },
    120_000,
  );

  native(
    'a time limit marks the render not deterministic',
    () => {
      const result = execute(scene(), 'render_realistic', { width: 256, height: 256, samples: 65536, maxSeconds: 1, exr: false }, ctx());
      expect(result.error, result.summary).toBeUndefined();
      expect(result.data).toMatchObject({ stoppedBy: 'time', deterministic: false });
    },
    120_000,
  );
});
