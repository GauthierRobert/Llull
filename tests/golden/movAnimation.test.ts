/**
 * Golden pins of render_animation (VC-MOV-07): the reference raster's frame digests and the APNG digest of two animations, tied to
 * REFERENCE_RENDERER_VERSION. They change only when the reference raster (or the PNG / APNG writer) changes, and then the version is bumped with them.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { REFERENCE_RENDERER_VERSION } from '@core/commands/render/rendererProvenance';
import { fourBar, planDocument, type AnimationData } from '../unit/renderAnimationFixtures';

const pin = (data: AnimationData): unknown => ({
  rendererVersion: data.rendererVersion,
  frames: data.frames,
  camera: data.camera,
  timeline: data.timeline,
  frameSha256: data.frameSha256,
  fileSha256: data.fileSha256,
});

describe('render_animation golden digests', () => {
  it('mov_clip_spin: 21 frames and the APNG', () => {
    const { document, render } = planDocument('mov_clip_spin.plan.json');
    const result = execute(document, 'render_animation', render.params);
    const data = result.data as AnimationData;
    expect(data.rendererVersion).toBe(REFERENCE_RENDERER_VERSION);
    expect(pin(data)).toMatchSnapshot();
  });

  it('four-bar sweep there and back: 13 frames', () => {
    const { document, drive } = fourBar();
    const result = execute(document, 'render_animation', {
      source: { kind: 'sweep', mode: 'joint', target: drive, start: 0, end: 2 * Math.PI, duration: 1.2, pingPong: true },
      fps: 10,
      width: 240,
      height: 180,
      camera: { view: 'top' },
      format: 'apng',
    });
    const data = result.data as AnimationData;
    expect(data.frames).toBe(13);
    expect(pin(data)).toMatchSnapshot();
  });
});
