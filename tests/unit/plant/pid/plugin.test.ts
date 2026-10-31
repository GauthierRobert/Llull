/** Plant 04 PID: the plugin is installed with its toolset (M2 to M5) and its document extension validates `plant.pid` only. */

import { describe, expect, it } from 'vitest';
import { pidPlugin } from '@aec/index';
import { TOOLSET_NAMES, TOOLSETS } from '@protocol/toolsets';
import { createEmptyDocument } from '@core/model/types';
import { listCommands } from '@core/commands/registry';

const PID_COMMANDS = [
  'import_dexpi',
  'export_dexpi',
  'list_pid_symbols',
  'export_pid_svg',
  'pid_report',
  'check_pid',
  'parse_instrument_tag',
  'create_pid_sheet',
  'add_pid_equipment',
  'add_pid_nozzle',
  'add_pid_line',
  'add_pid_inline',
  'add_pid_instrument',
  'add_pid_signal_line',
  'add_pid_actuating_system',
  'add_pid_off_page_connector',
  'update_pid_item',
  'delete_pid_item',
  'reverse_pid_flow',
  'renumber_pid_lines',
  'set_pid_conventions',
];

describe('pid plugin', () => {
  it('is the pid toolset with the M2 to M5 commands and adds no derived entity', () => {
    expect(pidPlugin).toMatchObject({ name: 'pid', toolset: 'pid' });
    expect(pidPlugin.commands.map((command) => command.name)).toEqual(PID_COMMANDS);
    expect(TOOLSET_NAMES).toContain('pid');
    expect([...TOOLSETS.pid].sort()).toEqual([...PID_COMMANDS].sort());
    expect(
      listCommands()
        .filter((command) => /pid|dexpi|instrument_tag/.test(command.name))
        .map((command) => command.name)
        .sort(),
    ).toEqual([...PID_COMMANDS].sort());
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
