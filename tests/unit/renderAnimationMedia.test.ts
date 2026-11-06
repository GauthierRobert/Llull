/**
 * render_animation, gif / mp4 through the injected encoder `ctx.media` (PHY-22 MOV-M2): the session protocol (open, one add per frame, finish),
 * the frames handed over are the frames of format "frames", even mp4 sizes, quality, digests, and every failure of the port (VC-MOV-13, 14).
 * The real encoder is covered by server/tests/mediaNative.test.ts and solver/crates/llull-media.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { sha256Hex } from '@lib/sha256';
import type { MediaEncoder, MediaFailure, MediaPort, MediaSession, MediaSpec } from '@core/model/media';
import type { CadDocument } from '@core/model/types';
import { firaProvider } from './wrap/fixtures';
import { fileBytes, planDocument, type AnimationData } from './renderAnimationFixtures';

const ENCODER: MediaEncoder = { name: 'fake', version: '1.0', deterministic: true };

interface Recording {
  specs: MediaSpec[];
  frames: Uint8Array[];
  finished: number;
  aborted: number;
}

interface Behaviour {
  openFails?: MediaFailure;
  addFailsAt?: { frame: number; failure: MediaFailure };
  finishFails?: MediaFailure;
  throwsAt?: number;
  encoder?: MediaEncoder;
}

type Data = AnimationData & { encoder?: MediaEncoder };

const BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

function fakePort(behaviour: Behaviour = {}): { port: MediaPort; recording: Recording } {
  const recording: Recording = { specs: [], frames: [], finished: 0, aborted: 0 };
  const session = (): MediaSession => ({
    add(png) {
      if (behaviour.throwsAt === recording.frames.length) throw new Error('boom');
      if (behaviour.addFailsAt?.frame === recording.frames.length) return behaviour.addFailsAt.failure;
      recording.frames.push(png);
      return null;
    },
    finish() {
      recording.finished += 1;
      return behaviour.finishFails ?? { ok: true, bytes: BYTES, encoder: behaviour.encoder ?? ENCODER };
    },
    abort() {
      recording.aborted += 1;
    },
  });
  return {
    port: {
      open(spec) {
        recording.specs.push(spec);
        return behaviour.openFails ?? session();
      },
    },
    recording,
  };
}

const spin = (): { document: CadDocument; params: Record<string, unknown> } => {
  const { document, render } = planDocument('mov_clip_spin.plan.json');
  return { document, params: { ...render.params, width: 96, height: 72 } };
};

const encode = (
  behaviour: Behaviour,
  extra: Record<string, unknown> = {},
): { result: ReturnType<typeof execute>; recording: Recording; document: CadDocument } => {
  const { document, params } = spin();
  const { port, recording } = fakePort(behaviour);
  const result = execute(document, 'render_animation', { ...params, format: 'mp4', ...extra }, { ...defaultContext(), media: port });
  return { result, recording, document };
};

const codes = (data: unknown): string[] => (data as Data).warnings.map((w) => w.code);

beforeAll(() => setFontProvider(firaProvider()));

describe('mp4 / gif through ctx.media (TR-MOV-11)', () => {
  it('opens one session for the frame count, adds the very frames of format "frames" in order, and returns animation.mp4 with the encoder', () => {
    const { result, recording } = encode({});
    const data = result.data as Data;
    expect(result.error).toBeUndefined();
    expect(recording.specs).toEqual([{ format: 'mp4', width: 96, height: 72, fps: 10, quality: 'standard', frames: 21 }]);
    expect(recording.frames).toHaveLength(21);
    expect([recording.finished, recording.aborted]).toEqual([1, 0]);
    expect(data.format).toBe('mp4');
    expect(data.files.map((f) => f.fileName)).toEqual(['animation.mp4', 'timeline.json']);
    expect(fileBytes(data, 'animation.mp4')).toEqual(BYTES);
    expect(data.encoder).toEqual(ENCODER);
    expect(data.fileSha256).toBe(sha256Hex(BYTES));
    const { document, params } = spin();
    const frames = execute(document, 'render_animation', { ...params, format: 'frames' }).data as AnimationData;
    recording.frames.forEach((png, k) => expect(png).toEqual(fileBytes(frames, `frame-${String(k + 1).padStart(4, '0')}.png`)));
    expect(result.summary).toContain('--save out.mp4');
  });

  it('gif uses the same session with quality passed through; the default quality is standard', () => {
    const gif = encode({}, { format: 'gif', quality: 'high' });
    expect(gif.recording.specs[0]).toMatchObject({ format: 'gif', quality: 'high', frames: 21 });
    expect((gif.result.data as Data).files[0]?.fileName).toBe('animation.gif');
    expect(encode({}, { format: 'gif' }).recording.specs[0]?.quality).toBe('standard');
    expect(encode({}, { quality: 'draft' }).recording.specs[0]?.quality).toBe('draft');
  });

  it('rounds an odd mp4 size down to even with MOV_SIZE_ROUNDED (TR-MOV-14) and keeps a gif as asked', () => {
    const mp4 = encode({}, { width: 97, height: 73 });
    const data = mp4.result.data as Data;
    expect([data.width, data.height]).toEqual([96, 72]);
    expect(mp4.recording.specs[0]).toMatchObject({ width: 96, height: 72 });
    expect(codes(data)).toContain('MOV_SIZE_ROUNDED');
    const gif = encode({}, { format: 'gif', width: 97, height: 73 });
    expect(gif.recording.specs[0]).toMatchObject({ width: 97, height: 73 });
    expect(codes(gif.result.data)).not.toContain('MOV_SIZE_ROUNDED');
    expect(codes(encode({}, { width: 96, height: 72 }).result.data)).not.toContain('MOV_SIZE_ROUNDED');
  });

  it('pins fileSha256 only for a deterministic encoder on reference frames', () => {
    const loose = encode({ encoder: { ...ENCODER, deterministic: false } });
    const data = loose.result.data as Data;
    expect(data.fileSha256).toBeUndefined();
    expect(data.encoder?.deterministic).toBe(false);
  });

  it('does not change the document and records no step (read-only)', () => {
    const { result, document } = encode({});
    expect(result.document).toBe(document);
    expect(result.affected).toEqual([]);
  });
});

describe('encoder failures (VC-MOV-13, 14)', () => {
  const nothingReturned = (result: ReturnType<typeof execute>, document: CadDocument): void => {
    expect(result.data).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(document);
  };

  it('refuses without ctx.media with NATIVE_TOOL_MISSING naming apng, and apng still works', () => {
    const { document, params } = spin();
    for (const format of ['mp4', 'gif']) {
      const result = execute(document, 'render_animation', { ...params, format }, { ...defaultContext(), media: null });
      expect(result.error?.code).toBe('NATIVE_TOOL_MISSING');
      expect(result.error?.remediation).toContain('apng');
      nothingReturned(result, document);
    }
    const apng = execute(document, 'render_animation', { ...params, format: 'apng' }, { ...defaultContext(), media: null });
    expect((apng.data as Data).format).toBe('apng');
  });

  it('turns an encoder that does not start into MOV_ENCODE_FAILED quoting the host code', () => {
    const { result, document, recording } = encode({ openFails: { ok: false, code: 'NATIVE_JOB_INPUT', message: 'even sides' } });
    expect(result.error?.code).toBe('MOV_ENCODE_FAILED');
    expect(result.summary).toContain('NATIVE_JOB_INPUT');
    expect(result.summary).toContain('even sides');
    expect(recording.frames).toHaveLength(0);
    nothingReturned(result, document);
  });

  it('aborts the session when a frame is refused and names the frame', () => {
    const failure: MediaFailure = { ok: false, code: 'NATIVE_PROTOCOL', message: 'disk full' };
    const { result, document, recording } = encode({ addFailsAt: { frame: 2, failure } });
    expect(result.error?.code).toBe('MOV_ENCODE_FAILED');
    expect(result.summary).toContain('frame 3');
    expect(result.summary).toContain('disk full');
    expect([recording.finished, recording.aborted]).toEqual([0, 1]);
    nothingReturned(result, document);
  });

  it('turns a failed finish (timeout, crash) into MOV_ENCODE_FAILED with no file in data', () => {
    const finishFails: MediaFailure = { ok: false, code: 'NATIVE_TIMEOUT', message: 'llull-compute timed out after 30000 ms' };
    const { result, document } = encode({ finishFails });
    expect(result.error?.code).toBe('MOV_ENCODE_FAILED');
    expect(result.summary).toContain('NATIVE_TIMEOUT');
    nothingReturned(result, document);
  });

  it('keeps NATIVE_TOOL_MISSING when the binary vanishes between install and use, and survives a port that throws', () => {
    const missing = encode({ openFails: { ok: false, code: 'NATIVE_TOOL_MISSING', message: 'llull-compute not found' } });
    expect(missing.result.error?.code).toBe('NATIVE_TOOL_MISSING');
    const thrown = encode({ throwsAt: 4 });
    expect(thrown.result.error?.code).toBe('MOV_ENCODE_FAILED');
    expect(thrown.result.summary).toContain('boom');
    expect(thrown.recording.aborted).toBe(1);
  });

  it('rejects an unknown quality as invalid params', () => {
    const { result } = encode({}, { quality: 'ultra' });
    expect(result.summary).toMatch(/invalid params/);
  });
});
