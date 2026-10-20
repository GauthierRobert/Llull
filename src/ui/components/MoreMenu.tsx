// "More" menu (header, on demand): project file actions, underlay, export, theme and the properties panel toggle.
// Its content stays mounted while closed (file inputs and dialogs keep working), only hidden.

import React, { useCallback, useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { useLayoutStore } from '@ui/store';
import { useDismiss } from '@ui/hooks/useDismiss';
import { Icon } from '@ui/components/Icon';
import { ThemeToggle } from '@ui/components/ThemeToggle';
import { ProjectIO } from '@ui/components/ProjectIO';
import { ModelExport } from '@ui/components/ModelExport';
import { ImageUnderlayImport } from '@ui/components/ImageUnderlayImport';
import { ExchangeImport } from '@ui/components/ExchangeImport';

function InspectorToggle(): React.ReactElement {
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const toggleInspector = useLayoutStore((s) => s.toggleInspector);
  const label = inspectorOpen ? 'Hide properties panel' : 'Show properties panel';
  return (
    <button type="button" className="menu-item" onClick={toggleInspector} aria-label={label} aria-pressed={inspectorOpen} title={label}>
      <Icon name="panelRight" size={15} />
      Properties panel
    </button>
  );
}

export function MoreMenu(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);
  return (
    <div className="more-menu" ref={rootRef}>
      <button
        type="button"
        className={classNames('icon-btn', open && 'icon-btn--active')}
        aria-label="More"
        aria-expanded={open}
        aria-controls="more-menu-panel"
        title="File, export, theme, properties"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" size={18} />
      </button>
      <div className="more-menu__panel" id="more-menu-panel" role="group" aria-label="More actions" hidden={!open}>
        <span className="more-menu__title">File</span>
        <ProjectIO />
        <ImageUnderlayImport />
        <ExchangeImport />
        <span className="more-menu__title">Export</span>
        <ModelExport />
        <span className="more-menu__title">View</span>
        <ThemeToggle />
        <InspectorToggle />
      </div>
    </div>
  );
}
