// Small "start here" card while the document is empty: let an agent build it, or one of a few one-click starts.
// Dismissal is local state.

import React, { useState } from 'react';
import { useLayoutStore, useStore, useToolStore } from '@ui/store';
import { PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { Icon, type IconName } from '@ui/components/Icon';
import { IconButton } from '@ui/panels/PanelParts';
import { SOLID_PRESETS } from '@ui/components/toolbar/solidPresets';
import { createSolid } from '@ui/actions/createSolid';
import { startCivilSite } from '@ui/actions/civilStarter';

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
        <p className="empty-state__subheading">
          <strong>Let AI build it:</strong> use <em>Connect agent</em> and describe the part to Claude. Or start by hand:
        </p>

        <div className="empty-state__starts">
          {boxPreset !== undefined && (
            <StartChip icon="cube" label="Add a 3D box" caption="3D box" onClick={() => createSolid(boxPreset)} />
          )}
          <StartChip icon="drawRectangle" label="Draw a 2D rectangle" caption="2D sketch" onClick={() => setDrawTool('rectangle')} />
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

        <p className="empty-state__foot">
          <kbd className="kbd">{PALETTE_SHORTCUT_LABEL}</kbd> runs any command · <kbd className="kbd">?</kbd> shortcuts
        </p>
      </div>
    </div>
  );
}
