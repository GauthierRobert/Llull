/** Host-filled `at` / `by` (pure, @protocol/hostParams): one command, plan steps, nested loops. */
import { describe, expect, it } from 'vitest';
import { fillHostParams, isoSeconds } from '@protocol/hostParams';

const host = { now: new Date('2026-11-02T09:30:00.123Z'), user: (): string => 'alice' };
const FILLED = { at: '2026-11-02T09:30:00Z', by: 'alice' };

describe('fillHostParams', () => {
  it('formats the host clock in whole seconds', () => {
    expect(isoSeconds(host.now)).toBe('2026-11-02T09:30:00Z');
  });

  it('fills a plm command and overrides a caller-supplied time', () => {
    expect(fillHostParams('submit_for_review', {}, host)).toEqual(FILLED);
    expect(fillHostParams('submit_for_review', { at: '2001-01-01T00:00:00Z', by: 'bob' }, host)).toEqual({ ...FILLED, by: 'bob' });
  });

  it('leaves other commands, unknown names and commands without at/by alone', () => {
    expect(fillHostParams('add_box', { size: [1, 1, 1] }, host)).toEqual({ size: [1, 1, 1] });
    expect(fillHostParams('add_door', { wallId: 'w' }, host)).toEqual({ wallId: 'w' });
    expect(fillHostParams('no_such_command', 5, host)).toBe(5);
  });

  it('reads the user only when a command needs it', () => {
    let calls = 0;
    fillHostParams('add_box', {}, { now: host.now, user: () => (calls++, 'x') });
    expect(calls).toBe(0);
  });

  it('fills plm steps inside a build_project plan, loops and bodies included, without touching the input', () => {
    const plan = {
      onError: 'abort',
      actions: [
        { command: 'add_box', params: { size: [1, 1, 1] } },
        { command: 'submit_for_review', params: { revision: 'A' } },
        { repeat: { count: 2 }, step: { command: 'submit_for_review', params: {} } },
        {
          for: { var: 'i', from: 0, to: 1 },
          actions: [{ command: 'submit_for_review' }, { repeat: { count: 1 }, actions: [{ command: 'add_box' }] }],
        },
      ],
    };
    const before = JSON.stringify(plan);
    const filled = fillHostParams('build_project', plan, host) as typeof plan;
    expect(JSON.stringify(plan)).toBe(before);
    expect(filled.onError).toBe('abort');
    expect(filled.actions).toMatchObject([
      { command: 'add_box', params: { size: [1, 1, 1] } },
      { command: 'submit_for_review', params: { revision: 'A', ...FILLED } },
      { step: { params: FILLED } },
      { actions: [{ params: FILLED }, { actions: [{ command: 'add_box' }] }] },
    ]);
    expect(filled.actions[0]).toEqual({ command: 'add_box', params: { size: [1, 1, 1] } });
  });

  it('passes a malformed plan through', () => {
    expect(fillHostParams('build_project', { actions: 'x' }, host)).toEqual({ actions: 'x' });
    expect(fillHostParams('build_project', { actions: [3, null] }, host)).toEqual({ actions: [3, null] });
  });
});
