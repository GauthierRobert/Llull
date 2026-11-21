/** ASC M6a capture_viewport: the command over ctx.viewportCapture (port absent / present / refusing), params and purity. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument } from '@core/model/types';
import type { ViewportCaptureOutcome, ViewportCapturePort, ViewportCaptureRequest } from '@core/model/viewportCapture';
import { apply } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

function recordingPort(outcome: ViewportCaptureOutcome): { port: ViewportCapturePort; requests: ViewportCaptureRequest[] } {
  const requests: ViewportCaptureRequest[] = [];
  return {
    requests,
    port: {
      capture: (request) => {
        requests.push(request);
        return outcome;
      },
    },
  };
}

const run = (params: unknown, port: ViewportCapturePort | null, doc = createEmptyDocument()): ReturnType<typeof execute> =>
  execute(doc, 'capture_viewport', params, { ...defaultContext(), viewportCapture: port });

describe('capture_viewport', () => {
  it('refuses without a port: VIEWPORT_UNAVAILABLE naming --app and render_view', () => {
    const result = run({}, null);
    expect(result.error?.code).toBe('VIEWPORT_UNAVAILABLE');
    expect(result.error?.remediation).toContain('--app');
    expect(result.error?.remediation).toContain('render_view renderer=native');
    expect(result.affected).toEqual([]);
  });

  it('returns the PNG of the port in data.image with the defaults of the request', () => {
    const { port, requests } = recordingPort({ ok: true, png: PNG, width: 1600, height: 1000 });
    const doc = createEmptyDocument();
    const result = run({}, port, doc);
    expect(result.error).toBeUndefined();
    expect(result.document).toBe(doc);
    expect(result.data).toMatchObject({ width: 1600, height: 1000, view: 'iso' });
    expect(Buffer.from((result.data as { image: string }).image, 'base64')).toEqual(Buffer.from(PNG));
    expect(requests).toEqual([{ view: 'iso', zoom: 1, width: 1600, height: 1000, hideLayers: [] }]);
  });

  it('passes the camera, size, background and resolved layer ids; direction makes the view custom', () => {
    const { port, requests } = recordingPort({ ok: true, png: PNG, width: 640, height: 480 });
    const doc = apply(createEmptyDocument(), 'add_layer', { name: 'Hidden' });
    const layerId = Object.values(doc.layers).find((l) => l.name === 'Hidden')?.id;
    const result = run(
      {
        view: 'top',
        direction: [1, 0, 1],
        target: [1, 2, 3],
        zoom: 2,
        width: 640,
        height: 480,
        background: '#fff',
        hideLayers: ['Hidden'],
      },
      port,
      doc,
    );
    expect((result.data as { view: string }).view).toBe('custom');
    expect(requests[0]).toMatchObject({ direction: [1, 0, 1], target: [1, 2, 3], zoom: 2, background: '#fff', hideLayers: [layerId] });
  });

  it('keeps the port refusal code and names its fix', () => {
    const { port } = recordingPort({ ok: false, code: 'VIEWPORT_TIMEOUT', message: 'no answer' });
    const result = run({}, port);
    expect(result.error?.code).toBe('VIEWPORT_TIMEOUT');
    expect(result.summary).toContain('no answer');
  });

  it('refuses a zero direction, an unknown layer and out-of-range sizes', () => {
    const { port, requests } = recordingPort({ ok: true, png: PNG, width: 64, height: 64 });
    expect(run({ direction: [0, 0, 0] }, port).error?.code).toBe('VIEWPORT_BAD_CAMERA');
    expect(run({ hideLayers: ['nope'] }, port).error?.code).toBe('VIEWPORT_UNKNOWN_LAYER');
    expect(run({ width: 63 }, port).summary).toContain('invalid params');
    expect(run({ height: 4097 }, port).summary).toContain('invalid params');
    expect(run({ zoom: 0 }, port).summary).toContain('invalid params');
    expect(requests).toEqual([]);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => run({}, recordingPort({ ok: true, png: PNG, width: 1, height: 1 }).port, doc));
  });
});
