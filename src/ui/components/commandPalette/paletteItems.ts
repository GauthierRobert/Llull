// Palette catalog: app actions + EVERY registry command (L5), so all MCP-exposed commands are reachable from the UI.

import type { CommandDefinition } from '@core/commands/types';
import { listCommands } from '@core/commands/registry';
import { type GizmoMode, useLayoutStore, useStore, useThemeStore, useToolStore } from '@ui/store';
import type { IconName } from '@ui/components/Icon';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { createSolid } from '@ui/actions/createSolid';
import { DRAW_TOOL_KEYS, GIZMO_KEYS } from '@ui/hooks/shortcuts';
import { SOLID_PRESETS } from '@ui/components/toolbar/solidPresets';
import { DRAW_TOOLS } from '@ui/components/toolbar/drawTools';
import { SIDEBAR_TAB_SPECS, isSidebarTabAvailable } from '@ui/components/sidebarTabs';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { fuzzyScore } from './fuzzyMatch';
import { humanizeName } from './paramForm';

type PaletteGroup = 'Recent' | 'Create' | 'Draw' | 'View' | 'Edit' | 'Panels' | 'Commands';

interface PaletteItemBase {
  /** Recents key: `action:…` / `command:<name>`. */
  id: string;
  label: string;
  group: PaletteGroup;
  hint: string;
  /** Command name, synonyms. */
  keywords: string;
  icon: IconName;
  shortcut?: string;
}

interface PaletteAction extends PaletteItemBase {
  kind: 'action';
  run(): void;
}

interface PaletteCommand extends PaletteItemBase {
  kind: 'command';
  command: CommandDefinition<unknown>;
}

export type PaletteItem = PaletteAction | PaletteCommand;

type ActionRow = [
  id: string,
  group: PaletteGroup,
  label: string,
  hint: string,
  icon: IconName,
  run: () => void,
  keywords?: string,
  shortcut?: string,
];

function action(...[id, group, label, hint, icon, run, keywords = '', shortcut]: ActionRow): PaletteAction {
  return { kind: 'action', id: `action:${id}`, group, label, hint, icon, keywords, run, ...(shortcut !== undefined && { shortcut }) };
}

const tools = (): ReturnType<typeof useToolStore.getState> => useToolStore.getState();
const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState();
const store = (): ReturnType<typeof useStore.getState> => useStore.getState();
const gizmoRow = (mode: GizmoMode, verb: string, hint: string, icon: IconName, keywords: string): ActionRow => [
  `gizmo-${mode}`,
  'View',
  `${verb} gizmo`,
  hint,
  icon,
  () => tools().setGizmoMode(mode),
  keywords,
  GIZMO_KEYS[mode],
];

const STATIC_ACTIONS: ReadonlyArray<ActionRow> = [
  ['view-3d', 'View', 'Switch to 3D view', 'Perspective modeling view', 'cube', () => tools().setViewMode('3d'), '', '3'],
  ['view-2d', 'View', 'Switch to 2D view', 'Top-down drafting view', 'square', () => tools().setViewMode('2d'), '', '2'],
  gizmoRow('translate', 'Move', 'Drag selected solids along axes (3D)', 'transformMove', 'translate transform'),
  gizmoRow('rotate', 'Rotate', 'Rotate selected solids (3D)', 'transformRotate', 'transform'),
  gizmoRow('scale', 'Scale', 'Scale selected solids (3D)', 'transformScale', 'transform resize'),
  [
    'theme',
    'View',
    'Toggle light / dark theme',
    'Switch the color theme',
    'sun',
    () => useThemeStore.getState().toggleTheme(),
    'appearance mode color',
  ],
  ['undo', 'Edit', 'Undo', 'Revert the last change', 'undo', () => store().undo(), '', 'Ctrl Z'],
  ['redo', 'Edit', 'Redo', 'Re-apply the last undone change', 'redo', () => store().redo(), '', 'Ctrl Y'],
  ['duplicate', 'Edit', 'Duplicate selection', 'Copy the selected entities', 'copy', duplicateSelection, '', 'Ctrl D'],
  ['delete', 'Edit', 'Delete selection', 'Remove the selected entities', 'trash', deleteSelection, 'remove erase', 'Del'],
  ['clear-selection', 'Edit', 'Clear selection', 'Deselect everything', 'cursor', () => store().clearSelection(), 'deselect', 'Esc'],
  [
    'toggle-sidebar',
    'Panels',
    'Toggle document browser',
    'Show or hide the left panel',
    'panelLeft',
    () => layout().toggleSidebar(),
    'sidebar',
  ],
  [
    'toggle-inspector',
    'Panels',
    'Toggle properties inspector',
    'Show or hide the right panel',
    'panelRight',
    () => layout().toggleInspector(),
    'properties',
  ],
];

function appActions(): PaletteAction[] {
  return [
    ...SOLID_PRESETS.map((preset) =>
      action(
        `solid-${preset.command}`,
        'Create',
        `Add ${preset.label.toLowerCase()}`,
        'One click: default size, placed in view and selected',
        preset.icon,
        () => createSolid(preset),
        `${preset.command} solid 3d primitive`,
      ),
    ),
    ...DRAW_TOOLS.map((spec) =>
      action(
        `draw-${spec.tool}`,
        'Draw',
        `Draw ${spec.label.toLowerCase()}`,
        `2D tool: ${spec.tip}`,
        spec.icon,
        () => tools().setDrawTool(spec.tool),
        'sketch 2d tool',
        DRAW_TOOL_KEYS[spec.tool],
      ),
    ),
    ...STATIC_ACTIONS.map((row) => action(...row)),
    ...SIDEBAR_TAB_SPECS.filter((spec) => isSidebarTabAvailable(spec.tab, useReviewStore.getState().result !== null)).map((spec) =>
      action(`panel-${spec.tab}`, 'Panels', `Open ${spec.label}`, `Show the ${spec.label} panel`, spec.icon, () => {
        if (!(layout().sidebarOpen && layout().sidebarTab === spec.tab)) layout().selectSidebarTab(spec.tab);
      }),
    ),
    action(
      'shortcuts',
      'Panels',
      'Keyboard shortcuts',
      'Show every shortcut',
      'keyboard',
      () => tools().setShortcutsOpen(true),
      'help keys',
      '?',
    ),
  ];
}

/** Commands needing input get "…" (they open a form). */
function commandItem(command: CommandDefinition<unknown>): PaletteCommand {
  const needsInput = Object.keys(command.paramsSchema.properties).length > 0;
  return {
    kind: 'command',
    id: `command:${command.name}`,
    group: 'Commands',
    label: `${humanizeName(command.name)}${needsInput ? '…' : ''}`,
    hint: command.description,
    keywords: `${command.name} ${command.annotations?.readOnly === true ? 'query inspect ' : ''}${command.description}`,
    icon: command.annotations?.readOnly === true ? 'info' : 'zap',
    command,
  };
}

/** App actions first, then registry order. */
export function allPaletteItems(): PaletteItem[] {
  return [...appActions(), ...listCommands().map(commandItem)];
}

/** Empty query: recents (group 'Recent') then catalog order; else best score first, ties in catalog order. */
export function searchPaletteItems(items: readonly PaletteItem[], query: string, recentIds: readonly string[]): PaletteItem[] {
  if (query.trim() === '') {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((item): item is PaletteItem => item !== undefined)
      .map((item): PaletteItem => ({ ...item, group: 'Recent' }));
    const recentSet = new Set(recent.map((item) => item.id));
    return [...recent, ...items.filter((item) => !recentSet.has(item.id))];
  }
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, item.label, item.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
