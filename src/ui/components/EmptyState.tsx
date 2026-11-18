// "Start here" card while the document is empty: the two ways to begin by hand (sketch a profile, or drop a solid) as large cards,
// ready-made templates, how to move around the view, and the agent route. Dismissal is local state.

import React, { useState } from 'react';
import { useLayoutStore, usePaletteStore, useStore, useToolStore } from '@ui/store';
import { PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { Icon, type IconName } from '@ui/components/Icon';
import { IconButton } from '@ui/panels/PanelParts';
import { SOLID_PRESETS } from '@ui/components/toolbar/solidPresets';
import { createSolid } from '@ui/actions/createSolid';
import { startCivilSite } from '@ui/actions/civilStarter';

interface StartCardProps {
  icon: IconName;
  /** Accessible name (what the start does). */
  label: string;
  title: string;
  text: string;
  onClick: () => void;
}

/** One of the main ways to begin: a title and one line saying what happens next. */
function StartCard({ icon, label, title, text, onClick }: StartCardProps): React.ReactElement {
  return (
    <button type="button" className="empty-state__card-btn" aria-label={label} onClick={onClick}>
      <span className="empty-state__card-icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="empty-state__card-text">
        <span className="empty-state__card-title">{title}</span>
        <span className="empty-state__card-sub">{text}</span>
      </span>
    </button>
  );
}

interface StartChipProps {
  icon: IconName;
  /** Accessible name (what the start does). */
  label: string;
  caption: string;
  busy?: boolean;
  onClick: () => void;
}

function StartChip({ icon, label, caption, busy = false, onClick }: StartChipProps): React.ReactElement {
  return (
    <button
      type="button"
      className="empty-state__start"
      aria-label={label}
      title={label}
      disabled={busy}
      aria-busy={busy}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
      {caption}
    </button>
  );
}

const NAVIGATION: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: 'Drag', action: 'orbit' },
  { keys: 'Right-drag', action: 'pan' },
  { keys: 'Scroll', action: 'zoom' },
  { keys: 'F', action: 'fit' },
];

export function EmptyState(): React.ReactElement | null {
  const entityCount = useStore((s) => s.document.order.length);
  const dispatch = useStore((s) => s.dispatch);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const drawToolArmed = useToolStore((s) => s.drawTool !== 'none');
  const [dismissed, setDismissed] = useState(false);
  const [civilLoading, setCivilLoading] = useState(false);

  // Never covers the drawing area while a 2D tool is armed.
  if (entityCount > 0 || dismissed || drawToolArmed) return null;

  const showBuildingTab = (): void => {
    const { sidebarTab, sidebarOpen, selectSidebarTab } = useLayoutStore.getState();
    if (sidebarTab !== 'building' || !sidebarOpen) selectSidebarTab('building');
  };
  const boxPreset = SOLID_PRESETS[0];
  const startCivil = (): void => {
    const { sidebarTab, sidebarOpen, selectSidebarTab } = useLayoutStore.getState();
    if (sidebarTab !== 'civil' || !sidebarOpen) selectSidebarTab('civil');
    setCivilLoading(true);
    void startCivilSite().finally(() => setCivilLoading(false));
  };

  return (
    <div className="empty-state" role="region" aria-label="Get started">
      <div className="empty-state__card">
        <IconButton
          icon="close"
          size={14}
          className="empty-state__dismiss"
          label="Dismiss hint"
          title="Dismiss"
          onClick={() => setDismissed(true)}
        />

        <h2 className="empty-state__heading">Start your model</h2>
        <p className="empty-state__subheading">Pick a way to begin. Everything here is also in the bar at the bottom.</p>

        <div className="empty-state__cards">
          <StartCard
            icon="pencil"
            label="Draw a 2D rectangle"
            title="Sketch a shape"
            text="Draw a profile in 2D, then extrude it into a solid."
            onClick={() => setDrawTool('rectangle')}
          />
          {boxPreset !== undefined && (
            <StartCard
              icon="cube"
              label="Add a 3D box"
              title="Drop a solid"
              text="Start from a box and move, resize, round or cut it."
              onClick={() => createSolid(boxPreset)}
            />
          )}
          <StartCard
            icon="search"
            label="Search every command"
            title="Find a command"
            text={`Type what you want to do (${PALETTE_SHORTCUT_LABEL}).`}
            onClick={() => usePaletteStore.getState().setOpen(true)}
          />
        </div>

        <div className="empty-state__row">
          <span className="empty-state__row-label">Templates</span>
          <div className="empty-state__starts">
            <StartChip
              icon="building"
              label="Start a steel structure"
              caption="Steel structure"
              onClick={() => {
                showBuildingTab();
                setDismissed(true);
              }}
            />
            <StartChip
              icon="building"
              label="Portal-frame hall template"
              caption="Portal-frame hall"
              onClick={() => {
                showBuildingTab();
                dispatch('add_portal_frame_building', {});
              }}
            />
            <StartChip
              icon="terrain"
              label={civilLoading ? 'Civil site starter — loading the sample survey…' : 'Civil site starter'}
              caption={civilLoading ? 'Loading survey…' : 'Civil site'}
              busy={civilLoading}
              onClick={startCivil}
            />
          </div>
        </div>

        <p className="empty-state__agent">
          <Icon name="sparkle" size={15} />
          <span>
            <strong>Let AI build it:</strong> ask Claude Code to model the part with <code>llull --app</code> and watch it appear here.
          </span>
        </p>

        <ul className="empty-state__nav" aria-label="Moving around the view">
          <li className="empty-state__nav-icon" aria-hidden="true">
            <Icon name="mouse" size={14} />
          </li>
          {NAVIGATION.map(({ keys, action }) => (
            <li key={keys}>
              <kbd className="kbd">{keys}</kbd> {action}
            </li>
          ))}
          <li>
            <kbd className="kbd">?</kbd> all shortcuts
          </li>
        </ul>
      </div>
    </div>
  );
}
