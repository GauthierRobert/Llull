/** TR-MAT-51: the live command log (SSE `command` events) never carries a human signature, at any depth of the params. */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyCommand, _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, subscribeLive } from '../src/liveDocument';
import { makeFakeRes, parseSseFrame } from './sseTestHelpers';

const SIGNATURE = { signatureId: 'sig-1', nonce: 'n-1', signature: 'SECRET-SIGNATURE-BYTES' };

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

describe('live command log', () => {
  it('broadcasts { verified: true } instead of a confirmation signature; the command still sees nothing it must not store', () => {
    const response = makeFakeRes();
    const unsubscribe = subscribeLive(response);
    const sent = applyCommand('build_project', {
      actions: [
        {
          command: 'define_material_record',
          params: { id: 'r', designation: 'x', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } },
        },
        { command: 'set_export_marking', params: { material: 'r', marking: { regime: 'ITAR' }, confirmation: SIGNATURE } },
      ],
    });
    unsubscribe();
    expect(sent.changed).toBe(true);
    const frames = response.written.slice(1);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(frame).not.toContain('SECRET-SIGNATURE-BYTES');
    const event = parseSseFrame(frames[0] ?? '');
    expect(event.event).toBe('command');
    expect(JSON.stringify(event.data['params'])).toContain('"verified":true');
  });

  it('a top-level confirmation on the sent command is redacted in the event too', () => {
    const response = makeFakeRes();
    const unsubscribe = subscribeLive(response);
    applyCommand('add_box', { size: [1, 1, 1], confirmation: SIGNATURE });
    unsubscribe();
    const frames = response.written.slice(1);
    expect(frames.join('')).not.toContain('SECRET-SIGNATURE-BYTES');
    expect(parseSseFrame(frames[0] ?? '').data['params']).toMatchObject({ confirmation: { verified: true } });
  });
});
