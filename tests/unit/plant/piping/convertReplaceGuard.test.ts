/**
 * `convert_pipe_run` with `replace: true` refuses the whole conversion when the nested `delete_building_element` is rejected. Isolated suite: it installs a
 * test plugin whose guard refuses only that command (the outer convert is not touched by the guard).
 */

import { describe, expect, it } from 'vitest';
import { installPlugin } from '@core/plugins/host';
import { execute } from '@core/commands/registry';
import { cs150Document } from './rteFixtures';

installPlugin({
  name: 'test-no-building-delete',
  toolset: 'test',
  commands: [],
  guards: [
    {
      domain: 'test-no-building-delete',
      check: (_previous, _next, command) => (command === 'delete_building_element' ? 'test guard: building deletion is locked' : null),
    },
  ],
});

describe('convert_pipe_run replace', () => {
  const created = execute(cs150Document(), 'add_pipe_run', {
    points: [
      [0, 0, 0],
      [3000, 0, 0],
    ],
    dn: 100,
    line: 'L-9',
  });
  const pipeId = created.affected[0] as string;

  it('keeps working without replace (the guard only refuses the deletion)', () => {
    expect(execute(created.document, 'convert_pipe_run', { pipeId, spec: 'CS150' }).rejected).toBeUndefined();
  });

  it('is refused whole with the inner reason when the legacy pipe cannot be deleted: document unchanged', () => {
    const result = execute(created.document, 'convert_pipe_run', { pipeId, spec: 'CS150', replace: true });
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(created.document);
    expect(result.summary).toContain('could not be replaced');
    expect(result.summary).toContain('building deletion is locked');
    expect(result.error?.paths).toEqual(['replace']);
  });
});
