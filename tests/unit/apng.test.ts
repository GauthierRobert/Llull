/**
 * APNG writer (TR-MOV-10, VC-MOV-07 / 09): chunk order, sequence numbers, CRC, delays, loop, byte-identical rerun, and the independent oracle
 * `validation/check_media.py` (Python standard library, no code shared with llull) on the produced file.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crc32 } from '@lib/crc32';
import { encodeApng } from '@lib/apng';
import { encodePng } from '@lib/png';
import { execute } from '@core/commands/registry';
import { requireTool } from '../requireTool';
import { fileBytes, planDocument, type AnimationData } from './renderAnimationFixtures';

const frame = (shade: number, width = 4, height = 3): Uint8Array =>
  encodePng(
    width,
    height,
    Uint8Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 ? 255 : shade)),
    true,
  );

interface Chunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly crcOk: boolean;
}

function chunksOf(bytes: Uint8Array): Chunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Chunk[] = [];
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({
      type,
      data: bytes.subarray(offset + 8, offset + 8 + length),
      crcOk: crc32(bytes.subarray(offset + 4, offset + 8 + length)) === view.getUint32(offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

describe('encodeApng', () => {
  const frames = [frame(10), frame(120), frame(240)];

  it('writes signature, IHDR, acTL, then fcTL + IDAT / fdAT per frame with sequence numbers 0, 1, 2, …', () => {
    const apng = encodeApng(frames, 10) ?? new Uint8Array(0);
    expect(Array.from(apng.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = chunksOf(apng);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const acTL = new DataView(chunks[1]?.data.buffer ?? new ArrayBuffer(8), chunks[1]?.data.byteOffset, 8);
    expect([acTL.getUint32(0), acTL.getUint32(4)]).toEqual([3, 0]);
    const sequence = chunks
      .filter((c) => c.type === 'fcTL' || c.type === 'fdAT')
      .map((c) => new DataView(c.data.buffer, c.data.byteOffset, 4).getUint32(0));
    expect(sequence).toEqual([0, 1, 2, 3, 4]);
  });

  it('shows every frame full canvas for 1 / fps seconds, replacing the one below (dispose NONE, blend SOURCE)', () => {
    const control = chunksOf(encodeApng(frames, 24) ?? new Uint8Array(0)).filter((c) => c.type === 'fcTL');
    for (const { data } of control) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      expect([view.getUint32(4), view.getUint32(8), view.getUint32(12), view.getUint32(16)]).toEqual([4, 3, 0, 0]);
      expect([view.getUint16(20), view.getUint16(22), data[24], data[25]]).toEqual([1, 24, 0, 0]);
    }
  });

  it('copies the compressed pixels of each frame (the first as IDAT, the others as fdAT)', () => {
    const chunks = chunksOf(encodeApng(frames, 10) ?? new Uint8Array(0));
    const idat = (png: Uint8Array): Uint8Array => chunksOf(png).find((c) => c.type === 'IDAT')?.data ?? new Uint8Array(0);
    expect(chunks.find((c) => c.type === 'IDAT')?.data).toEqual(idat(frames[0] ?? new Uint8Array(0)));
    const fdat = chunks.filter((c) => c.type === 'fdAT').map((c) => c.data.subarray(4));
    expect(fdat).toEqual([idat(frames[1] ?? new Uint8Array(0)), idat(frames[2] ?? new Uint8Array(0))]);
  });

  it('is byte-identical for identical frames and differs when a frame differs', () => {
    expect(encodeApng(frames, 10)).toEqual(encodeApng([frame(10), frame(120), frame(240)], 10));
    expect(encodeApng(frames, 10)).not.toEqual(encodeApng([frame(10), frame(121), frame(240)], 10));
  });

  it('refuses no frames, bad fps, a non-PNG, a truncated PNG and frames of different sizes (null)', () => {
    expect(encodeApng([], 10)).toBeNull();
    expect(encodeApng(frames, 0)).toBeNull();
    expect(encodeApng(frames, 2.5)).toBeNull();
    expect(encodeApng(frames, 65536)).toBeNull();
    expect(encodeApng([new Uint8Array([1, 2, 3])], 10)).toBeNull();
    expect(encodeApng([frames[0] ?? new Uint8Array(0), (frames[1] ?? new Uint8Array(0)).subarray(0, 40)], 10)).toBeNull();
    expect(encodeApng([frame(1), frame(2, 5, 3)], 10)).toBeNull();
  });
});

const PYTHON = process.env['LLULL_PYTHON'] ?? 'python3';
const probe = spawnSync(PYTHON, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 30_000 });
const hasPython = probe.status === 0 && probe.stdout.trim() === '3';
const directory = mkdtempSync(join(tmpdir(), 'llull-apng-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe.skipIf(requireTool('python', hasPython))('check_media.py oracle on the APNG (VC-MOV-09)', () => {
  const checker = resolve(process.cwd(), 'docs/physics/22-motion-video/validation/check_media.py');
  const facts = (
    path: string,
  ): {
    status: number | null;
    facts: { format: string; frames: number; loop: boolean; delaysS: number[]; width: number; height: number };
  } => {
    const run = spawnSync(PYTHON, ['-I', checker, path], { encoding: 'utf8', timeout: 30_000 });
    return { status: run.status, facts: JSON.parse(run.stdout || '{}') as never };
  };

  it('reads the 21 looping frames of 0.1 s of the mov_clip_spin animation rendered by render_animation', () => {
    const { document, render } = planDocument('mov_clip_spin.plan.json');
    const data = execute(document, 'render_animation', render.params).data as AnimationData;
    const path = join(directory, 'spin.apng');
    writeFileSync(path, fileBytes(data, 'animation.apng'));
    const { status, facts: read } = facts(path);
    expect(status).toBe(0);
    expect(read).toMatchObject({ format: 'apng', frames: 21, loop: true, width: 320, height: 240 });
    expect(new Set(read.delaysS)).toEqual(new Set([0.1]));
  });

  it('rejects a corrupted CRC', () => {
    const apng =
      encodeApng(
        Array.from({ length: 3 }, (_, k) => frame(k * 10)),
        10,
      ) ?? new Uint8Array(0);
    const broken = apng.slice();
    broken[40] = (broken[40] ?? 0) ^ 0xff;
    const brokenPath = join(directory, 'broken.apng');
    writeFileSync(brokenPath, broken);
    expect(facts(brokenPath).status).toBe(1);
  });
});
