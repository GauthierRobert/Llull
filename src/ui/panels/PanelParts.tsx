// Shared panel anatomy: header, section, empty state, buttons, rows.

import React, { useState } from 'react';
import { classNames } from '@ui/classNames';
import { type IconName, Icon } from '@ui/components/Icon';

interface PanelHeaderProps {
  title: string;
  count?: number;
  countLabel?: string;
  children?: React.ReactNode;
}

export function PanelHeader({ title, count, countLabel, children }: PanelHeaderProps): React.ReactElement {
  return (
    <div className="panel__header">
      <h2 className="panel__title">{title}</h2>
      {count !== undefined && (
        <span className="panel__count" role="img" aria-label={countLabel}>
          {count}
        </span>
      )}
      {children !== undefined && <div className="panel__actions">{children}</div>}
    </div>
  );
}

interface PanelEmptyProps {
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

interface PanelSectionProps {
  title: string;
  count?: number;
  countLabel?: string;
  collapsible?: boolean;
  /** Workflow step shown before the title (1 = first). */
  step?: number;
  /** One line under the header: what the section is for. */
  hint?: string;
  testId?: string;
  children: React.ReactNode;
}

export function PanelSection({
  title,
  count,
  countLabel,
  collapsible = false,
  step,
  hint,
  testId,
  children,
}: PanelSectionProps): React.ReactElement {
  const [open, setOpen] = useState(true);
  const label = (
    <>
      {collapsible && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />}
      {step !== undefined && (
        <span className="panel__step" aria-label={`Step ${step}:`}>
          {step}
        </span>
      )}
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
      {open && (
        <div className="panel__section-body">
          {hint !== undefined && <p className="panel__section-hint">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

interface IconButtonProps {
  icon: IconName;
  label: string;
  title?: string;
  size?: number;
  danger?: boolean;
  className?: string;
  testId?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function IconButton({
  icon,
  label,
  title,
  size = 13,
  danger = false,
  className,
  testId,
  disabled,
  pressed,
  onClick,
}: IconButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className={classNames('icon-btn', danger && 'icon-btn--danger', className)}
      data-testid={testId}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/** Nothing while `text` is empty. */
export function FormError({ text }: { text: string }): React.ReactElement | null {
  if (text === '') return null;
  return (
    <p className="panel__error" role="alert">
      {text}
    </p>
  );
}

/** Polite status (summary or validation); nothing while `text` is empty. */
export function StatusLine({ text, testId }: { text: string; testId?: string }): React.ReactElement | null {
  if (text === '') return null;
  return (
    <p className="building-summary" role="status" data-testid={testId}>
      {text}
    </p>
  );
}

interface ListRowProps {
  selected?: boolean;
  /** `aria-current`. */
  current?: boolean;
  testId?: string;
  onSelect: () => void;
  /** Defaults to the visible text. */
  label?: string;
  /** Toggle rows. */
  pressed?: boolean;
  buttonTestId?: string;
  /** Trailing row buttons. */
  actions?: React.ReactNode;
  /** Chip, `panel__row-main`, `panel__row-meta`. */
  children: React.ReactNode;
}

/** Full-width row button + optional trailing actions. */
export function ListRow({
  selected = false,
  current,
  testId,
  onSelect,
  label,
  pressed,
  buttonTestId,
  actions,
  children,
}: ListRowProps): React.ReactElement {
  return (
    <li
      className={classNames('panel__row', selected && 'panel__row--selected')}
      data-testid={testId}
      aria-current={current === true ? 'true' : undefined}
    >
      <button
        type="button"
        className="building-row-btn"
        aria-label={label}
        aria-pressed={pressed}
        data-testid={buttonTestId}
        onClick={onSelect}
      >
        {children}
      </button>
      {actions !== undefined && <span className="panel__row-actions">{actions}</span>}
    </li>
  );
}

interface DeleteButtonProps {
  /** e.g. `Delete layer Walls`; tooltip unless `title`. */
  label: string;
  title?: string;
  icon?: 'trash' | 'close';
  size?: number;
  className?: string;
  testId?: string;
  disabled?: boolean;
  onDelete: () => void;
}

/** The click never reaches the row behind it. */
export function DeleteButton({
  label,
  title,
  icon = 'trash',
  size,
  className,
  testId,
  disabled,
  onDelete,
}: DeleteButtonProps): React.ReactElement {
  return (
    <IconButton
      icon={icon}
      danger
      label={label}
      title={title ?? label}
      {...(size !== undefined ? { size } : {})}
      {...(className !== undefined ? { className } : {})}
      {...(testId !== undefined ? { testId } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      onClick={(event) => {
        event.stopPropagation();
        onDelete();
      }}
    />
  );
}
