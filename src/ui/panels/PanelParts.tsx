/**
 * @layer ui/panels
 *
 * PanelParts — shared panel anatomy (header, section, empty state). Presentation only.
 */

import React, { useState } from 'react';
import { Icon } from '@ui/components/Icon';
import type { IconName } from '@ui/components/Icon';

export interface PanelHeaderProps {
  title: string;
  count?: number;
  countLabel?: string;
  children?: React.ReactNode;
}

export function PanelHeader({
  title,
  count,
  countLabel,
  children,
}: PanelHeaderProps): React.ReactElement {
  return (
    <header className="panel__header">
      <h2 className="panel__title">{title}</h2>
      {count !== undefined && (
        <span className="panel__count" aria-label={countLabel}>
          {count}
        </span>
      )}
      {children !== undefined && <div className="panel__actions">{children}</div>}
    </header>
  );
}

export interface PanelEmptyProps {
  icon: IconName;
  message: string;
  hint?: string;
  compact?: boolean;
}

export function PanelEmpty({ icon, message, hint, compact }: PanelEmptyProps): React.ReactElement {
  return (
    <div className={`panel__empty${compact === true ? ' panel__empty--compact' : ''}`}>
      <Icon name={icon} size={20} strokeWidth={1.5} />
      <p className="panel__empty-text">{message}</p>
      {hint !== undefined && <p className="panel__empty-hint">{hint}</p>}
    </div>
  );
}

export interface PanelSectionProps {
  title: string;
  count?: number;
  countLabel?: string;
  collapsible?: boolean;
  testId?: string;
  children: React.ReactNode;
}

export function PanelSection({
  title,
  count,
  countLabel,
  collapsible = false,
  testId,
  children,
}: PanelSectionProps): React.ReactElement {
  const [open, setOpen] = useState(true);
  const label = (
    <>
      {collapsible && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
      <span className="panel__section-title">{title}</span>
      {count !== undefined && (
        <span className="panel__count" aria-label={countLabel}>
          {count}
        </span>
      )}
    </>
  );
  return (
    <section className="panel__section" data-testid={testId}>
      {collapsible ? (
        <button
          type="button"
          className="panel__section-header panel__section-header--button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {label}
        </button>
      ) : (
        <h3 className="panel__section-header">{label}</h3>
      )}
      {open && <div className="panel__section-body">{children}</div>}
    </section>
  );
}
