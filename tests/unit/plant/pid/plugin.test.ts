/** Plant 04 PID M1: the plugin skeleton is installed with its toolset (no command yet) and its document extension validates `plant.pid` only. */

import { describe, expect, it } from 'vitest';
import { pidPlugin } from '@aec/index';
import { TOOLSET_NAMES, TOOLSETS } from '@protocol/toolsets';
import { createEmptyDocument } from '@core/model/types';
import { listCommands } from '@core/commands/registry';

describe('pid plugin', () => {
  it('is the pid toolset, registers no command in M1 and adds no derived entity', () => {
    expect(pidPlugin).toMatchObject({ name: 'pid', toolset: 'pid', commands: [] });
    expect(TOOLSET_NAMES).toContain('pid');
    expect(TOOLSETS.pid).toEqual([]);
    expect(listCommands().filter((command) => /pid/.test(command.name))).toEqual([]);
    expect(pidPlugin.document?.derivedEntityIds(createEmptyDocument())).toEqual(new Set());
  });

  it('validates the raw plant slice: nothing for other slices, errors for a bad pid slice', () => {
    const validate = pidPlugin.document?.validate;
    expect(validate?.({})).toEqual([]);
    expect(validate?.({ plant: 3 })).toEqual([]);
    expect(validate?.({ plant: { piping: {} } })).toEqual([]);
    expect(validate?.({ plant: { pid: 3 } })).toEqual(['plant.pid must be an object']);
    expect(pidPlugin.document?.restore?.({ a: 1 })).toEqual({ a: 1 });
  });
});
