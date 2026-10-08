import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const box = { command: 'add_box', params: { size: [1, 1, 1] } };

describe('build_project completion summary counts plan steps, not expanded commands', () => {
  it('plain plan: N/N with no expansion note', () => {
    const result = execute(createEmptyDocument(), 'build_project', { actions: [box, box] });
    expect(result.summary).toContain('Plan complete: 2/2 plan step(s) ok,');
    expect(result.summary).not.toContain('commands executed');
  });

  it('repeat plan: plan steps stay N/N and the executed command count is reported separately', () => {
    const result = execute(createEmptyDocument(), 'build_project', {
      actions: [box, { repeat: { count: 50 }, step: box }, box, box],
    });
    expect(result.summary).toContain('Plan complete: 4/4 plan step(s) ok (53 commands executed)');
  });

  it('a failing step inside a repeat counts once against its plan step (onError continue)', () => {
    const result = execute(createEmptyDocument(), 'build_project', {
      onError: 'continue',
      actions: [
        box,
        { repeat: { count: 3 }, step: { command: 'add_box', params: { size: [0, 0, 0] } } },
      ],
    });
    expect(result.summary).toContain('Plan complete: 1/2 plan step(s) ok (4 commands executed)');
  });
});
