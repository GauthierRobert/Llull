/** ASC M6b: render_view over its polygon budget, through the backend's deferred run with a fake desktop renderer. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetLiveDoc, getLiveDoc, setLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommandAsync } from '../src/commandBus';
import { answerFrame, registerRenderer, type CaptureEvent } from '../src/viewport/captureBroker';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { encodePng } from '@lib/png';
import { documentHash } from '@protocol/liveSync';

const leaveAll: (() => void)[] = [];

/** A fake desktop renderer: records the captures it is asked for and answers each with `reply`. */
function fakeRenderer(reply: (event: CaptureEvent) => void): CaptureEvent[] {
  const events: CaptureEvent[] = [];
  leaveAll.push(
    registerRenderer((message) => {
      if (message.type !== 'capture') return;
      events.push(message.event);
      queueMicrotask(() => reply(message.event));
    }),
  );
  return events;
}

/** A mesh above the 400000-polygon budget of the reference raster. */
function overBudgetDoc(): CadDocument {
  const triangles = 420_000;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const x = (t % 700) * 0.01;
    const y = Math.floor(t / 700) * 0.01;
    positions.push(x, y, 0, x + 0.01, y, 0, x, y + 0.01, 0.01);
    indices.push(3 * t, 3 * t + 1, 3 * t + 2);
  }
  const mesh: MeshSolidEntity = {
    id: 'big',
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
    mesh: { positions, indices },
  };
  return { ...createEmptyDocument(), entities: { big: mesh }, order: ['big'] };
}

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

afterEach(() => {
  for (const leave of leaveAll.splice(0)) leave();
});

describe('render_view over budget through the deferred run (M6b)', () => {
  it('asks the renderer once, then the command re-runs and returns the viewport picture; under budget the renderer is never asked', async () => {
    const events = fakeRenderer((event) =>
      answerFrame(event.id, {
        frame: {
          png: encodePng(event.request.width, event.request.height, new Uint8Array(event.request.width * event.request.height * 4)),
          width: event.request.width,
          height: event.request.height,
        },
      }),
    );
    await applyCommandAsync('add_box', { size: [1, 1, 1] });
    const light = await applyCommandAsync('render_view', { width: 96, height: 64 });
    expect((light.data as { routedTo?: string }).routedTo).toBeUndefined();
    expect(events).toEqual([]);

    setLiveDoc(overBudgetDoc());
    const result = await applyCommandAsync('render_view', { width: 96, height: 64, view: 'top' });
    expect(result.isError).toBe(false);
    expect(result.changed).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ request: { view: 'top', width: 96, height: 64 }, documentHash: documentHash(getLiveDoc()) });
    const data = result.data as { routedTo: string; deterministic: boolean; svg: string };
    expect(data).toMatchObject({ routedTo: 'viewport', deterministic: false });
    expect(data.svg).toContain('data:image/png;base64,');
  }, 120_000);

  it('a renderer that cannot draw leaves the best effort with RENDER_BUDGET_EXCEEDED', async () => {
    fakeRenderer((event) => answerFrame(event.id, { code: 'VIEWPORT_CAPTURE_FAILED', message: 'not shown' }));
    setLiveDoc(overBudgetDoc());
    const result = await applyCommandAsync('render_view', { width: 96, height: 64 });
    expect(result.isError).toBe(false);
    expect(result.summary).toContain('RENDER_BUDGET_EXCEEDED');
    expect(result.summary).toContain('VIEWPORT_CAPTURE_FAILED');
    expect((result.data as { drawnShare: number }).drawnShare).toBeLessThan(1);
  }, 120_000);
});
