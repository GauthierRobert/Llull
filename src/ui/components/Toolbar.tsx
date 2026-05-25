/**
 * @layer ui/components
 *
 * Toolbar — generated from the command registry (architecture L5).
 *
 * Iterates `listCommands()` and renders one accessible <button> per entry.
 * Label = human-readable form of the snake_case command name.
 * Title / aria-label = command description (what Claude/agents see).
 *
 * On click: gathers default params (if available) and calls `dispatch`.
 * Param-gathering forms are E2; for now, zero-config commands get sensible
 * defaults; others dispatch `{}` which gracefully no-ops and the status bar
 * reports the reason.
 *
 * defaultParams: a stop-gap lookup until E2 (parameter forms) ships.
 * Keys are command names; values are ready-to-use params.
 */

import React from 'react';
import { listCommands } from '@core/commands/registry';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Default-params stop-gap (removed / replaced when E2 ships param forms)
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS: Record<string, unknown> = {
  add_box: { size: [2, 2, 2] as [number, number, number] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a snake_case command name to a human-readable button label.
 * e.g. "add_box" → "Add Box", "rotate_entity" → "Rotate Entity"
 */
function toLabel(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export interface ToolbarProps {
  /** Optional override — mainly for tests. Defaults to listCommands(). */
  commands?: ReturnType<typeof listCommands>;
}

export function Toolbar({ commands = listCommands() }: ToolbarProps): React.ReactElement {
  const dispatch = useStore((s) => s.dispatch);

  return (
    <nav className="toolbar" aria-label="CAD commands">
      {commands.map((cmd) => {
        const params = DEFAULT_PARAMS[cmd.name] ?? {};

        function handleClick(): void {
          dispatch(cmd.name, params);
        }

        return (
          <button
            key={cmd.name}
            className="toolbar-btn"
            type="button"
            title={cmd.description}
            aria-label={cmd.description}
            onClick={handleClick}
          >
            {toLabel(cmd.name)}
          </button>
        );
      })}
    </nav>
  );
}
