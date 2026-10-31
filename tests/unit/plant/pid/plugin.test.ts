/** Plant 04 PID: the plugin is installed with its toolset (M2: import_dexpi and pid_report) and its document extension validates `plant.pid` only. */

import { describe, expect, it } from 'vitest';
import { pidPlugin } from '@aec/index';
import { TOOLSET_NAMES, TOOLSETS } from '@protocol/toolsets';
import { createEmptyDocument } from '@core/model/types';
import { listCommands } from '@core/commands/registry';

describe('pid plugin', () => {
  it('is the pid toolset with the M2 commands and adds no derived entity', () => {
    expect(pidPlugin).toMatchObject({ name: 'pid', toolset: 'pid' });
    expect(pidPlugin.commands.map((command) => command.name)).toEqual(['import_dexpi', 'pid_report']);
    expect(TOOLSET_NAMES).toContain('pid');
    expect([...TOOLSETS.pid].sort()).toEqual(['import_dexpi', 'pid_report']);
    expect(
      listCommands()
        .filter((command) => /pid|dexpi/.test(command.name))
        .map((command) => command.name)
        .sort(),
    ).toEqual(['import_dexpi', 'pid_report']);
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
